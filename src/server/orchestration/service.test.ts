import { describe, expect, it } from "vitest";
import { createValidRawManifest, TOKENIZER_ADDRESS } from "@/core/test-fixtures";
import { validateAssetManifestV1 } from "@/core";
import { BrickkenAdapterError } from "../brickken/errors";
import type { BrickkenServerAdapter, PreparedOperation } from "../brickken/types";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import type { ExecutionRunRepository } from "../execution/repository";
import { ExecutionOrchestrator } from "./service";
import { BrickkenWritesDisabledError, createPreparationOnlyBrickkenWriteGate, disabledBrickkenWriteGate, type BrickkenWriteGate } from "./write-gate";

const prepared: PreparedOperation = {
  txId: "brickken-tx-1",
  executionMode: "client-broadcast",
  transaction: {
    from: TOKENIZER_ADDRESS,
    to: "0x3333333333333333333333333333333333333333",
    data: "0x1234",
    value: "0x0",
    nonce: "0x1",
    chainId: "0xaa36a7",
    type: "0x2",
    gasLimit: "0x5208",
    maxFeePerGas: "0x10",
    maxPriorityFeePerGas: "0x1",
    gasPrice: null,
    normalizedChainId: "11155111",
    rawUnsigned: { from: TOKENIZER_ADDRESS, to: "0x3333333333333333333333333333333333333333", data: "0x1234", chainId: "0xaa36a7" },
  },
};

function adapter(
  prepareResult: Awaited<ReturnType<BrickkenServerAdapter["prepareTokenization"]>> = { ok: true, value: prepared },
  statusResult: Awaited<ReturnType<BrickkenServerAdapter["getTransactionStatus"]>> = { ok: true, value: { status: "pending", transactionHash: null, error: null } },
) {
  let prepares = 0;
  const confirmations: Array<{ txId: string; txHash: string }> = [];
  const value: BrickkenServerAdapter = {
    async prepareTokenization() { prepares += 1; return prepareResult; },
    async prepareWhitelist() { prepares += 1; return prepareResult; },
    async prepareMint() { prepares += 1; return prepareResult; },
    async confirmBroadcast(input) { confirmations.push(input); return { ok: true, value: { txHash: input.txHash, status: "pending" } }; },
    async getTransactionStatus() { return statusResult; },
    async getTokenInfo() { throw new Error("unused"); },
    async getTokenizerInfo() { throw new Error("unused"); },
    async getWhitelistStatus() { throw new Error("unused"); },
    async getBalanceAndWhitelist() { throw new Error("unused"); },
    async getNetworkInfo() { throw new Error("unused"); },
  };
  return { value, prepares: () => prepares, confirmations };
}

async function approvedSetup(writeGate: BrickkenWriteGate, brickken = adapter()) {
  let sequence = 0;
  const clock: Clock = { nowIso: () => new Date(Date.UTC(2026, 8, 4, 0, 0, sequence++)).toISOString() };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () => `operation-${sequence++}`,
    eventId: () => `event-${sequence++}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  const runs = new ExecutionRunService({ repository, clock, ids });
  const parsed = validateAssetManifestV1(createValidRawManifest());
  if (!parsed.ok) throw new Error("fixture invalid");
  const created = await runs.createRun(parsed.value);
  const run = await runs.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, clock.nowIso()),
  });
  return { repository, runs, run, brickken, orchestrator: new ExecutionOrchestrator({ repository, runs, brickken: brickken.value, writeGate }) };
}

const enabledGate: BrickkenWriteGate = { assertEnabled() {} };

describe("durable execution orchestration", () => {
  it("checks the disabled gate before reads, mutations, or Brickken calls", async () => {
    const setup = await approvedSetup(disabledBrickkenWriteGate);
    const before = await setup.repository.getById(setup.run.id);
    await expect(setup.orchestrator.prepareOperation(setup.run.id, before.revision, "TOKENIZE")).rejects.toBeInstanceOf(BrickkenWritesDisabledError);
    expect((await setup.repository.getById(setup.run.id)).revision).toBe(before.revision);
    expect(setup.brickken.prepares()).toBe(0);
  });

  it("persists intent, checks the gate again, and never calls Brickken when the second gate closes", async () => {
    let checks = 0;
    const gate: BrickkenWriteGate = { assertEnabled() { checks += 1; if (checks === 2) throw new BrickkenWritesDisabledError(); } };
    const setup = await approvedSetup(gate);
    await expect(setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision, "TOKENIZE")).rejects.toBeInstanceOf(BrickkenWritesDisabledError);
    const durable = await setup.repository.getById(setup.run.id);
    expect(checks).toBe(2);
    expect(durable.operations[0].stage).toBe("PREPARE_INTENT");
    expect(setup.brickken.prepares()).toBe(0);
  });

  it("allows one CAS winner and makes at most one prepare call", async () => {
    const setup = await approvedSetup(enabledGate);
    const results = await Promise.allSettled([
      setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision, "TOKENIZE"),
      setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision, "TOKENIZE"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(setup.brickken.prepares()).toBe(1);
    const durable = await setup.repository.getById(setup.run.id);
    expect(durable.operations[0].stage).toBe("PREPARED");
    expect(durable.operations[0].unsignedTransaction).toEqual(prepared.transaction.rawUnsigned);
  });

  it("derives TOKENIZE server-side for the public preparation boundary", async () => {
    const setup = await approvedSetup(enabledGate);
    const result = await setup.orchestrator.prepareNextOperation(setup.run.id, setup.run.revision);
    expect(result.revision).toBe(setup.run.revision + 2);
    expect(result.operations[0]).toMatchObject({ kind: "TOKENIZE", stage: "PREPARED" });
    expect(result.operations[1].stage).toBe("NOT_STARTED");
    expect(setup.brickken.prepares()).toBe(1);
  });

  it("allows one server-derived preparation winner across concurrent requests", async () => {
    const setup = await approvedSetup(enabledGate);
    const results = await Promise.allSettled([
      setup.orchestrator.prepareNextOperation(setup.run.id, setup.run.revision),
      setup.orchestrator.prepareNextOperation(setup.run.id, setup.run.revision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(setup.brickken.prepares()).toBe(1);
  });

  it("marks an indeterminate prepare response for reconciliation", async () => {
    const brickken = adapter({ ok: false, error: new BrickkenAdapterError("INVALID_EXTERNAL_RESPONSE", "sanitized") });
    const setup = await approvedSetup(enabledGate, brickken);
    await expect(setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision, "TOKENIZE")).rejects.toMatchObject({ code: "BRICKKEN_OPERATION_FAILED" });
    const durable = await setup.repository.getById(setup.run.id);
    expect(durable.status).toBe("RECONCILIATION_REQUIRED");
    expect(durable.operations[0].stage).toBe("PREPARE_UNKNOWN");
    expect(brickken.prepares()).toBe(1);
  });

  it("records a definite preparation entitlement refusal as terminal", async () => {
    const brickken = adapter({
      ok: false,
      error: new BrickkenAdapterError("ENTITLEMENT_REJECTED", "sanitized"),
    });
    const setup = await approvedSetup(enabledGate, brickken);

    await expect(
      setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision, "TOKENIZE"),
    ).rejects.toMatchObject({ code: "BRICKKEN_OPERATION_FAILED" });

    const durable = await setup.repository.getById(setup.run.id);
    expect(durable.status).toBe("FAILED");
    expect(durable.terminalOutcome).toBe("FAILED");
    expect(durable.operations[0].stage).toBe("PREPARE_UNKNOWN");
    expect(brickken.prepares()).toBe(1);
  });

  it("refuses a stale revision before calling the injected adapter", async () => {
    const setup = await approvedSetup(enabledGate);
    await expect(setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision - 1, "TOKENIZE")).rejects.toMatchObject({ code: "REPOSITORY_REVISION_CONFLICT" });
    expect(setup.brickken.prepares()).toBe(0);
  });

  it("fails a manifest/hash mismatch before any intent or adapter call", async () => {
    const setup = await approvedSetup(enabledGate);
    const mismatched = { ...setup.run, manifestHash: `sha256:${"0".repeat(64)}` };
    const repository: ExecutionRunRepository = {
      create: async () => { throw new Error("unused"); },
      getById: async () => mismatched,
      update: async () => { throw new Error("must not mutate"); },
    };
    const orchestrator = new ExecutionOrchestrator({
      repository,
      runs: setup.runs,
      brickken: setup.brickken.value,
      writeGate: enabledGate,
    });
    await expect(orchestrator.prepareNextOperation(setup.run.id, setup.run.revision))
      .rejects.toMatchObject({ code: "EXECUTION_INVARIANT_FAILED" });
    expect(setup.brickken.prepares()).toBe(0);
  });

  it("the production preparation gate can never authorize confirmation", () => {
    const gate = createPreparationOnlyBrickkenWriteGate(true);
    expect(() => gate.assertEnabled("PREPARE")).not.toThrow();
    expect(() => gate.assertEnabled("CONFIRM_BROADCAST")).toThrow(BrickkenWritesDisabledError);
  });

  it("confirms only the identical durable pair and leaves pending poll-only", async () => {
    const setup = await approvedSetup(enabledGate);
    const preparedRun = await setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision, "TOKENIZE");
    const prompted = await setup.orchestrator.recordWalletPrompt(preparedRun.id, preparedRun.revision, "TOKENIZE");
    const txHash = `0x${"ab".repeat(32)}`;
    const broadcast = await setup.orchestrator.recordWalletResult(prompted.id, prompted.revision, "TOKENIZE", { outcome: "BROADCAST", txHash });
    const pending = await setup.orchestrator.confirmBroadcast(broadcast.id, broadcast.revision, "TOKENIZE");
    expect(setup.brickken.confirmations).toEqual([{ txId: prepared.txId, txHash }]);
    expect(pending.operations[0].stage).toBe("PENDING");
    await expect(setup.orchestrator.confirmBroadcast(pending.id, pending.revision, "TOKENIZE")).rejects.toMatchObject({ code: "ILLEGAL_STATE_TRANSITION" });
    expect(setup.brickken.confirmations).toHaveLength(1);
  });

  it("checks the confirmation gate before persisting confirmation intent", async () => {
    const setup = await approvedSetup(enabledGate);
    const preparedRun = await setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision, "TOKENIZE");
    const prompted = await setup.orchestrator.recordWalletPrompt(preparedRun.id, preparedRun.revision, "TOKENIZE");
    const broadcast = await setup.orchestrator.recordWalletResult(prompted.id, prompted.revision, "TOKENIZE", { outcome: "BROADCAST", txHash: `0x${"cd".repeat(32)}` });
    const disabled = new ExecutionOrchestrator({ repository: setup.repository, runs: setup.runs, brickken: setup.brickken.value, writeGate: disabledBrickkenWriteGate });
    await expect(disabled.confirmBroadcast(broadcast.id, broadcast.revision, "TOKENIZE")).rejects.toBeInstanceOf(BrickkenWritesDisabledError);
    const durable = await setup.repository.getById(broadcast.id);
    expect(durable.revision).toBe(broadcast.revision);
    expect(durable.operations[0].stage).toBe("BROADCAST_HASH_PERSISTED");
    expect(setup.brickken.confirmations).toHaveLength(0);
  });

  it("never persists an upstream rejection message", async () => {
    const sensitive = "credential-shaped-upstream-detail";
    const brickken = adapter(undefined, { ok: true, value: { status: "rejected", transactionHash: null, error: sensitive } });
    const setup = await approvedSetup(enabledGate, brickken);
    const preparedRun = await setup.orchestrator.prepareOperation(setup.run.id, setup.run.revision, "TOKENIZE");
    const prompted = await setup.orchestrator.recordWalletPrompt(preparedRun.id, preparedRun.revision, "TOKENIZE");
    const broadcast = await setup.orchestrator.recordWalletResult(prompted.id, prompted.revision, "TOKENIZE", { outcome: "BROADCAST", txHash: `0x${"ef".repeat(32)}` });
    const pending = await setup.orchestrator.confirmBroadcast(broadcast.id, broadcast.revision, "TOKENIZE");
    const rejected = await setup.orchestrator.pollOperation(pending.id, pending.revision, "TOKENIZE");
    expect(JSON.stringify(rejected)).not.toContain(sensitive);
    expect(rejected.operations[0].brickkenError).toBe("Brickken reported a rejected transaction.");
  });
});
