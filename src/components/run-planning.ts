import { z } from "zod";
import { validateAssetManifestV1, type ManifestValidationErrorCode, type NormalizedAssetManifestV1 } from "@/core/manifest";
import type { ExecutionPlanV1 } from "@/core/execution-plan";
import {
  parsePublicPlanningRecordResponse,
  parsePublicRunMutationResponse,
  publicRunIdSchema,
  type PublicRunProjection,
} from "@/shared/run";

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

export type PlanningView = {
  run: PublicRunProjection & { readonly canCancel: boolean };
  manifest: NormalizedAssetManifestV1;
  plan: ExecutionPlanV1;
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
  INVALID_ROUTE: "This run link is invalid or unavailable.",
} as const;
type ErrorCode = keyof typeof messages;
export type PlanningIssue = { code: ManifestValidationErrorCode; path: string };
const issuesSchema = z.array(z.object({
  code: z.enum(["EMAILS_MUST_DIFFER", "INVALID_ASSET_NAME", "INVALID_CHAIN_ID", "INVALID_DOCUMENTATION_URL", "INVALID_ENVIRONMENT", "INVALID_FIELD_TYPE", "INVALID_INVESTOR_EMAIL", "INVALID_POSITIVE_INTEGER", "INVALID_ROOT", "INVALID_SCHEMA_VERSION", "INVALID_TOKENIZER_EMAIL", "INVALID_TOKEN_SYMBOL", "INVALID_TOKEN_TYPE", "INVALID_WALLET_ADDRESS", "MINT_EXCEEDS_SUPPLY", "REQUIRED_FIELD", "UNKNOWN_FIELD"]),
  path: z.enum(["asset.name", "asset.symbol", "asset.supplyCap", "asset.documentationUrl", "tokenizer.email", "tokenizer.walletAddress", "investor.email", "investor.walletAddress", "investor.mintAmount"]),
})).max(30);
class PlanningError extends Error {
  constructor(readonly code: ErrorCode, readonly issues: readonly PlanningIssue[] = []) { super(messages[code]); }
}

function planningRun(run: PublicRunProjection): PlanningView["run"] {
  return Object.freeze({
    ...run,
    canCancel: run.terminalOutcome === null && run.status !== "RECONCILIATION_REQUIRED"
      && run.operations.every((operation) => operation.blockchainTxHash === null),
  });
}

// Accept only the strict public DTO. Browser parsing validates transport shape;
// the server remains authoritative for manifest normalization, plan derivation, and hashes.
export function readProjection(
  body: unknown,
  previous?: PlanningView,
  cancellation = false,
  expectedRunId?: string,
): PlanningView {
  try {
    const parsed = cancellation
      ? (() => {
          if (!previous) throw new Error("INVALID_RESPONSE");
          return {
            run: parsePublicRunMutationResponse(body),
            manifest: previous.manifest,
            plan: previous.plan,
          };
        })()
      : parsePublicPlanningRecordResponse(body);
    const run = planningRun(parsed.run);
    const manifest = parsed.manifest;
    const plan = parsed.plan;
    if (
      (expectedRunId !== undefined && run.id !== expectedRunId) ||
      plan.manifestHash !== run.manifestHash ||
      plan.planHash !== run.planHash ||
      plan.environment !== run.environment ||
      plan.chainId !== run.chainId ||
      plan.requiredSigner.walletAddress !== run.requiredSigner.walletAddress ||
      manifest.environment !== run.environment ||
      manifest.chainId !== run.chainId ||
      manifest.tokenizer.walletAddress !== run.requiredSigner.walletAddress ||
      (previous && (
        run.id !== previous.run.id ||
        run.revision < previous.run.revision ||
        run.planHash !== previous.run.planHash ||
        run.manifestHash !== previous.run.manifestHash
      )) ||
      (cancellation && run.terminalOutcome !== "CANCELLED")
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    return Object.freeze({ run, manifest, plan });
  } catch {
    throw new PlanningError("INVALID_RESPONSE");
  }
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
    const issues = issuesSchema.safeParse((json as { error?: { issues?: unknown } })?.error?.issues);
    throw new PlanningError(parsed.success ? parsed.data.error.code : "INVALID_RESPONSE",
      parsed.success && parsed.data.error.code === "BAD_REQUEST" && issues.success ? issues.data : []);
  }
  return json;
}

export type WorkspaceState = {
  view: PlanningView | null;
  pending: "create" | "recover" | "refresh" | "cancel" | null;
  error: string | null;
  notice: string | null;
  unavailable: boolean;
  issues: readonly PlanningIssue[];
  errorCode: ErrorCode | null;
  retrievedAt: string | null;
};
export const initialWorkspace: WorkspaceState = { view: null, pending: null, error: null, notice: null, unavailable: false, issues: [], errorCode: null, retrievedAt: null };

// One active run and one in-flight action; the synchronous guard also catches clicks before React renders.
export function createPlanningWorkspace(
  publish: (state: WorkspaceState) => void,
  transport: Transport = (path, options) => fetch(path, options),
  options: { readonly onCreated?: (runId: string) => void } = {},
) {
  let state = initialWorkspace;
  let recoveryGeneration = 0;
  let activeRecoveryId: string | null = null;
  const update = (patch: Partial<WorkspaceState>) => { state = { ...state, ...patch }; publish(state); };
  const runPath = (view: PlanningView) => `/api/runs/${view.run.id}`;
  async function act(action: NonNullable<WorkspaceState["pending"]>, form?: Pick<FormData, "get">) {
    if (state.pending || state.unavailable || (action === "create" ? state.view !== null : state.view === null)) return;
    if (action === "cancel" && !state.view?.run.canCancel) return;
    update({ pending: action, error: null, notice: null, issues: [], errorCode: null });
    const previous = state.view;
    try {
      if (action === "create" && form) {
        const body = creationRequest(form);
        const validation = validateAssetManifestV1(body.manifest);
        if (!validation.ok) {
          update({ error: validation.errors.map((issue) => issue.message).filter((message, index, all) => all.indexOf(message) === index).join(" "), issues: validation.errors, errorCode: "BAD_REQUEST" });
          return;
        }
        const view = readProjection(await request(transport, "/api/runs", body));
        update({ view, notice: null });
        try { options.onCreated?.(view.run.id); } catch { /* A confirmed run remains valid if client navigation fails. */ }
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
      if (state.view) update({ retrievedAt: new Date().toISOString() });
    } catch (error) {
      const owned = error instanceof PlanningError ? error : new PlanningError("INVALID_RESPONSE");
      update({ error: owned.message, errorCode: owned.code, issues: owned.issues, unavailable: owned.code === "API_DISABLED" });
    } finally { update({ pending: null }); }
  }

  async function recover(runId: string): Promise<void> {
    if (!publicRunIdSchema.safeParse(runId).success) {
      recoveryGeneration += 1;
      activeRecoveryId = null;
      update({ view: null, pending: null, error: messages.INVALID_ROUTE, errorCode: "INVALID_ROUTE", notice: null, issues: [], unavailable: false, retrievedAt: null });
      return;
    }
    if (state.pending !== null && !(state.pending === "recover" && activeRecoveryId !== runId)) return;
    if (state.pending === "recover" && activeRecoveryId === runId) return;
    const generation = ++recoveryGeneration;
    activeRecoveryId = runId;
    update({ view: null, pending: "recover", error: null, errorCode: null, notice: null, issues: [], unavailable: false, retrievedAt: null });
    try {
      const view = readProjection(
        await request(transport, `/api/runs/${runId}`),
        undefined,
        false,
        runId,
      );
      if (generation !== recoveryGeneration) return;
      update({ view, retrievedAt: new Date().toISOString() });
    } catch (error) {
      if (generation !== recoveryGeneration) return;
      const owned = error instanceof PlanningError ? error : new PlanningError("INVALID_RESPONSE");
      update({ error: owned.message, errorCode: owned.code, issues: owned.issues, unavailable: owned.code === "API_DISABLED" });
    } finally {
      if (generation === recoveryGeneration) {
        activeRecoveryId = null;
        update({ pending: null });
      }
    }
  }

  return {
    create: (form: Pick<FormData, "get">) => act("create", form),
    recover,
    refresh: () => act("refresh"),
    cancel: () => act("cancel"),
  };
}
