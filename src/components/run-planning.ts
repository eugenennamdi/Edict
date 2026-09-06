import { z } from "zod";
import { validateAssetManifestV1, type NormalizedAssetManifestV1 } from "@/core/manifest";
import type { ExecutionPlanV1 } from "@/core/execution-plan";

export function creationRequest(form: Pick<FormData, "get">) {
  const text = (name: string) => String(form.get(name) ?? "");
  return { manifest: {
    schemaVersion: "1.0", environment: "sandbox", chainId: "11155111",
    tokenizer: { email: text("tokenizerEmail"), walletAddress: text("tokenizerWallet") },
    asset: { name: text("assetName"), symbol: text("symbol"), tokenType: "RWA_TOKEN",
      supplyCap: text("supplyCap"), documentationUrl: text("documentationUrl") },
    investor: { email: text("investorEmail"), walletAddress: text("investorWallet"), mintAmount: text("mintAmount") },
  } };
}

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const signer = z.object({ role: z.literal("tokenizer"), walletAddress: z.string().regex(/^0x[0-9a-f]{40}$/) });
const runSchema = z.object({
  id: z.uuid(), environment: z.literal("sandbox"), chainId: z.literal("11155111"),
  requiredSigner: signer, manifestHash: digest, planHash: digest,
  phase: z.enum(["PLAN", "TOKENIZATION", "WHITELIST", "MINT", "VERIFICATION"]),
  status: z.enum(["AWAITING_APPROVAL", "PREPARING", "AWAITING_WALLET", "BROADCAST_RECORDED", "CONFIRMING", "SUCCEEDED", "TIMED_OUT", "FAILED", "RECONCILIATION_REQUIRED"]),
  terminalOutcome: z.enum(["FAILED", "VERIFICATION_FAILED", "CANCELLED"]).nullable(),
  approved: z.boolean(), revision: z.number().int().positive(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  operations: z.array(z.object({ blockchainTxHash: z.string().nullable() })).length(3),
}).transform(({ operations, ...run }) => ({
  ...run,
  canCancel: run.terminalOutcome === null && run.status !== "RECONCILIATION_REQUIRED"
    && operations.every((operation) => operation.blockchainTxHash === null),
}));

type PlanOperation = Pick<ExecutionPlanV1["operations"][number], "id" | "sequence" | "kind" | "mode" | "summary">;
const operationSchema = z.object({
  id: z.enum(["tokenize", "confirm-tokenization", "whitelist-investor", "confirm-whitelist", "mint", "confirm-mint", "verify-deployment"]),
  sequence: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]),
  kind: z.enum(["TOKENIZE", "CONFIRM_TOKENIZATION", "WHITELIST_INVESTOR", "CONFIRM_WHITELIST", "MINT", "CONFIRM_MINT", "VERIFY_DEPLOYMENT"]),
  mode: z.enum(["WALLET_TRANSACTION", "CONFIRM_AND_READ", "FINAL_VERIFICATION"]),
  summary: z.string().min(1).max(2000),
}) satisfies z.ZodType<PlanOperation>;
const planSchema = z.object({
  planVersion: z.literal("1.0"), environment: z.literal("sandbox"), chainId: z.literal("11155111"),
  manifestHash: digest, planHash: digest, requiredSigner: signer,
  operations: z.array(operationSchema).length(7).refine((operations) => operations.every((op, index) => op.sequence === index + 1)),
});
export type PlanningView = {
  run: z.output<typeof runSchema>;
  manifest: NormalizedAssetManifestV1;
  plan: z.output<typeof planSchema>;
};

const messages = {
  API_DISABLED: "Run creation is not enabled in this environment.",
  BAD_REQUEST: "Check the mandate details and try again.",
  FORBIDDEN: "This browser no longer has access to this run. Run access may have expired.",
  NOT_FOUND: "This run is unavailable.",
  REVISION_CONFLICT: "The run changed. Refresh it before taking another action.",
  STATE_CONFLICT: "The run no longer allows this action. Refresh its current state.",
  SERVICE_UNAVAILABLE: "Edict is temporarily unavailable. Your displayed run has not been updated.",
  INVALID_RESPONSE: "Edict could not read the response. No result has been confirmed.",
  NETWORK_ERROR: "Edict could not confirm the request. Check your connection. If a run is displayed, refresh it before trying again.",
} as const;
type ErrorCode = keyof typeof messages;
class PlanningError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); }
}

// Pick only public presentation fields. Neither internal data nor unknown error text reaches the view.
export function readProjection(body: unknown, previous?: PlanningView, cancellation = false): PlanningView {
  const envelope = z.object({ ok: z.literal(true), run: runSchema, plan: z.unknown().optional(), manifest: z.unknown().optional() }).safeParse(body);
  if (!envelope.success) throw new PlanningError("INVALID_RESPONSE");
  const run = envelope.data.run;
  const parsedPlan = planSchema.safeParse(cancellation ? previous?.plan : envelope.data.plan);
  const manifest = previous?.manifest ?? (() => {
    const result = validateAssetManifestV1(envelope.data.manifest);
    if (!result.ok) throw new PlanningError("INVALID_RESPONSE");
    return result.value;
  })();
  if (!parsedPlan.success) throw new PlanningError("INVALID_RESPONSE");
  const plan = parsedPlan.data;
  if (plan.manifestHash !== run.manifestHash || plan.planHash !== run.planHash
    || plan.requiredSigner.walletAddress !== run.requiredSigner.walletAddress
    || manifest.tokenizer.walletAddress !== run.requiredSigner.walletAddress
    || (previous && (run.id !== previous.run.id || run.revision < previous.run.revision
      || run.planHash !== previous.run.planHash || run.manifestHash !== previous.run.manifestHash))
    || (cancellation && run.terminalOutcome !== "CANCELLED")) throw new PlanningError("INVALID_RESPONSE");
  return { run, manifest, plan };
}

type Transport = (path: string, options: RequestInit) => Promise<Response>;
async function request(transport: Transport, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new PlanningError("NETWORK_ERROR"); }
  let json: unknown;
  try {
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error();
    json = await response.json();
  } catch { throw new PlanningError("INVALID_RESPONSE"); }
  if (!response.ok) {
    const parsed = z.object({ ok: z.literal(false), error: z.object({ code: z.enum([
      "API_DISABLED", "BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "REVISION_CONFLICT", "STATE_CONFLICT", "SERVICE_UNAVAILABLE",
    ]) }) }).safeParse(json);
    throw new PlanningError(parsed.success ? parsed.data.error.code : "INVALID_RESPONSE");
  }
  return json;
}

export type WorkspaceState = {
  view: PlanningView | null;
  pending: "create" | "refresh" | "cancel" | null;
  error: string | null;
  notice: string | null;
  unavailable: boolean;
};
export const initialWorkspace: WorkspaceState = { view: null, pending: null, error: null, notice: null, unavailable: false };

// One active run and one in-flight action; the synchronous guard also catches clicks before React renders.
export function createPlanningWorkspace(publish: (state: WorkspaceState) => void, transport: Transport = (path, options) => fetch(path, options)) {
  let state = initialWorkspace;
  const update = (patch: Partial<WorkspaceState>) => { state = { ...state, ...patch }; publish(state); };
  const runPath = (view: PlanningView) => `/api/runs/${view.run.id}`;
  async function act(action: NonNullable<WorkspaceState["pending"]>, form?: Pick<FormData, "get">) {
    if (state.pending || state.unavailable || (action === "create" ? state.view !== null : state.view === null)) return;
    if (action === "cancel" && !state.view?.run.canCancel) return;
    update({ pending: action, error: null, notice: null });
    const previous = state.view;
    try {
      if (action === "create" && form) {
        const body = creationRequest(form);
        const validation = validateAssetManifestV1(body.manifest);
        if (!validation.ok) {
          update({ error: validation.errors.map((issue) => issue.message).filter((message, index, all) => all.indexOf(message) === index).join(" ") });
          return;
        }
        update({ view: readProjection(await request(transport, "/api/runs", body)), notice: "Run created. Review the normalized mandate and plan." });
      } else if (previous) {
        if (action === "refresh") {
          update({ view: readProjection(await request(transport, runPath(previous)), previous), notice: "Run refreshed from the server." });
        } else {
          try {
            const body = await request(transport, `${runPath(previous)}/cancel`, { expectedRevision: previous.run.revision });
            update({ view: readProjection(body, previous, true), notice: "Run canceled." });
          } catch (error) {
            if (!(error instanceof PlanningError) || !["REVISION_CONFLICT", "STATE_CONFLICT"].includes(error.code)) throw error;
            update({ view: readProjection(await request(transport, runPath(previous)), previous), notice: "The run changed. Its latest state is now shown. Review it before taking another action." });
          }
        }
      }
    } catch (error) {
      const owned = error instanceof PlanningError ? error : new PlanningError("INVALID_RESPONSE");
      update({ error: owned.message, unavailable: owned.code === "API_DISABLED" });
    } finally { update({ pending: null }); }
  }
  return { create: (form: Pick<FormData, "get">) => act("create", form), refresh: () => act("refresh"), cancel: () => act("cancel") };
}
