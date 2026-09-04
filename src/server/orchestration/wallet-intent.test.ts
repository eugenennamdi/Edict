import { describe, expect, it } from "vitest";
import { createValidRawManifest, TOKENIZER_ADDRESS } from "@/core/test-fixtures";
import { validateAssetManifestV1 } from "@/core";
import encodingA from "@/server/brickken/test-vectors/prepare/newTokenization.response.json";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import type { WalletSemanticPolicy } from "@/shared/wallet";
import { validateWalletPromptEnvelopeV1 } from "@/shared/wallet";
import { deriveWalletPromptEnvelopeFromRun } from "./wallet-intent";

const allowFixturePolicy: WalletSemanticPolicy = Object.freeze({
  authorize: () =>
    Object.freeze({ allowed: true as const, policyVersion: "fixture-v1", authorizationId: "fixture" }),
});

async function createPromptedRun() {
  let operation = 0;
  const clock: Clock = { nowIso: () => "2026-09-04T00:00:00.000Z" };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () =>
      [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ][operation++]!,
    eventId: () => `event-${operation++}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  const service = new ExecutionRunService({ repository, clock, ids });
  const parsed = validateAssetManifestV1(createValidRawManifest());
  if (!parsed.ok) throw new Error("fixture invalid");
  const created = await service.createRun(parsed.value);
  const approved = await service.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, clock.nowIso()),
  });
  const preparing = await service.beginPrepare(approved.id, approved.revision, "TOKENIZE");
  const prepared = await service.recordPrepared(preparing.id, preparing.revision, "TOKENIZE", {
    txId: encodingA.txId,
    unsignedTransaction: encodingA.transactions[0],
  });
  return service.recordWalletPrompt(prepared.id, prepared.revision, "TOKENIZE");
}

describe("server wallet intent derivation", () => {
  it("rederives a strict browser envelope only from the durable prompted run", async () => {
    const run = await createPromptedRun();
    const envelope = await deriveWalletPromptEnvelopeFromRun(run, "TOKENIZE", allowFixturePolicy);

    await expect(validateWalletPromptEnvelopeV1(structuredClone(envelope))).resolves.toEqual(envelope);
    expect(envelope).toMatchObject({
      runId: run.id,
      manifestHash: run.manifestHash,
      planHash: run.planHash,
      preparedTransactionId: encodingA.txId,
      requiredSigner: TOKENIZER_ADDRESS,
      chainId: "11155111",
      promptRevision: run.revision,
    });
    expect(envelope.walletRequest).not.toHaveProperty("chainId");
    expect(envelope).not.toHaveProperty("unsignedTransaction");
    expect(JSON.stringify(envelope)).not.toContain("transactions");
  });

  it("refuses a signer mismatch or a deny-all semantic policy", async () => {
    const run = await createPromptedRun();
    const mismatch = {
      ...run,
      operations: [
        {
          ...run.operations[0],
          unsignedTransaction: {
            ...run.operations[0].unsignedTransaction,
            from: "0x9999999999999999999999999999999999999999",
          },
        },
        run.operations[1],
        run.operations[2],
      ],
    } as typeof run;
    await expect(
      deriveWalletPromptEnvelopeFromRun(mismatch, "TOKENIZE", allowFixturePolicy),
    ).rejects.toMatchObject({ code: "EXECUTION_INVARIANT_FAILED" });
    await expect(
      deriveWalletPromptEnvelopeFromRun(run, "TOKENIZE", {
        authorize: () => ({ allowed: false, code: "SEMANTIC_POLICY_UNVERIFIED" }),
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_INVARIANT_FAILED" });
  });
});
