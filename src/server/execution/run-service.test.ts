import { describe, expect, it } from "vitest";
import { TOKENIZER_ADDRESS, createValidRawManifest } from "@/core/test-fixtures";
import { validateAssetManifestV1 } from "@/core";
import type { Clock, IdGenerator } from "./infrastructure";
import { InMemoryExecutionRunRepository } from "./repository";
import { ExecutionRunService } from "./run-service";
import { IllegalStateTransitionError } from "./errors";
import { createApprovalProofFixture } from "./test-fixtures";

const UNSIGNED = {
  from: TOKENIZER_ADDRESS,
  to: "0x4444444444444444444444444444444444444444",
  value: "0x00",
  data: "0xabc123",
};
const TX_HASH = `0x${"11".repeat(32)}`;

function createService() {
  let ticks = 0;
  let ids = 0;
  const clock: Clock = {
    nowIso: () => new Date(Date.UTC(2026, 8, 3, 12, 0, ticks++)).toISOString(),
  };
  const generator: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () => `op-${ids++}`,
    eventId: () => `ev-${ids++}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  return new ExecutionRunService({ repository, clock, ids: generator });
}

async function createApproved() {
  const validation = validateAssetManifestV1(createValidRawManifest());
  if (!validation.ok) throw new Error("Golden manifest must validate.");
  const service = createService();
  const created = await service.createRun(validation.value);
  const proof = createApprovalProofFixture(created, "2026-09-03T12:00:01.000Z");
  const run = await service.approvePlan(created.id, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof,
  });
  return { service, run };
}

describe("execution run service persistence order", () => {
  it("persists prepare intent before a prepared transaction can exist", async () => {
    const { service, run } = await createApproved();
    const intent = await service.beginPrepare(run.id, "TOKENIZE");
    expect(intent.operations[0].stage).toBe("PREPARE_INTENT");
    expect(intent.operations[0].preparedTxId).toBeNull();
    const prepared = await service.recordPrepared(run.id, "TOKENIZE", {
      txId: "0xtxid",
      unsignedTransaction: UNSIGNED,
    });
    expect(prepared.operations[0].stage).toBe("PREPARED");
    expect(prepared.operations[0].preparedTxId).toBe("0xtxid");
    expect(prepared.status).toBe("AWAITING_WALLET");
  });

  it("persists the broadcast hash before confirmation identifiers are returned", async () => {
    const { service, run } = await createApproved();
    await service.beginPrepare(run.id, "TOKENIZE");
    await service.recordPrepared(run.id, "TOKENIZE", {
      txId: "0xtxid",
      unsignedTransaction: UNSIGNED,
    });
    await service.recordWalletPrompt(run.id, "TOKENIZE");
    const hashed = await service.recordBroadcastHash(run.id, "TOKENIZE", TX_HASH);
    expect(hashed.operations[0].blockchainTxHash).toBe(TX_HASH);
    const confirmation = await service.submitConfirmation(run.id, "TOKENIZE");
    expect(confirmation.txId).toBe("0xtxid");
    expect(confirmation.txHash).toBe(TX_HASH);
  });

  it("does not log emails in the audit event list", async () => {
    const { run } = await createApproved();
    expect(JSON.stringify(run.events)).not.toContain("tokenizer@example.com");
    expect(JSON.stringify(run.events)).not.toContain("investor@example.com");
  });

  it("refuses to resubmit a blocked run", async () => {
    const { service, run } = await createApproved();
    await service.beginPrepare(run.id, "TOKENIZE");
    await service.recordPrepareUnknown(run.id, "TOKENIZE");
    await expect(service.beginPrepare(run.id, "TOKENIZE")).rejects.toBeInstanceOf(
      IllegalStateTransitionError,
    );
  });
});
