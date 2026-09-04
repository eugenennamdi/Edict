import { describe, expect, it } from "vitest";
import {
  GOLDEN_MANIFEST_HASH,
  GOLDEN_PLAN_HASH,
  TOKENIZER_ADDRESS,
  createValidRawManifest,
} from "@/core/test-fixtures";
import { validateAssetManifestV1 } from "@/core";
import { IllegalStateTransitionError, InvalidApprovalError } from "./errors";
import { InMemoryExecutionRunRepository } from "./repository";
import { ExecutionRunService } from "./run-service";
import type { Clock, IdGenerator } from "./infrastructure";
import { applyRunEvent } from "./transitions";
import type { ExecutionRun, ExecutionRunEvent, OperationKind } from "./types";
import { createApprovalProofFixture } from "./test-fixtures";

const UNSIGNED = {
  from: TOKENIZER_ADDRESS,
  to: "0x4444444444444444444444444444444444444444",
  value: "0x00",
  nonce: 1,
  chainId: 11155111,
  data: "0xabc123",
  type: 2,
  maxPriorityFeePerGas: "1150000",
  maxFeePerGas: "1156037",
  gasLimit: "0xccef",
};

const TX_HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"cd".repeat(32)}`;

function createHarness() {
  let ticks = 0;
  let ids = 0;
  const clock: Clock = {
    nowIso: () => {
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, ticks, 0)).toISOString();
      ticks += 1;
      return stamp;
    },
  };
  const generator: IdGenerator = {
    runId: () => `run-${String((ids += 1)).padStart(2, "0")}`,
    operationId: () => `op-${String((ids += 1)).padStart(2, "0")}`,
    eventId: () => `ev-${String((ids += 1)).padStart(2, "0")}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  const service = new ExecutionRunService({ repository, clock, ids: generator });
  return { service, repository };
}

async function newRun() {
  const validation = validateAssetManifestV1(createValidRawManifest());
  if (!validation.ok) throw new Error("Golden manifest must validate.");
  const { service } = createHarness();
  return { service, run: await service.createRun(validation.value) };
}

async function approvedRun() {
  const { service, run } = await newRun();
  const proof = createApprovalProofFixture(run, "2026-01-01T00:00:01.000Z");
  const approved = await service.approvePlan(run.id, {
    planHash: run.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof,
  });
  return { service, run: approved };
}

async function preparedRun(kind: OperationKind = "TOKENIZE") {
  const { service, run } = await approvedRun();
  await service.beginPrepare(run.id, kind);
  const prepared = await service.recordPrepared(run.id, kind, {
    txId: "0xprepared",
    unsignedTransaction: UNSIGNED,
  });
  return { service, run: prepared };
}

async function promptedRun(kind: OperationKind = "TOKENIZE") {
  const { service, run } = await preparedRun(kind);
  return { service, run: await service.recordWalletPrompt(run.id, kind) };
}

async function hashedRun(kind: OperationKind = "TOKENIZE") {
  const { service, run } = await promptedRun(kind);
  return { service, run: await service.recordBroadcastHash(run.id, kind, TX_HASH) };
}

async function pendingRun(kind: OperationKind = "TOKENIZE") {
  const { service, run } = await hashedRun(kind);
  await service.submitConfirmation(run.id, kind);
  return { service, run: await service.recordPending(run.id, kind) };
}

async function confirmedRun(kind: OperationKind = "TOKENIZE") {
  const { service, run } = await pendingRun(kind);
  return { service, run: await service.recordConfirmed(run.id, kind) };
}

async function verifiedWrite(kind: OperationKind) {
  const { service, run } = await confirmedRun(kind);
  return {
    service,
    run: await service.recordReadBackVerified(run.id, kind, `${kind}-read`),
  };
}

describe("execution run creation", () => {
  it("persists hashes matching the Phase 2 golden values", async () => {
    const { run } = await newRun();
    expect(run.manifestHash).toBe(GOLDEN_MANIFEST_HASH);
    expect(run.planHash).toBe(GOLDEN_PLAN_HASH);
    expect(run.revision).toBe(1);
    expect(run.phase).toBe("PLAN");
    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.receiptEligible).toBe(false);
    expect(run.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(run.operations.map((operation) => operation.kind)).toEqual([
      "TOKENIZE",
      "WHITELIST",
      "MINT",
    ]);
  });
});

describe("approval binding", () => {
  it("binds the exact plan hash and tokenizer wallet", async () => {
    const { run } = await approvedRun();
    expect(run.approval?.planHash).toBe(GOLDEN_PLAN_HASH);
    expect(run.approval?.approvedByWallet).toBe(TOKENIZER_ADDRESS);
    expect(run.phase).toBe("TOKENIZATION");
    expect(run.status).toBe("PREPARING");
  });

  it("rejects a mismatched plan hash", async () => {
    const { service, run } = await newRun();
    await expect(
      service.approvePlan(run.id, {
        planHash: GOLDEN_MANIFEST_HASH,
        approvedByWallet: TOKENIZER_ADDRESS,
        proof: createApprovalProofFixture(run, "2026-01-01T00:00:01.000Z"),
      }),
    ).rejects.toBeInstanceOf(InvalidApprovalError);
  });

  it("rejects a non-tokenizer wallet", async () => {
    const { service, run } = await newRun();
    await expect(
      service.approvePlan(run.id, {
        planHash: run.planHash,
        approvedByWallet: "0x2222222222222222222222222222222222222222",
        proof: createApprovalProofFixture(
          run,
          "2026-01-01T00:00:01.000Z",
          "0x2222222222222222222222222222222222222222",
        ),
      }),
    ).rejects.toBeInstanceOf(InvalidApprovalError);
  });

  it("rejects approval when the run is not awaiting approval", async () => {
    const { service, run } = await approvedRun();
    await expect(
      service.approvePlan(run.id, {
        planHash: run.planHash,
        approvedByWallet: TOKENIZER_ADDRESS,
        proof: createApprovalProofFixture(run, "2026-01-01T00:00:02.000Z"),
      }),
    ).rejects.toBeInstanceOf(InvalidApprovalError);
  });
});

describe("permitted transitions", () => {
  it("walks tokenize through verification eligibility", async () => {
    const { service, run } = await approvedRun();
    await service.beginPrepare(run.id, "TOKENIZE");
    await service.recordPrepared(run.id, "TOKENIZE", {
      txId: "0xprepared",
      unsignedTransaction: UNSIGNED,
    });
    await service.recordWalletPrompt(run.id, "TOKENIZE");
    await service.recordBroadcastHash(run.id, "TOKENIZE", TX_HASH);
    const submitted = await service.submitConfirmation(run.id, "TOKENIZE");
    expect(submitted.txId).toBe("0xprepared");
    expect(submitted.txHash).toBe(TX_HASH);
    await service.recordPending(run.id, "TOKENIZE");
    await service.recordConfirmed(run.id, "TOKENIZE");
    const verified = await service.recordReadBackVerified(run.id, "TOKENIZE", "TOKEN_INFO");
    expect(verified.phase).toBe("WHITELIST");
    expect(verified.operations[0].stage).toBe("READ_BACK_VERIFIED");
    expect(verified.receiptEligible).toBe(false);
  });

  it("allows explicit wallet rejection then the same prepared prompt", async () => {
    const { service, run } = await promptedRun();
    const rejected = await service.recordWalletRejection(run.id, "TOKENIZE");
    expect(rejected.operations[0].stage).toBe("WALLET_REJECTED");
    expect(rejected.operations[0].preparedTxId).toBe("0xprepared");
    const retried = await service.recordWalletPrompt(run.id, "TOKENIZE");
    expect(retried.operations[0].stage).toBe("WALLET_PROMPT_RECORDED");
    expect(retried.status).toBe("AWAITING_WALLET");
  });

  it("retries identical confirmation after transport failure", async () => {
    const { service, run } = await hashedRun();
    await service.submitConfirmation(run.id, "TOKENIZE");
    const failed = await service.recordConfirmTransportFailure(run.id, "TOKENIZE");
    expect(failed.operations[0].stage).toBe("BROADCAST_HASH_PERSISTED");
    const retry = await service.submitConfirmation(run.id, "TOKENIZE");
    expect(retry.txId).toBe("0xprepared");
    expect(retry.txHash).toBe(TX_HASH);
  });

  it("resumes polling after a timeout", async () => {
    const { service, run } = await pendingRun();
    const timedOut = await service.recordPollTimeout(run.id, "TOKENIZE");
    expect(timedOut.status).toBe("TIMED_OUT");
    const pending = await service.recordPending(run.id, "TOKENIZE");
    expect(pending.status).toBe("CONFIRMING");
    expect(pending.operations[0].timeout).toBe(false);
  });

  it("requires linear tokenize then whitelist then mint before receipt eligibility", async () => {
    const { service, run } = await verifiedWrite("TOKENIZE");
    await service.beginPrepare(run.id, "WHITELIST");
    await service.recordPrepared(run.id, "WHITELIST", {
      txId: "0xwl",
      unsignedTransaction: UNSIGNED,
    });
    await service.recordWalletPrompt(run.id, "WHITELIST");
    await service.recordBroadcastHash(run.id, "WHITELIST", OTHER_HASH);
    await service.submitConfirmation(run.id, "WHITELIST");
    await service.recordConfirmed(run.id, "WHITELIST");
    const whitelistVerified = await service.recordReadBackVerified(
      run.id,
      "WHITELIST",
      "WHITELIST_STATUS",
    );
    expect(whitelistVerified.phase).toBe("MINT");
    await service.beginPrepare(run.id, "MINT");
    await service.recordPrepared(run.id, "MINT", {
      txId: "0xmint",
      unsignedTransaction: UNSIGNED,
    });
    await service.recordWalletPrompt(run.id, "MINT");
    await service.recordBroadcastHash(run.id, "MINT", `0x${"ef".repeat(32)}`);
    await service.submitConfirmation(run.id, "MINT");
    await service.recordConfirmed(run.id, "MINT");
    const minted = await service.recordReadBackVerified(run.id, "MINT", "BALANCE");
    expect(minted.phase).toBe("VERIFICATION");
    expect(minted.receiptEligible).toBe(false);
    const final = await service.recordFinalVerification(run.id);
    expect(final.receiptEligible).toBe(true);
  });
});

describe("forbidden transitions", () => {
  const cases: Array<{
    name: string;
    setup: () => Promise<{ service: ExecutionRunService; run: ExecutionRun }>;
    act: (service: ExecutionRunService, run: ExecutionRun) => Promise<unknown>;
  }> = [
    {
      name: "prepare before approval",
      setup: newRun,
      act: (service, run) => service.beginPrepare(run.id, "TOKENIZE"),
    },
    {
      name: "wallet prompt before prepared tx",
      setup: approvedRun,
      act: async (service, run) => {
        await service.beginPrepare(run.id, "TOKENIZE");
        return service.recordWalletPrompt(run.id, "TOKENIZE");
      },
    },
    {
      name: "confirm before both identifiers",
      setup: preparedRun,
      act: (service, run) => service.submitConfirmation(run.id, "TOKENIZE"),
    },
    {
      name: "whitelist before tokenize verification",
      setup: approvedRun,
      act: (service, run) => service.beginPrepare(run.id, "WHITELIST"),
    },
    {
      name: "mint before whitelist verification",
      setup: async () => verifiedWrite("TOKENIZE"),
      act: (service, run) => service.beginPrepare(run.id, "MINT"),
    },
    {
      name: "second prepare after txId exists",
      setup: preparedRun,
      act: (service, run) => service.beginPrepare(run.id, "TOKENIZE"),
    },
    {
      name: "second hash after broadcast",
      setup: hashedRun,
      act: (service, run) => service.recordBroadcastHash(run.id, "TOKENIZE", OTHER_HASH),
    },
    {
      name: "wallet prompt after hash",
      setup: hashedRun,
      act: (service, run) => service.recordWalletPrompt(run.id, "TOKENIZE"),
    },
    {
      name: "prepare after hash",
      setup: hashedRun,
      act: (service, run) => service.beginPrepare(run.id, "TOKENIZE"),
    },
    {
      name: "cancel after hash",
      setup: hashedRun,
      act: (service, run) => service.cancelRun(run.id),
    },
    {
      name: "final verification before all reads",
      setup: async () => verifiedWrite("TOKENIZE"),
      act: (service, run) => service.recordFinalVerification(run.id),
    },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name}`, async () => {
      const { service, run } = await testCase.setup();
      await expect(testCase.act(service, run)).rejects.toBeInstanceOf(IllegalStateTransitionError);
    });
  }
});

describe("reconciliation blocking", () => {
  it("blocks the run after an ambiguous prepare", async () => {
    const { service, run } = await approvedRun();
    await service.beginPrepare(run.id, "TOKENIZE");
    const blocked = await service.recordPrepareUnknown(run.id, "TOKENIZE");
    expect(blocked.status).toBe("RECONCILIATION_REQUIRED");
    expect(blocked.operations[0].stage).toBe("PREPARE_UNKNOWN");
    await expect(service.beginPrepare(run.id, "TOKENIZE")).rejects.toBeInstanceOf(
      IllegalStateTransitionError,
    );
    await expect(service.recordWalletPrompt(run.id, "TOKENIZE")).rejects.toBeInstanceOf(
      IllegalStateTransitionError,
    );
    await expect(service.recordBroadcastHash(run.id, "TOKENIZE", TX_HASH)).rejects.toBeInstanceOf(
      IllegalStateTransitionError,
    );
  });

  it("blocks the run after an ambiguous broadcast and does not stay awaiting wallet", async () => {
    const { service, run } = await promptedRun();
    const blocked = await service.recordBroadcastUnknown(run.id, "TOKENIZE");
    expect(blocked.status).toBe("RECONCILIATION_REQUIRED");
    expect(blocked.status).not.toBe("AWAITING_WALLET");
    expect(blocked.operations[0].stage).toBe("BROADCAST_UNKNOWN");
    await expect(service.recordWalletPrompt(run.id, "TOKENIZE")).rejects.toBeInstanceOf(
      IllegalStateTransitionError,
    );
    await expect(service.beginPrepare(run.id, "TOKENIZE")).rejects.toBeInstanceOf(
      IllegalStateTransitionError,
    );
    await expect(service.submitConfirmation(run.id, "TOKENIZE")).rejects.toBeInstanceOf(
      IllegalStateTransitionError,
    );
  });
});

describe("applyRunEvent isolation", () => {
  it("does not mutate the input run", async () => {
    const { run } = await newRun();
    const event: ExecutionRunEvent = {
      type: "APPROVE_PLAN",
      id: "ev-x",
      at: "2026-01-01T00:00:00.000Z",
      planHash: run.planHash,
      approvedByWallet: TOKENIZER_ADDRESS,
      proof: createApprovalProofFixture(run, "2026-01-01T00:00:00.000Z"),
    };
    const next = applyRunEvent(run, event);
    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.approval).toBeNull();
    expect(next.status).toBe("PREPARING");
    expect(next.approval?.approvedByWallet).toBe(TOKENIZER_ADDRESS);
  });
});
