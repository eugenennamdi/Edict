import { sha256Utf8, validateAssetManifestV1 } from "@/core";
import { TOKENIZER_ADDRESS, createValidRawManifest } from "@/core/test-fixtures";
import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { ExecutionRunService } from "../execution/run-service";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import type { ExecutionRunV4, PreparationAttemptV1 } from "../execution/types";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { createTrustedSepoliaRpcClient } from "../rpc";
import { ExecutionV4Orchestrator } from "./v4-service";
import {
  calculatePreparationFingerprintV1,
  upgradePreparedRunToV4,
} from "../execution/v4-transitions";
import {
  TOKENIZE_ALLOWED_DESTINATION,
  TOKENIZE_CALLDATA_COMMITMENT,
  TOKENIZE_EXECUTION_GATE,
  TOKENIZE_FUNCTION_SIGNATURE,
  TokenizeOnlySemanticAuthorizationEvaluator,
  TokenizePolicyConfigurationError,
  createProductionSemanticAuthorizationEvaluator,
  readTokenizeSemanticAuthorizationPolicy,
  type TokenizeSemanticAuthorizationPolicy,
} from "./tokenize-semantic-authorization";

const DESTINATION = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const SIGNATURE = "function createTokenization(bytes)";
const SELECTOR = toFunctionSelector(SIGNATURE).toLowerCase() as `0x${string}`;
const DATA = `${SELECTOR}${"00".repeat(32)}`;

const unsignedTransaction = Object.freeze({
  from: TOKENIZER_ADDRESS,
  to: DESTINATION,
  value: "0x0",
  nonce: "0x5",
  chainId: 11155111,
  data: DATA,
  type: 2,
  maxPriorityFeePerGas: "0x2",
  maxFeePerGas: "0x20",
  gasLimit: "0x5208",
});

async function fixture() {
  let id = 0;
  const repository = new InMemoryExecutionRunRepository();
  const service = new ExecutionRunService({
    repository,
    clock: { nowIso: () => `2026-09-12T12:00:0${id++}.000Z` },
    ids: {
      runId: () => "11111111-1111-4111-8111-111111111111",
      operationId: () => `operation-${id++}`,
      eventId: () => `event-${id++}`,
    },
  });
  const manifest = validateAssetManifestV1(createValidRawManifest());
  if (!manifest.ok) throw new Error("invalid fixture");
  const created = await service.createRun(manifest.value);
  const approved = await service.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, "2026-09-12T12:00:01.000Z"),
  });
  const preparing = await service.beginPrepare(approved.id, approved.revision, "TOKENIZE");
  const prepared = await service.recordPrepared(preparing.id, preparing.revision, "TOKENIZE", {
    txId: "brickken-tx-1",
    unsignedTransaction: { ...unsignedTransaction },
  });
  const run = await upgradePreparedRunToV4(prepared, "TOKENIZE", {
    attemptId: "attempt-1",
    freshnessPolicyVersion: "edict-freshness-v1",
  });
  const commitment = await sha256Utf8(DATA);
  const policy: TokenizeSemanticAuthorizationPolicy = Object.freeze({
    policyVersion: "edict-tokenize-semantic-v1",
    allowedDestination: DESTINATION,
    reviewedFunctionSignature: SIGNATURE,
    allowedSelector: SELECTOR,
    allowedCalldataCommitment: commitment,
    brickkenMethod: "newTokenization",
    executionMode: "client-broadcast",
  });
  return {
    run,
    prepared,
    repository,
    policy,
    evaluator: new TokenizeOnlySemanticAuthorizationEvaluator(policy),
  };
}

function active(run: ExecutionRunV4): PreparationAttemptV1 {
  const attempt = run.operations[0].preparationAttempts.find(
    (value) => value.attemptId === run.operations[0].activePreparationAttemptId,
  );
  if (!attempt) throw new Error("missing active attempt");
  return attempt;
}

function replaceActive(run: ExecutionRunV4, attempt: PreparationAttemptV1): ExecutionRunV4 {
  const operation = {
    ...run.operations[0],
    preparedTxId: attempt.txId,
    unsignedTransaction: attempt.unsignedTransaction,
    preparationAttempts: run.operations[0].preparationAttempts.map((value) =>
      value.attemptId === attempt.attemptId ? attempt : value),
  };
  return { ...run, operations: [operation, run.operations[1], run.operations[2]] };
}

async function withAttempt(
  run: ExecutionRunV4,
  patch: Partial<PreparationAttemptV1>,
  recalculate = false,
): Promise<ExecutionRunV4> {
  let attempt = { ...active(run), ...patch } as PreparationAttemptV1;
  let next = replaceActive(run, attempt);
  if (recalculate && attempt.txId && attempt.preparedAt && attempt.preparedRunRevision !== null) {
    attempt = {
      ...attempt,
      preparationFingerprint: await calculatePreparationFingerprintV1({
        run: next,
        kind: "TOKENIZE",
        attemptId: attempt.attemptId,
        txId: attempt.txId,
        preparedAt: attempt.preparedAt,
        preparedRunRevision: attempt.preparedRunRevision,
        immutableIdentity: attempt.immutableIdentity,
        feeAuthorization: attempt.feeAuthorization,
      }),
    };
    next = replaceActive(next, attempt);
  }
  return next;
}

async function decision(
  evaluator: TokenizeOnlySemanticAuthorizationEvaluator,
  run: ExecutionRunV4,
  kind: "TOKENIZE" | "WHITELIST" | "MINT" = "TOKENIZE",
) {
  return evaluator.evaluate({ run, kind, attempt: active(run) });
}

describe("TOKENIZE semantic activation config", () => {
  it.each([undefined, "0", "true", "random"])("keeps gate value %s deny-all", async (value) => {
    const evaluator = createProductionSemanticAuthorizationEvaluator({
      [TOKENIZE_EXECUTION_GATE]: value,
    });
    expect(evaluator.isProductionDenyAll).toBe(true);
    await expect(evaluator.evaluate({} as never)).resolves.toEqual({
      authorized: false,
      reason: "TOKENIZE_GATE_DISABLED",
    });
  });

  it("activates only for exact gate value plus complete canonical policy", async () => {
    const { policy } = await fixture();
    const config = readTokenizeSemanticAuthorizationPolicy({
      [TOKENIZE_EXECUTION_GATE]: "1",
      [TOKENIZE_ALLOWED_DESTINATION]: policy.allowedDestination.toUpperCase().replace("0X", "0x"),
      [TOKENIZE_FUNCTION_SIGNATURE]: policy.reviewedFunctionSignature,
      [TOKENIZE_CALLDATA_COMMITMENT]: policy.allowedCalldataCommitment,
    });
    expect(config).toEqual({ enabled: true, policy });
    expect(createProductionSemanticAuthorizationEvaluator({
      [TOKENIZE_EXECUTION_GATE]: "1",
      [TOKENIZE_ALLOWED_DESTINATION]: policy.allowedDestination,
      [TOKENIZE_FUNCTION_SIGNATURE]: policy.reviewedFunctionSignature,
      [TOKENIZE_CALLDATA_COMMITMENT]: policy.allowedCalldataCommitment,
    })).toBeInstanceOf(TokenizeOnlySemanticAuthorizationEvaluator);
  });

  it("fails closed for missing policy and rejects any NEXT_PUBLIC gate", async () => {
    const evaluator = createProductionSemanticAuthorizationEvaluator({
      [TOKENIZE_EXECUTION_GATE]: "1",
    });
    expect(evaluator.isProductionDenyAll).toBe(true);
    await expect(evaluator.evaluate({} as never)).resolves.toEqual({
      authorized: false,
      reason: "POLICY_CONFIG_INVALID",
    });
    expect(() => readTokenizeSemanticAuthorizationPolicy({
      NEXT_PUBLIC_EDICT_TOKENIZE_EXECUTION_ENABLED: "1",
    })).toThrow(TokenizePolicyConfigurationError);
  });
});

describe("TOKENIZE-only semantic authorization", () => {
  it("authorizes the exact durable TOKENIZE identity and binds every authority field", async () => {
    const { run, evaluator, policy } = await fixture();
    const result = await decision(evaluator, run);
    expect(result).toMatchObject({
      authorized: true,
      semanticAuthorization: {
        policyVersion: "edict-tokenize-semantic-v1",
        brickkenMethod: "newTokenization",
        executionMode: "client-broadcast",
        destinationPolicy: { reviewedDestination: DESTINATION },
        selectorPolicy: { reviewedSelector: policy.allowedSelector },
        calldataCommitment: policy.allowedCalldataCommitment,
      },
    });
    expect(result.authorized && result.semanticAuthorization.authorizationId)
      .toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("re-evaluates exact state and releases an envelope only after the existing durable CAS", async () => {
    const { prepared, repository, evaluator } = await fixture();
    let event = 0;
    const orchestrator = new ExecutionV4Orchestrator({
      repository,
      semanticAuthorization: evaluator,
      clock: { nowIso: () => `2026-09-12T13:00:0${event++}.000Z` },
      ids: {
        runId: () => prepared.id,
        operationId: () => `operation-full-${event++}`,
        eventId: () => `event-full-${event++}`,
        invocationAttemptId: () => "invocation-full-1",
      },
      rpc: createTrustedSepoliaRpcClient({
        request: async (method, params) => {
          if (method === "eth_chainId") return "0xaa36a7";
          if (method === "eth_getTransactionCount") return "0x5";
          if (method === "eth_getBalance") return "0x1000000000000000";
          if (method === "eth_getBlockByNumber" && params?.[0] === "latest") {
            return {
              number: "0x10",
              hash: `0x${"ab".repeat(32)}`,
              parentHash: `0x${"cd".repeat(32)}`,
              baseFeePerGas: "0x10",
            };
          }
          throw new Error("unexpected RPC method");
        },
      }),
    });
    const promoted = await orchestrator.promotePreparedRunToV4(prepared.id, prepared.revision);
    const { envelope, run: released } = await orchestrator.releaseSendAuthority(
      promoted.id,
      promoted.revision,
    );
    expect(envelope.walletRequest).toEqual(expect.objectContaining({
      from: TOKENIZER_ADDRESS,
      to: DESTINATION,
      data: DATA,
      nonce: "0x5",
    }));
    expect(released.operations[0].walletPromptAuthorization?.providerInvocation)
      .toBe("INVOKED_OR_UNKNOWN");
    await expect(orchestrator.releaseSendAuthority(released.id, released.revision)).rejects.toThrow();
  });

  it.each(["WHITELIST", "MINT"] as const)("hard-denies %s", async (kind) => {
    const { run, evaluator } = await fixture();
    await expect(decision(evaluator, run, kind)).resolves.toEqual({
      authorized: false,
      reason: "WRONG_OPERATION",
    });
  });

  it("fails closed for an unknown runtime operation", async () => {
    const { run, evaluator } = await fixture();
    await expect(evaluator.evaluate({
      run,
      kind: "UNKNOWN" as never,
      attempt: active(run),
    })).resolves.toEqual({ authorized: false, reason: "WRONG_OPERATION" });
  });

  it("denies wrong chain, approval, manifest, plan, active attempt, txId, and fingerprint", async () => {
    const { run, evaluator } = await fixture();
    const cases: Array<[ExecutionRunV4, string]> = [
      [{ ...run, chainId: "1" as never }, "WRONG_CHAIN"],
      [{ ...run, approval: { ...run.approval, planHash: `sha256:${"0".repeat(64)}` } }, "APPROVAL_MISMATCH"],
      [{ ...run, manifestHash: `sha256:${"0".repeat(64)}`, approval: {
        ...run.approval,
        proof: { ...run.approval.proof, manifestHash: `sha256:${"0".repeat(64)}` },
      } }, "MANIFEST_MISMATCH"],
      [{ ...run, planHash: `sha256:${"0".repeat(64)}`, plan: {
        ...run.plan, planHash: `sha256:${"0".repeat(64)}`,
      }, approval: { ...run.approval, planHash: `sha256:${"0".repeat(64)}`, proof: {
        ...run.approval.proof, planHash: `sha256:${"0".repeat(64)}`,
      } } }, "PLAN_MISMATCH"],
      [await withAttempt(run, { state: "STALE" }), "PREPARATION_MISMATCH"],
      [await withAttempt(run, { txId: "wrong-tx" }), "PREPARATION_MISMATCH"],
      [await withAttempt(run, { preparationFingerprint: `sha256:${"0".repeat(64)}` }), "PREPARATION_MISMATCH"],
    ];
    for (const [candidate, reason] of cases) {
      await expect(decision(evaluator, candidate)).resolves.toEqual({ authorized: false, reason });
    }
  });

  it("denies signer and all six immutable-field tampering through exact projection/fingerprint binding", async () => {
    const { run, evaluator } = await fixture();
    const original = active(run);
    const fields = [
      ["from", OTHER],
      ["to", OTHER],
      ["data", `${SELECTOR}${"11".repeat(32)}`],
      ["value", "0x1"],
      ["nonce", "0x6"],
      ["chainId", "1"],
    ] as const;
    for (const [field, value] of fields) {
      const candidate = await withAttempt(run, {
        immutableIdentity: { ...original.immutableIdentity!, [field]: value },
      });
      await expect(decision(evaluator, candidate)).resolves.toMatchObject({ authorized: false });
    }
  });

  it("returns bounded destination, selector, calldata, and fee denials", async () => {
    const { run, policy } = await fixture();
    const wrongDestination = new TokenizeOnlySemanticAuthorizationEvaluator({
      ...policy,
      allowedDestination: OTHER,
    });
    await expect(decision(wrongDestination, run)).resolves.toEqual({
      authorized: false,
      reason: "DESTINATION_NOT_ALLOWED",
    });
    const wrongSelector = new TokenizeOnlySemanticAuthorizationEvaluator({
      ...policy,
      reviewedFunctionSignature: "function other(bytes)",
      allowedSelector: toFunctionSelector("function other(bytes)"),
    });
    await expect(decision(wrongSelector, run)).resolves.toEqual({
      authorized: false,
      reason: "SELECTOR_NOT_ALLOWED",
    });
    const wrongCalldata = new TokenizeOnlySemanticAuthorizationEvaluator({
      ...policy,
      allowedCalldataCommitment: `sha256:${"0".repeat(64)}`,
    });
    await expect(decision(wrongCalldata, run)).resolves.toEqual({
      authorized: false,
      reason: "CALLDATA_COMMITMENT_MISMATCH",
    });

    const attempt = active(run);
    const invalidFees = {
      ...attempt.feeAuthorization!,
      authorizedCaps: { ...attempt.feeAuthorization!.authorizedCaps, maxFeePerGas: "0x21" },
    };
    const feeRun = await withAttempt(run, { feeAuthorization: invalidFees }, true);
    await expect(decision(new TokenizeOnlySemanticAuthorizationEvaluator(policy), feeRun))
      .resolves.toEqual({ authorized: false, reason: "FEE_AUTHORIZATION_INVALID" });
  });

  it("invalidates the old decision across revision and exact repreparation identity", async () => {
    const { run, evaluator } = await fixture();
    const first = await decision(evaluator, run);
    const revised = { ...run, revision: run.revision + 1 };
    const second = await decision(evaluator, revised);
    expect(first.authorized && first.semanticAuthorization.authorizationId)
      .not.toBe(second.authorized && second.semanticAuthorization.authorizationId);

    const prior = active(run);
    const nextUnsigned = { ...prior.unsignedTransaction!, nonce: "0x6" };
    let nextAttempt: PreparationAttemptV1 = {
      ...prior,
      attemptId: "attempt-2",
      sequence: 2,
      txId: "brickken-tx-2",
      unsignedTransaction: nextUnsigned,
      immutableIdentity: { ...prior.immutableIdentity!, nonce: "0x6" },
      preparedAt: "2026-09-12T14:00:00.000Z",
      preparedRunRevision: run.revision + 2,
      preparationFingerprint: null,
    };
    let reprepared: ExecutionRunV4 = {
      ...run,
      revision: run.revision + 3,
      operations: [{
        ...run.operations[0],
        preparedTxId: nextAttempt.txId,
        unsignedTransaction: nextUnsigned,
        activePreparationAttemptId: nextAttempt.attemptId,
        preparationAttempts: [{ ...prior, state: "STALE" }, nextAttempt],
      }, run.operations[1], run.operations[2]],
    };
    nextAttempt = {
      ...nextAttempt,
      preparationFingerprint: await calculatePreparationFingerprintV1({
        run: reprepared,
        kind: "TOKENIZE",
        attemptId: nextAttempt.attemptId,
        txId: nextAttempt.txId!,
        preparedAt: nextAttempt.preparedAt!,
        preparedRunRevision: nextAttempt.preparedRunRevision!,
        immutableIdentity: nextAttempt.immutableIdentity,
        feeAuthorization: nextAttempt.feeAuthorization,
      }),
    };
    reprepared = {
      ...reprepared,
      operations: [{
        ...reprepared.operations[0],
        preparationAttempts: [{ ...prior, state: "STALE" }, nextAttempt],
      }, reprepared.operations[1], reprepared.operations[2]],
    };
    const third = await decision(evaluator, reprepared);
    expect(third.authorized).toBe(true);
    expect(first.authorized && first.semanticAuthorization.authorizationId)
      .not.toBe(third.authorized && third.semanticAuthorization.authorizationId);
  });
});
