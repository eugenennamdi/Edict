import { describe, expect, it } from "vitest";
import { createValidRawManifest, TOKENIZER_ADDRESS } from "@/core/test-fixtures";
import { validateAssetManifestV1 } from "@/core";
import { ExecutionRunService } from "../execution/run-service";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import type { ExecutionRun } from "../execution/types";
import { deriveExecutionPreparationProjection, nextPreparationOperation } from "./preparation-review";
import { OrchestrationError } from "./errors";

async function setup() {
  let id = 0;
  const clock: Clock = { nowIso: () => `2026-09-09T12:00:0${id++}.000Z` };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () => `operation-${id++}`,
    eventId: () => `event-${id++}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  const runs = new ExecutionRunService({ repository, clock, ids });
  const parsed = validateAssetManifestV1(createValidRawManifest());
  if (!parsed.ok) throw new Error("fixture invalid");
  const created = await runs.createRun(parsed.value);
  const approved = await runs.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, clock.nowIso()),
  });
  return { runs, created, approved };
}

describe("server-derived preparation review", () => {
  it("selects only the exact approved TOKENIZE operation and projects every preparation state", async () => {
    const { runs, created, approved } = await setup();
    expect(() => nextPreparationOperation(created)).toThrow(OrchestrationError);
    expect(nextPreparationOperation(approved).kind).toBe("TOKENIZE");
    await expect(deriveExecutionPreparationProjection(approved)).resolves.toMatchObject({
      preparationStatus: "READY_FOR_PREPARATION",
      nextOperation: { kind: "TOKENIZE", sequence: 1 },
      transactionReview: null,
    });
    const intent = await runs.beginPrepare(approved.id, approved.revision, "TOKENIZE");
    await expect(deriveExecutionPreparationProjection(intent)).resolves.toMatchObject({ preparationStatus: "PREPARATION_PENDING" });
    const prepared = await runs.recordPrepared(intent.id, intent.revision, "TOKENIZE", {
      txId: "prepared-1",
      unsignedTransaction: { from: TOKENIZER_ADDRESS, to: "0x3333333333333333333333333333333333333333", data: "0x1234", chainId: "0xaa36a7" },
    });
    const projection = await deriveExecutionPreparationProjection(prepared);
    expect(projection).toMatchObject({
      preparationStatus: "PREPARED_FOR_REVIEW",
      transactionReview: {
        runRevision: prepared.revision,
        approvalRevision: approved.approval?.approvalRevision,
        walletConfirmation: "NOT_REQUESTED",
        walletRequest: { from: TOKENIZER_ADDRESS, data: "0x1234" },
      },
    });
  });

  it("fails closed instead of projecting a prepared signer or chain mismatch", async () => {
    const { runs, approved } = await setup();
    const intent = await runs.beginPrepare(approved.id, approved.revision, "TOKENIZE");
    const malformed = await runs.recordPrepared(intent.id, intent.revision, "TOKENIZE", {
      txId: "prepared-1",
      unsignedTransaction: { from: "0x4444444444444444444444444444444444444444", to: "0x3333333333333333333333333333333333333333", data: "0x1234", chainId: "0x1" },
    });
    await expect(deriveExecutionPreparationProjection(malformed)).rejects.toMatchObject({ code: "EXECUTION_INVARIANT_FAILED" });
  });

  it("rejects wrong phase and approval bindings before selecting an operation", async () => {
    const { approved } = await setup();
    expect(() => nextPreparationOperation({ ...approved, phase: "WHITELIST" })).toThrow(OrchestrationError);
    expect(() => nextPreparationOperation({
      ...approved,
      approval: approved.approval && { ...approved.approval, planHash: `sha256:${"0".repeat(64)}` },
    } as ExecutionRun)).toThrow(OrchestrationError);
    expect(() => nextPreparationOperation({
      ...approved,
      approval: approved.approval && { ...approved.approval, approvedByWallet: "0x4444444444444444444444444444444444444444" },
    } as ExecutionRun)).toThrow(OrchestrationError);
  });
});
