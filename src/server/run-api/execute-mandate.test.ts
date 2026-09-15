import { describe, expect, it, vi } from "vitest";
import type { ExecutionRun, ExecutionRunV4 } from "../execution";
import type { RunApiRuntime } from "./runtime";
import { executeMandateHandler } from "./handlers";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://edict.example";

function request(revision: number) {
  return new Request(`${ORIGIN}/api/runs/${RUN_ID}/execute`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: revision }),
  });
}

function operation(stage: string) {
  return { id: "op-1", kind: "TOKENIZE", stage, preparedTxId: stage === "NOT_STARTED" ? null : "tx-1", unsignedTransaction: stage === "NOT_STARTED" ? null : {}, blockchainTxHash: null };
}

function run(stage: string, revision: number, schemaVersion: "2.0" | "4.0", status = stage === "NOT_STARTED" ? "PREPARING" : "AWAITING_WALLET") {
  return {
    plan: { executionScope: "TOKENIZE_ONLY" },
    id: RUN_ID, revision, schemaVersion, status, phase: "TOKENIZATION", terminalOutcome: null,
    operations: [operation(stage), { kind: "WHITELIST", stage: "NOT_STARTED" }, { kind: "MINT", stage: "NOT_STARTED" }],
  } as unknown as ExecutionRun;
}

function harness(initial: ExecutionRun) {
  let current = initial;
  const prepareNextOperation = vi.fn(async () => {
    current = run("PREPARED", current.revision + 2, "2.0");
    return current;
  });
  const promotePreparedRunToV4 = vi.fn(async () => {
    current = run("PREPARED", current.revision + 1, "4.0");
    return current as ExecutionRunV4;
  });
  const evaluateAndApplyPreparedFreshness = vi.fn(async () => ({
    evaluation: { eligible: true }, run: current,
  }));
  const reprepareOperation = vi.fn(async () => {
    current = run("PREPARED", current.revision + 2, "4.0");
    return current as ExecutionRunV4;
  });
  const releaseSendAuthority = vi.fn(async () => ({ envelope: { domain: "test" }, run: current }));
  const runtime = {
    runs: { getRun: vi.fn(async () => current) },
    access: { verify: vi.fn(async () => undefined) },
    execution: { prepareNextOperation },
    walletExecution: { promotePreparedRunToV4, evaluateAndApplyPreparedFreshness, reprepareOperation, releaseSendAuthority },
  } as unknown as RunApiRuntime;
  return { runtime, prepareNextOperation, promotePreparedRunToV4, evaluateAndApplyPreparedFreshness, reprepareOperation, releaseSendAuthority };
}

const options = (runtime: RunApiRuntime) => ({
  config: { enabled: true, trustedOrigin: ORIGIN } as const,
  runtime: () => runtime,
});

describe("Execute mandate product command", () => {
  it("internalizes one preparation, promotion, freshness, and authority release", async () => {
    const h = harness(run("NOT_STARTED", 2, "2.0"));
    const response = await executeMandateHandler(request(2), RUN_ID, options(h.runtime));
    expect(response.status).toBe(200);
    expect(h.prepareNextOperation).toHaveBeenCalledOnce();
    expect(h.promotePreparedRunToV4).toHaveBeenCalledOnce();
    expect(h.evaluateAndApplyPreparedFreshness).toHaveBeenCalledOnce();
    expect(h.reprepareOperation).not.toHaveBeenCalled();
    expect(h.releaseSendAuthority).toHaveBeenCalledOnce();
  });

  it("performs exactly one legal reprepare for a known stale pre-authority attempt", async () => {
    const h = harness(run("PREPARED_STALE", 8, "4.0"));
    const response = await executeMandateHandler(request(8), RUN_ID, options(h.runtime));
    expect(response.status).toBe(200);
    expect(h.prepareNextOperation).not.toHaveBeenCalled();
    expect(h.reprepareOperation).toHaveBeenCalledOnce();
    expect(h.releaseSendAuthority).toHaveBeenCalledOnce();
  });

  it("never redispatches an ambiguous preparation", async () => {
    const h = harness(run("PREPARE_UNKNOWN", 4, "4.0", "RECONCILIATION_REQUIRED"));
    h.releaseSendAuthority.mockRejectedValueOnce(new Error("illegal state"));
    const response = await executeMandateHandler(request(4), RUN_ID, options(h.runtime));
    expect(response.status).toBe(400);
    expect(h.prepareNextOperation).not.toHaveBeenCalled();
    expect(h.reprepareOperation).not.toHaveBeenCalled();
  });

  it("stops and returns 503 FRESHNESS_CHECK_FAILED when prepared attempt freshness check fails, without releasing authority", async () => {
    const h = harness(run("PREPARED", 4, "4.0"));
    h.evaluateAndApplyPreparedFreshness.mockResolvedValueOnce({
      evaluation: { eligible: false, outcome: "PRICE_REPORT_EXPIRED" } as never,
      run: run("PREPARED_STALE", 5, "4.0"),
    });
    const response = await executeMandateHandler(request(4), RUN_ID, options(h.runtime));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ ok: false, error: { code: "FRESHNESS_CHECK_FAILED" } });
    expect(h.evaluateAndApplyPreparedFreshness).toHaveBeenCalledOnce();
    expect(h.reprepareOperation).not.toHaveBeenCalled();
    expect(h.releaseSendAuthority).not.toHaveBeenCalled();
  });
});
