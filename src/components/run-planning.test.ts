import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { validateAssetManifestV1 } from "@/core/manifest";
import { buildExecutionPlanV1 } from "@/core/execution-plan";
import { createValidRawManifest, GOLDEN_MANIFEST_HASH, GOLDEN_PLAN_HASH } from "@/core/test-fixtures";
import { creationRequest, createPlanningWorkspace, initialWorkspace, readProjection, type WorkspaceState } from "./run-planning";

const id = "11111111-1111-4111-8111-111111111111";
function form() {
  const raw = createValidRawManifest();
  const values = { assetName: raw.asset.name, symbol: raw.asset.symbol, supplyCap: raw.asset.supplyCap,
    documentationUrl: raw.asset.documentationUrl, tokenizerEmail: raw.tokenizer.email,
    tokenizerWallet: raw.tokenizer.walletAddress, investorEmail: raw.investor.email,
    investorWallet: raw.investor.walletAddress, mintAmount: raw.investor.mintAmount };
  const data = new FormData();
  Object.entries(values).forEach(([key, value]) => data.set(key, value));
  return data;
}
async function projection() {
  const validated = validateAssetManifestV1(createValidRawManifest());
  if (!validated.ok) throw new Error("Invalid fixture");
  const manifest = validated.value;
  const plan = await buildExecutionPlanV1(manifest);
  return { ok: true, manifest, plan, run: {
    id, schemaVersion: "2.0", manifestHash: plan.manifestHash, planHash: plan.planHash,
    environment: plan.environment, chainId: plan.chainId, requiredSigner: plan.requiredSigner,
    phase: "PLAN", status: "AWAITING_APPROVAL", terminalOutcome: null, approved: false,
    operations: ["TOKENIZE", "WHITELIST", "MINT"].map((kind) => ({ id: kind, kind, stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false })),
    receiptEligible: false, createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z", revision: 1,
  } };
}
function harness(transport = vi.fn<(path: string, options: RequestInit) => Promise<Response>>()) {
  let state: WorkspaceState = initialWorkspace;
  const workspace = createPlanningWorkspace((next) => { state = next; }, transport);
  return { workspace, transport, state: () => state };
}
const failure = (code: string, status = 400) => Response.json({ ok: false, error: { code, message: "INTERNAL_SENTINEL" } }, { status });
afterEach(() => { vi.unstubAllGlobals(); });

describe("run planning workspace", () => {
  it("constructs exactly the accepted manifest request, ignoring supplied identities and hashes", () => {
    const input = form();
    ["id", "runId", "manifestHash", "planHash", "txId", "semanticAuthorization"].forEach((key) => input.set(key, "ignored"));
    expect(creationRequest(input)).toEqual({ manifest: createValidRawManifest() });
    expect(validateAssetManifestV1(creationRequest(input).manifest).ok).toBe(true);
  });

  it("uses only the server public projection and unchanged golden hashes", async () => {
    const body = await projection();
    const view = readProjection({ ...body, capability: "INTERNAL_SENTINEL", challengeToken: "INTERNAL_SENTINEL",
      run: { ...body.run, events: ["INTERNAL_SENTINEL"], approval: { publicSignature: "INTERNAL_SENTINEL" }, snapshot: "INTERNAL_SENTINEL" },
      plan: { ...body.plan, internal: "INTERNAL_SENTINEL" } });
    expect(view.manifest.asset.name).toBe("Café Receivables");
    expect(view.plan.operations.map((op) => op.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(view.run.manifestHash).toBe(GOLDEN_MANIFEST_HASH);
    expect(view.run.planHash).toBe(GOLDEN_PLAN_HASH);
    expect(view.run.canCancel).toBe(true);
    expect(JSON.stringify(view)).not.toContain("INTERNAL_SENTINEL");
    expect(view.run).not.toHaveProperty("operations");
  });

  it("suppresses duplicate create submissions and sends only a same-origin JSON request", async () => {
    const body = await projection();
    let resolve!: (response: Response) => void;
    const h = harness();
    h.transport.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = h.workspace.create(form());
    await h.workspace.create(form());
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.state().view).toBeNull();
    expect(h.state().pending).toBe("create");
    expect(h.transport.mock.calls[0]).toEqual(["/api/runs", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: createValidRawManifest() }),
    }]);
    resolve(Response.json(body, { status: 201 }));
    await pending;
    expect(h.state().view?.run.id).toBe(id);
    expect(h.state().pending).toBeNull();
    await h.workspace.create(form());
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it("keeps input intact on validation errors and makes no request for invalid input", async () => {
    const h = harness();
    const input = form();
    input.set("mintAmount", "0");
    await h.workspace.create(input);
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.state().error).toContain("positive");
    expect(input.get("mintAmount")).toBe("0");
    input.set("mintAmount", "25");
    h.transport.mockResolvedValue(failure("BAD_REQUEST", 422));
    await h.workspace.create(input);
    expect(h.state().view).toBeNull();
    expect(input.get("mintAmount")).toBe("25");
    expect(h.state().error).toBe("Check the mandate details and try again.");
  });

  it.each([
    () => new Response("INTERNAL_SENTINEL", { status: 502 }),
    () => new Response("{broken INTERNAL_SENTINEL", { status: 500, headers: { "content-type": "application/json" } }),
    () => Response.json({ error: "INTERNAL_SENTINEL" }, { status: 400 }),
    () => failure("INTERNAL_SENTINEL"),
    () => Response.json({ ok: true, run: { id: "INTERNAL_SENTINEL" } }),
  ])("owns malformed and non-JSON response errors %#", async (response) => {
    const h = harness(); h.transport.mockResolvedValue(response());
    await h.workspace.create(form());
    expect(h.state().view).toBeNull();
    expect(h.state().error).toBe("Edict could not read the response. No result has been confirmed.");
  });

  it("shows disabled API honestly without simulation or retry", async () => {
    const h = harness(); h.transport.mockResolvedValue(failure("API_DISABLED", 404));
    await h.workspace.create(form()); await h.workspace.create(form());
    expect(h.state().error).toBe("Run creation is not enabled in this environment.");
    expect(h.state().unavailable).toBe(true);
    expect(h.state().view).toBeNull();
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it("refreshes the authorized run with normal browser cookie handling and no Origin override", async () => {
    const body = await projection(); const h = harness();
    h.transport.mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(Response.json({ ok: true, run: { ...body.run, revision: 2 }, plan: body.plan }));
    await h.workspace.create(form()); await h.workspace.refresh();
    expect(h.transport.mock.calls[1]).toEqual([`/api/runs/${id}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "content-type": "application/json" },
    }]);
    expect(h.state().view?.run.revision).toBe(2);
    expect(h.state().view?.manifest).toEqual(body.manifest);
  });

  it("cancels with the latest revision, suppresses duplicate actions and waits for confirmation", async () => {
    const body = await projection(); const h = harness();
    h.transport.mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(Response.json({ ...body, run: { ...body.run, revision: 4 } }));
    await h.workspace.create(form()); await h.workspace.refresh();
    let resolve!: (response: Response) => void;
    h.transport.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = h.workspace.cancel(); await h.workspace.cancel(); await h.workspace.refresh();
    expect(h.transport).toHaveBeenCalledTimes(3);
    expect(h.state().view?.run.terminalOutcome).toBeNull();
    expect(h.transport.mock.calls[2][0]).toBe(`/api/runs/${id}/cancel`);
    expect(JSON.parse(h.transport.mock.calls[2][1].body as string)).toEqual({ expectedRevision: 4 });
    resolve(Response.json({ ok: true, run: { ...body.run, status: "FAILED", terminalOutcome: "CANCELLED", revision: 5 } }));
    await pending;
    expect(h.state().view?.run.terminalOutcome).toBe("CANCELLED");
    expect(h.state().view?.run.canCancel).toBe(false);
    await h.workspace.cancel(); expect(h.transport).toHaveBeenCalledTimes(3);
  });

  it.each(["REVISION_CONFLICT", "STATE_CONFLICT"])("rereads on %s without retrying cancellation or claiming success", async (code) => {
    const body = await projection(); const h = harness();
    h.transport.mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(failure(code, 409))
      .mockResolvedValueOnce(Response.json({ ...body, run: { ...body.run, revision: 3 } }));
    await h.workspace.create(form()); await h.workspace.cancel();
    expect(h.transport.mock.calls.map(([path]) => path)).toEqual(["/api/runs", `/api/runs/${id}/cancel`, `/api/runs/${id}`]);
    expect(h.state().view?.run.revision).toBe(3);
    expect(h.state().view?.run.terminalOutcome).toBeNull();
    expect(h.state().notice).toContain("The run changed");
  });

  it("retains the last confirmed projection if a stale reread fails", async () => {
    const body = await projection(); const h = harness();
    h.transport.mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(failure("REVISION_CONFLICT", 409)).mockRejectedValueOnce(new Error("INTERNAL_SENTINEL"));
    await h.workspace.create(form()); await h.workspace.cancel();
    expect(h.state().view?.run.revision).toBe(1);
    expect(h.state().view?.run.terminalOutcome).toBeNull();
    expect(h.state().notice).toBeNull();
    expect(h.state().error).toContain("could not confirm");
    expect(h.state().error).not.toContain("INTERNAL_SENTINEL");
  });

  it.each([
    { terminalOutcome: "FAILED" },
    { terminalOutcome: "VERIFICATION_FAILED" },
    { status: "RECONCILIATION_REQUIRED" },
    { operations: [{ blockchainTxHash: "0x123" }, { blockchainTxHash: null }, { blockchainTxHash: null }] },
  ])("omits cancellation for a public state that forbids it %j", async (patch) => {
    const body = await projection(); const h = harness();
    h.transport.mockResolvedValueOnce(Response.json({ ...body, run: { ...body.run, ...patch } }));
    await h.workspace.create(form()); await h.workspace.cancel();
    expect(h.state().view?.run.canCancel).toBe(false);
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it("rejects unrelated, older and malformed successful projections", async () => {
    const body = await projection(); const view = readProjection(body);
    expect(() => readProjection({ ...body, run: { ...body.run, id: "22222222-2222-4222-8222-222222222222" } }, view)).toThrow();
    expect(() => readProjection(body, { ...view, run: { ...view.run, revision: 2 } })).toThrow();
    expect(() => readProjection({ ...body, plan: { ...body.plan, planHash: `sha256:${"0".repeat(64)}` } })).toThrow();
    expect(() => readProjection({ ok: true, run: body.run }, view, true)).toThrow();
  });

  it("imports and renders the initial workspace with no network, and labels every form field", async () => {
    vi.resetModules();
    const fetch = vi.fn(() => { throw new Error("Unexpected network"); }); vi.stubGlobal("fetch", fetch);
    await import("./run-planning");
    const { default: Workspace } = await import("./run-planning-workspace");
    const html = renderToStaticMarkup(createElement(Workspace));
    expect(fetch).not.toHaveBeenCalled();
    expect(html).toContain("Tokenization Planning Workspace");
    expect(html).toContain("Create execution plan");
    for (const [name] of form()) expect(html).toContain(`for="${name}"`);
    expect(html.match(/<input /g)).toHaveLength(9);
  });

  it("keeps UI source limited to the three permitted routes without execution or storage imports", () => {
    const paths = ["src/app/page.tsx", "src/components/run-planning.ts", "src/components/run-planning-workspace.tsx"];
    const source = paths.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).not.toMatch(/approval-challenges|\/approval|\/prepare|\/broadcast|\/confirm|\/poll|eth_requestAccounts|eth_signTypedData|eth_sendTransaction|localStorage|sessionStorage|document\.cookie/);
    expect(source).not.toMatch(/from ["'].*(?:server|client\/wallet|hashing)[/"']|buildExecutionPlan|crypto\.subtle|BRICKKEN_API_KEY|DATABASE_URL/);
    expect(source.match(/\/api\/runs/g)).toHaveLength(2);
    expect(source).toContain("}/cancel`");
  });
});
