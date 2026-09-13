import { sha256Utf8, validateAssetManifestV1 } from "@/core";
import { TOKENIZER_ADDRESS, createValidRawManifest } from "@/core/test-fixtures";
import type { SemanticAuthorizationV1 } from "@/shared/wallet/execution-authorization";
import { describe, expect, it } from "vitest";
import { decodeExecutionRunV1, encodeExecutionRunV1 } from "../persistence/codec";
import { IllegalStateTransitionError } from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import {
  compareWalletRequestToRpcTransaction,
  createTransactionReceiptEvidence,
  type TransactionReceiptEvidenceV1,
} from "./onchain-evidence";
import { InMemoryExecutionRunRepository } from "./repository";
import { ExecutionRunService } from "./run-service";
import { createApprovalProofFixture } from "./test-fixtures";
import type { ExecutionRun, ExecutionRunV4, NonceFreshnessEvidenceV1 } from "./types";
import {
  authorizeCorrelationRetryV4,
  authorizeProviderInvocationV4,
  beginBrickkenCorrelationV4,
  beginReprepareV4,
  markPreparedStaleV4,
  recordBrickkenCorrelatedV4,
  recordBrickkenStatusEvidenceV4,
  recordBroadcastHashV4,
  recordBroadcastUnknownV4,
  recordCorrelationUncertainV4,
  recordRepreparedV4,
  recordReprepareOutcomeV4,
  recordRpcTransactionV4,
  recordRpcReceiptEvidenceV4,
  recordTokenIdentityFromReadBackV4,
  recordWalletPromptAuthorizationV4,
  recordWalletRejectedV4,
  upgradePreparedRunToV4,
} from "./v4-transitions";

const TO = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"ab".repeat(32)}`;
const UNSIGNED = {
  from: TOKENIZER_ADDRESS,
  to: TO,
  value: "0x0",
  nonce: "0x1",
  chainId: "0xaa36a7",
  data: "0x12345678aabb",
  type: "0x2",
  maxPriorityFeePerGas: "0x4",
  maxFeePerGas: "0x20",
  gasLimit: "0x100",
};
const FOUNDATION = { attemptId: "attempt-1", freshnessPolicyVersion: "nonce-policy-1" };

function harness() {
  let tick = 0;
  let id = 0;
  const clock: Clock = {
    nowIso: () => new Date(Date.UTC(2026, 8, 11, 9, 0, tick++)).toISOString(),
  };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () => `operation-${++id}`,
    eventId: () => `event-${++id}`,
  };
  const service = new ExecutionRunService({
    repository: new InMemoryExecutionRunRepository(),
    clock,
    ids,
  });
  return service;
}

async function preparedRun(): Promise<ExecutionRun> {
  const validation = validateAssetManifestV1(createValidRawManifest());
  if (!validation.ok) throw new Error("fixture manifest invalid");
  const service = harness();
  const created = await service.createRun(validation.value);
  const approved = await service.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, "2026-09-11T09:00:01.000Z"),
  });
  const preparing = await service.beginPrepare(approved.id, approved.revision, "TOKENIZE");
  return service.recordPrepared(preparing.id, preparing.revision, "TOKENIZE", {
    txId: "brickken-tx-1",
    unsignedTransaction: UNSIGNED,
  });
}

async function preparedV3WhitelistRun(): Promise<ExecutionRun> {
  const validation = validateAssetManifestV1(createValidRawManifest());
  if (!validation.ok) throw new Error("fixture manifest invalid");
  const service = harness();
  const created = await service.createRun(validation.value);
  const approved = await service.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, "2026-09-11T09:00:01.000Z"),
  });
  let run = await service.beginPrepare(approved.id, approved.revision, "TOKENIZE");
  run = await service.recordPrepared(run.id, run.revision, "TOKENIZE", {
    txId: "brickken-tokenize",
    unsignedTransaction: UNSIGNED,
  });
  run = await service.recordWalletPrompt(run.id, run.revision, "TOKENIZE");
  run = await service.recordBroadcastHash(run.id, run.revision, "TOKENIZE", TX_HASH);
  const transaction = await compareWalletRequestToRpcTransaction({
    walletRequest: {
      from: TOKENIZER_ADDRESS,
      to: TO,
      data: UNSIGNED.data,
      value: "0x0",
      nonce: "0x1",
      type: "0x2",
      gas: "0x100",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x4",
    },
    expectedChainId: "11155111",
    expectedHash: TX_HASH,
    rpcTransaction: {
      hash: TX_HASH,
      chainId: "0xaa36a7",
      from: TOKENIZER_ADDRESS,
      to: TO,
      input: UNSIGNED.data,
      value: "0x0",
      nonce: "0x1",
      type: "0x2",
      gas: "0x100",
      gasPrice: "0x10",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x4",
      accessList: [],
      blockHash: `0x${"12".repeat(32)}`,
      blockNumber: "0x20",
      transactionIndex: "0x0",
    },
    observedAt: "2026-09-11T09:02:00.000Z",
  });
  run = await service.recordOnchainTransactionEvidence(run.id, run.revision, "TOKENIZE", transaction);
  await service.submitConfirmation(run.id, run.revision, "TOKENIZE");
  run = await service.recordConfirmed(run.id, run.revision + 1, "TOKENIZE");
  const receipt = createTransactionReceiptEvidence({
    transaction,
    rpcReceipt: {
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      blockHash: `0x${"12".repeat(32)}`,
      blockNumber: "0x20",
      from: TOKENIZER_ADDRESS,
      to: TO,
      cumulativeGasUsed: "0xf0",
      gasUsed: "0xf0",
      effectiveGasPrice: "0x10",
      contractAddress: null,
      logs: [],
      logsBloom: "0x",
      type: "0x2",
      status: "0x1",
    },
    observedAt: "2026-09-11T09:02:01.000Z",
    finalizedBlock: { hash: `0x${"34".repeat(32)}`, number: "0x21" },
  });
  run = await service.recordTransactionReceiptEvidence(run.id, run.revision, "TOKENIZE", receipt);
  run = await service.recordReadBackVerified(run.id, run.revision, "TOKENIZE", "TOKEN_INFO");
  run = await service.beginPrepare(run.id, run.revision, "WHITELIST");
  return service.recordPrepared(run.id, run.revision, "WHITELIST", {
    txId: "brickken-whitelist",
    unsignedTransaction: UNSIGNED,
  });
}

function nonceEvidence(status: "FRESH" | "STALE", at: string): NonceFreshnessEvidenceV1 {
  return {
    evidenceVersion: "1.0",
    policyVersion: "nonce-policy-1",
    authority: "TRUSTED_SERVER_RPC",
    rpcMethod: "eth_getTransactionCount",
    blockTag: "pending",
    chainId: "11155111",
    requiredSigner: TOKENIZER_ADDRESS,
    preparedNonce: "0x1",
    observedPendingNonce: status === "FRESH" ? "0x1" : "0x2",
    status,
    observedAt: at,
  };
}

async function semanticAuthorization(): Promise<SemanticAuthorizationV1> {
  return {
    authorizationVersion: "1.0",
    policyVersion: "offline-reviewed-policy-1",
    authorizationId: "offline-authorization-1",
    environment: "sandbox",
    brickkenMethod: "newTokenization",
    executionMode: "client-broadcast",
    destinationPolicy: { policyId: "destination-policy-1", reviewedDestination: TO },
    selectorPolicy: { policyId: "selector-policy-1", reviewedSelector: "0x12345678" },
    calldataCommitment: await sha256Utf8(UNSIGNED.data),
    decision: "ALLOW",
  };
}

async function promptedRun(): Promise<ExecutionRunV4> {
  const at = "2026-09-11T09:10:00.000Z";
  return recordWalletPromptAuthorizationV4({
    run: await preparedRun(),
    kind: "TOKENIZE",
    foundation: FOUNDATION,
    nonceEvidence: nonceEvidence("FRESH", at),
    semanticAuthorization: await semanticAuthorization(),
    id: "v4-prompt",
    at,
  });
}

async function rpcVerifiedRun(): Promise<ExecutionRunV4> {
  const run = await broadcastRecordedRun();
  return recordRpcTransactionV4({
    run,
    kind: "TOKENIZE",
    txHash: TX_HASH,
    immutableIdentity: run.operations[0].preparationAttempts[0]!.immutableIdentity,
    actualFeeFields: actualFees(),
    id: "rpc",
    at: "2026-09-11T09:10:03.000Z",
  });
}

async function broadcastRecordedRun(): Promise<ExecutionRunV4> {
  const run = authorizeProviderInvocationV4({
    run: await promptedRun(), kind: "TOKENIZE", invocationAttemptId: "wallet-send-1",
    id: "invoke", at: "2026-09-11T09:10:01.000Z",
  });
  return recordBroadcastHashV4({
    run, kind: "TOKENIZE", txHash: TX_HASH, id: "hash", at: "2026-09-11T09:10:02.000Z",
  });
}

function actualFees(overrides: Record<string, unknown> = {}) {
  return {
    transactionType: "0x2",
    gasLimit: "0x100",
    maxFeePerGas: "0x20",
    maxPriorityFeePerGas: "0x4",
    accessList: [],
    ...overrides,
  };
}

function receiptEvidence(
  finalityStatus: "INCLUDED" | "FINALIZED",
  executionStatus: "SUCCESS" | "REVERTED" = "SUCCESS",
): TransactionReceiptEvidenceV1 {
  return {
    evidenceVersion: "1.0",
    observedAt: finalityStatus === "FINALIZED"
      ? "2026-09-11T09:32:06.000Z"
      : "2026-09-11T09:32:05.000Z",
    transactionHash: TX_HASH,
    blockHash: `0x${"12".repeat(32)}`,
    blockNumber: "0x20",
    transactionIndex: "0x0",
    from: TOKENIZER_ADDRESS,
    to: TO,
    type: "0x2",
    gasUsed: "0xf0",
    effectiveGasPrice: "0x10",
    contractAddress: null,
    executionStatus,
    identityStatus: "MATCH",
    finalityStatus,
    finalizedBlockHash: finalityStatus === "FINALIZED" ? `0x${"34".repeat(32)}` : null,
    finalizedBlockNumber: finalityStatus === "FINALIZED" ? "0x21" : null,
    reconciliationStatus: "CLEAR",
  };
}

describe("ExecutionRunV4 foundation", () => {
  it("upgrades a prepared V2 only at an explicit V4 operation and strictly round-trips", async () => {
    const v2 = await preparedRun();
    const reread = decodeExecutionRunV1(encodeExecutionRunV1(v2));
    expect(reread.schemaVersion).toBe("2.0");
    const v4 = await upgradePreparedRunToV4(v2, "TOKENIZE", FOUNDATION);
    expect(v2.schemaVersion).toBe("2.0");
    expect(v4.schemaVersion).toBe("4.0");
    expect(v4.operations[0].preparationAttempts).toHaveLength(1);
    const decoded = decodeExecutionRunV1(encodeExecutionRunV1(v4));
    expect(decoded.schemaVersion).toBe("4.0");
    if (decoded.schemaVersion !== "4.0") throw new Error("expected V4");
    expect(Object.isFrozen(decoded.operations[0].preparationAttempts)).toBe(true);
    expect(() => encodeExecutionRunV1({ ...v4, unexpectedV4Field: true })).toThrow();
  });

  it("rejects preparation fingerprint tampering during strict V4 decoding", async () => {
    const v4 = await upgradePreparedRunToV4(await preparedRun(), "TOKENIZE", FOUNDATION);
    const operation = v4.operations[0];
    expect(() => encodeExecutionRunV1({
      ...v4,
      operations: [{
        ...operation,
        preparationAttempts: [{
          ...operation.preparationAttempts[0],
          preparationFingerprint: `sha256:${"f".repeat(64)}`,
        }],
      }, v4.operations[1], v4.operations[2]],
    })).toThrow();
  });

  it("supports an explicit V3 to V4 foundation transition without changing the source run", async () => {
    const v3 = await preparedV3WhitelistRun();
    expect(v3.schemaVersion).toBe("3.0");
    const v4 = await upgradePreparedRunToV4(v3, "WHITELIST", {
      attemptId: "whitelist-attempt-1",
      freshnessPolicyVersion: "nonce-policy-1",
    });
    expect(v3.schemaVersion).toBe("3.0");
    expect(v4.schemaVersion).toBe("4.0");
    expect(v4.operations[0].onchainTransactionEvidence).not.toBeNull();
    expect(v4.operations[1].preparationAttempts).toHaveLength(1);
  });
});

describe("nonce staleness and explicit repreparation", () => {
  it("preserves immutable attempt history across stale and explicit repreparation", async () => {
    const at = "2026-09-11T09:20:00.000Z";
    const stale = await markPreparedStaleV4({
      run: await preparedRun(), kind: "TOKENIZE", foundation: FOUNDATION,
      nonceEvidence: nonceEvidence("STALE", at), id: "stale", at,
    });
    const first = structuredClone(stale.operations[0].preparationAttempts[0]);
    expect(stale.operations[0].stage).toBe("PREPARED_STALE");
    const intent = beginReprepareV4({
      run: stale, kind: "TOKENIZE", attemptId: "attempt-2", id: "reprepare", at: "2026-09-11T09:20:01.000Z",
    });
    const reprepared = await recordRepreparedV4({
      run: intent,
      kind: "TOKENIZE",
      txId: "brickken-tx-2",
      unsignedTransaction: { ...UNSIGNED, nonce: "0x2" },
      id: "reprepared",
      at: "2026-09-11T09:20:02.000Z",
    });
    expect(reprepared.operations[0].stage).toBe("PREPARED");
    expect(reprepared.operations[0].preparationAttempts[0]).toEqual(first);
    expect(reprepared.operations[0].preparationAttempts[1]).toMatchObject({
      attemptId: "attempt-2",
      state: "PREPARED",
      txId: "brickken-tx-2",
    });
    const recovered = decodeExecutionRunV1(encodeExecutionRunV1(reprepared));
    if (recovered.schemaVersion !== "4.0") throw new Error("expected V4");
    expect(Object.isFrozen(recovered.operations[0].preparationAttempts[0])).toBe(true);
  });

  it("allows only an explicit stale preparation to enter repreparation", async () => {
    const v4 = await upgradePreparedRunToV4(await preparedRun(), "TOKENIZE", FOUNDATION);
    expect(() => beginReprepareV4({
      run: v4, kind: "TOKENIZE", attemptId: "attempt-2", id: "bad", at: "2026-09-11T09:20:00.000Z",
    })).toThrow(IllegalStateTransitionError);
    const prompted = await promptedRun();
    expect(() => beginReprepareV4({
      run: prompted, kind: "TOKENIZE", attemptId: "attempt-2", id: "bad", at: "2026-09-11T09:20:00.000Z",
    })).toThrow(IllegalStateTransitionError);
  });

  it.each(["PREPARE_UNKNOWN", "REFUSED"] as const)("records %s from REPREPARE_INTENT", async (outcome) => {
    const at = "2026-09-11T09:21:00.000Z";
    const stale = await markPreparedStaleV4({
      run: await preparedRun(), kind: "TOKENIZE", foundation: FOUNDATION,
      nonceEvidence: nonceEvidence("STALE", at), id: "stale", at,
    });
    const intent = beginReprepareV4({
      run: stale, kind: "TOKENIZE", attemptId: "attempt-2", id: "reprepare", at: "2026-09-11T09:21:01.000Z",
    });
    expect(recordReprepareOutcomeV4({
      run: intent, kind: "TOKENIZE", outcome, id: "outcome", at: "2026-09-11T09:21:02.000Z",
    }).status).toBe(outcome === "REFUSED" ? "FAILED" : "RECONCILIATION_REQUIRED");
  });
});

describe("wallet ambiguity and correlation authority", () => {
  it("records definite cancellation only before send authority is released", async () => {
    const prompted = await promptedRun();
    const rejected = recordWalletRejectedV4({
      run: prompted, kind: "TOKENIZE", id: "reject", at: "2026-09-11T09:30:00.000Z",
    });
    expect(rejected.operations[0].stage).toBe("WALLET_REJECTED");
    expect(rejected.operations[0].walletPromptAuthorization).toMatchObject({
      providerInvocation: "PROVEN_NOT_INVOKED",
      invocationAttemptId: null,
      authorityReleasedAt: null,
    });
  });

  it.each([
    "BROWSER_DISAPPEARED",
    "CLIENT_CLAIMED_NOT_INVOKED",
    "PROVIDER_4001",
    "PROVIDER_TIMEOUT",
  ] as const)("treats authority release followed by %s as ambiguous and permanently locks send", async (reason) => {
    const prompted = await promptedRun();
    const invoked = authorizeProviderInvocationV4({
      run: prompted, kind: "TOKENIZE", invocationAttemptId: "wallet-send-1",
      id: "invoke", at: "2026-09-11T09:30:01.000Z",
    });
    expect(invoked.operations[0].walletPromptAuthorization).toMatchObject({
      providerInvocation: "INVOKED_OR_UNKNOWN",
      invocationAttemptId: "wallet-send-1",
      authorityReleasedAt: "2026-09-11T09:30:01.000Z",
    });
    expect(() => recordWalletRejectedV4({
      run: invoked, kind: "TOKENIZE", id: "reject", at: "2026-09-11T09:30:02.000Z",
    })).toThrow(IllegalStateTransitionError);
    const unknown = recordBroadcastUnknownV4({
      run: invoked, kind: "TOKENIZE", reason,
      id: "unknown", at: "2026-09-11T09:30:03.000Z",
    });
    expect(unknown.operations[0].stage).toBe("BROADCAST_UNKNOWN");
    expect(unknown.status).toBe("RECONCILIATION_REQUIRED");
    expect(unknown.operations[0].walletPromptAuthorization?.unresolvedOutcome).toBe(reason);
    expect(() => authorizeProviderInvocationV4({
      run: unknown, kind: "TOKENIZE", invocationAttemptId: "wallet-send-2",
      id: "invoke-again", at: "2026-09-11T09:30:04.000Z",
    })).toThrow(IllegalStateTransitionError);
  });

  it("requires exact immutable RPC identity and fee authorization", async () => {
    const valid = await rpcVerifiedRun();
    expect(valid.operations[0].stage).toBe("RPC_TRANSACTION_VERIFIED");
    expect(valid.operations[0].rpcTransactionEvidence).toMatchObject({
      immutableIdentityStatus: "MATCH",
      feeAuthorizationStatus: "WITHIN_ENVELOPE",
      feePolicyViolationCode: null,
      observedMaximumNetworkFeeWei: "0x2000",
    });

    const hashed = await broadcastRecordedRun();
    const expected = hashed.operations[0].preparationAttempts[0]!.immutableIdentity!;
    for (const immutableIdentity of [
      { ...expected, chainId: "1" },
      { ...expected, from: "0x2222222222222222222222222222222222222222" },
      { ...expected, to: "0x5555555555555555555555555555555555555555" },
      { ...expected, data: "0x12345678aabc" },
      { ...expected, value: "0x1" },
      { ...expected, nonce: "0x2" },
    ]) {
      const mismatch = recordRpcTransactionV4({
        run: hashed,
        kind: "TOKENIZE",
        txHash: TX_HASH,
        immutableIdentity,
        actualFeeFields: {
          transactionType: "0x2", gasLimit: "0x100", maxFeePerGas: "0x20",
          maxPriorityFeePerGas: "0x4", accessList: [],
        },
        id: "mismatch",
        at: "2026-09-11T09:31:02.000Z",
      });
      expect(mismatch.status).toBe("RECONCILIATION_REQUIRED");
      expect(mismatch.operations[0]).toMatchObject({
        stage: "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
        blockchainTxHash: TX_HASH,
        rpcTransactionEvidence: {
          immutableIdentityStatus: "MISMATCH",
          feeAuthorizationStatus: "NOT_EVALUATED",
        },
      });
      expect(() => beginBrickkenCorrelationV4({
        run: mismatch, kind: "TOKENIZE", id: "forbidden-correlation",
        at: "2026-09-11T09:31:03.000Z",
      })).toThrow(IllegalStateTransitionError);
    }
  });

  it.each([
    ["gasLimit", "0x101", "GAS_LIMIT_CAP_EXCEEDED"],
    ["maxFeePerGas", "0x21", "MAX_FEE_CAP_EXCEEDED"],
    ["maxPriorityFeePerGas", "0x5", "PRIORITY_FEE_CAP_EXCEEDED"],
  ] as const)("persists matching identity with excessive %s as an on-chain policy violation", async (
    field,
    value,
    code,
  ) => {
    const hashed = await broadcastRecordedRun();
    const violated = recordRpcTransactionV4({
      run: hashed,
      kind: "TOKENIZE",
      txHash: TX_HASH,
      immutableIdentity: hashed.operations[0].preparationAttempts[0]!.immutableIdentity,
      actualFeeFields: actualFees({ [field]: value }),
      id: `fee-${field}`,
      at: "2026-09-11T09:32:00.000Z",
    });
    expect(violated.status).toBe("RECONCILIATION_REQUIRED");
    expect(violated.operations[0]).toMatchObject({
      stage: "POLICY_VIOLATION_ONCHAIN",
      blockchainTxHash: TX_HASH,
      rpcTransactionEvidence: {
        immutableIdentityStatus: "MATCH",
        feeAuthorizationStatus: "POLICY_VIOLATION",
        feePolicyViolationCode: code,
      },
    });
    expect(() => authorizeProviderInvocationV4({
      run: violated, kind: "TOKENIZE", invocationAttemptId: "wallet-send-2",
      id: "send-again", at: "2026-09-11T09:32:01.000Z",
    })).toThrow(IllegalStateTransitionError);
    expect(decodeExecutionRunV1(encodeExecutionRunV1({
      ...violated,
      revision: violated.revision + 1,
    }))).toMatchObject({ schemaVersion: "4.0", status: "RECONCILIATION_REQUIRED" });
  });

  it("continues same-pair correlation and receipt/finality evidence after fee violation without advancing", async () => {
    const hashed = await broadcastRecordedRun();
    let run = recordRpcTransactionV4({
      run: hashed,
      kind: "TOKENIZE",
      txHash: TX_HASH,
      immutableIdentity: hashed.operations[0].preparationAttempts[0]!.immutableIdentity,
      actualFeeFields: actualFees({ gasLimit: "0x101" }),
      id: "fee-violation",
      at: "2026-09-11T09:32:00.000Z",
    });
    run = beginBrickkenCorrelationV4({
      run, kind: "TOKENIZE", id: "correlate", at: "2026-09-11T09:32:01.000Z",
    });
    const pair = run.operations[0].brickkenCorrelation!.pair;
    expect(pair).toEqual({ txId: "brickken-tx-1", txHash: TX_HASH });
    expect(run.status).toBe("RECONCILIATION_REQUIRED");
    run = recordBrickkenCorrelatedV4({
      run, kind: "TOKENIZE", pair, id: "correlated", at: "2026-09-11T09:32:02.000Z",
    });
    run = recordBrickkenStatusEvidenceV4({
      run,
      kind: "TOKENIZE",
      evidence: {
        evidenceVersion: "1.0",
        observedAt: "2026-09-11T09:32:03.000Z",
        txId: pair.txId,
        txHash: pair.txHash,
        status: "rejected",
      },
      id: "status",
    });
    run = recordRpcReceiptEvidenceV4({
      run, kind: "TOKENIZE", evidence: receiptEvidence("INCLUDED"), id: "included",
    });
    run = recordRpcReceiptEvidenceV4({
      run, kind: "TOKENIZE", evidence: receiptEvidence("FINALIZED"), id: "finalized",
    });
    expect(run.operations[0].transactionReceiptEvidence?.finalityStatus).toBe("FINALIZED");
    expect(run.operations[0].brickkenStatus).toBe("rejected");
    expect(run.status).toBe("RECONCILIATION_REQUIRED");
    expect(run.phase).toBe("TOKENIZATION");
    expect(() => recordTokenIdentityFromReadBackV4({
      run,
      readBack: {
        chainId: "11155111",
        tokenAddress: "0x6666666666666666666666666666666666666666",
        tokenSymbol: run.manifest.asset.symbol,
        tokenizerWalletAddress: TOKENIZER_ADDRESS,
        tokenizationTxHash: TX_HASH,
        manifestHash: run.manifestHash,
        planHash: run.planHash,
        verifiedAt: "2026-09-11T09:32:07.000Z",
        readBackEvidenceHash: `sha256:${"9".repeat(64)}`,
      },
      id: "blocked-read-back",
    })).toThrow(IllegalStateTransitionError);
  });

  it("persists revert evidence after a fee violation without treating evidence as approval", async () => {
    const hashed = await broadcastRecordedRun();
    const violated = recordRpcTransactionV4({
      run: hashed, kind: "TOKENIZE", txHash: TX_HASH,
      immutableIdentity: hashed.operations[0].preparationAttempts[0]!.immutableIdentity,
      actualFeeFields: actualFees({ maxFeePerGas: "0x21" }),
      id: "fee-violation", at: "2026-09-11T09:32:00.000Z",
    });
    const observed = recordRpcReceiptEvidenceV4({
      run: violated,
      kind: "TOKENIZE",
      evidence: receiptEvidence("FINALIZED", "REVERTED"),
      id: "revert",
    });
    expect(observed.status).toBe("RECONCILIATION_REQUIRED");
    expect(observed.terminalOutcome).toBeNull();
    expect(observed.operations[0].transactionReceiptEvidence).toMatchObject({
      executionStatus: "REVERTED",
      finalityStatus: "FINALIZED",
    });
  });

  it("authorizes only bounded retries for the immutable correlation pair", async () => {
    const pending = beginBrickkenCorrelationV4({
      run: await rpcVerifiedRun(), kind: "TOKENIZE", id: "correlate", at: "2026-09-11T09:40:00.000Z",
    });
    const pair = pending.operations[0].brickkenCorrelation!.pair;
    expect(pair).toEqual({ txId: "brickken-tx-1", txHash: TX_HASH });
    expect(() => authorizeCorrelationRetryV4({
      run: pending, kind: "TOKENIZE", pair: { ...pair, txId: "changed" },
      id: "bad", at: "2026-09-11T09:40:01.000Z",
    })).toThrow(IllegalStateTransitionError);
    expect(() => authorizeCorrelationRetryV4({
      run: pending, kind: "TOKENIZE", pair: { ...pair, txHash: `0x${"cd".repeat(32)}` },
      id: "bad", at: "2026-09-11T09:40:01.000Z",
    })).toThrow(IllegalStateTransitionError);
    let uncertain = recordCorrelationUncertainV4({
      run: pending, kind: "TOKENIZE", pair, result: "TEMPORARILY_NOT_FOUND",
      id: "uncertain-1", at: "2026-09-11T09:40:01.000Z",
    });
    uncertain = authorizeCorrelationRetryV4({
      run: uncertain, kind: "TOKENIZE", pair, id: "retry-2", at: "2026-09-11T09:40:02.000Z",
    });
    uncertain = recordCorrelationUncertainV4({
      run: uncertain, kind: "TOKENIZE", pair, result: "TRANSPORT_UNKNOWN",
      id: "uncertain-2", at: "2026-09-11T09:40:03.000Z",
    });
    uncertain = authorizeCorrelationRetryV4({
      run: uncertain, kind: "TOKENIZE", pair, id: "retry-3", at: "2026-09-11T09:40:04.000Z",
    });
    uncertain = recordCorrelationUncertainV4({
      run: uncertain, kind: "TOKENIZE", pair, result: "TRANSPORT_UNKNOWN",
      id: "uncertain-3", at: "2026-09-11T09:40:05.000Z",
    });
    expect(() => authorizeCorrelationRetryV4({
      run: uncertain, kind: "TOKENIZE", pair, id: "retry-4", at: "2026-09-11T09:40:06.000Z",
    })).toThrow(IllegalStateTransitionError);
    expect(recordBrickkenCorrelatedV4({
      run: uncertain, kind: "TOKENIZE", pair, id: "correlated", at: "2026-09-11T09:40:07.000Z",
    }).operations[0].stage).toBe("BRICKKEN_CORRELATED");
  });

  it("detects wallet-authority tampering in strict persistence", async () => {
    const prompted = await promptedRun();
    const persistedRevision = prompted.revision + 1;
    const original = prompted.operations[0].walletPromptAuthorization!.walletIntent;
    const tampered = [
      { ...original, planHash: `sha256:${"f".repeat(64)}` },
      { ...original, manifestHash: `sha256:${"e".repeat(64)}` },
      { ...original, approvalIdentity: { ...original.approvalIdentity, approvalRevision: 99 } },
      { ...original, brickkenPreparation: { ...original.brickkenPreparation, preparedTxId: "changed" } },
      {
        ...original,
        brickkenPreparation: {
          ...original.brickkenPreparation,
          preparationFingerprint: `sha256:${"d".repeat(64)}`,
        },
      },
      {
        ...original,
        semanticAuthorization: {
          ...original.semanticAuthorization,
          authorizationId: "changed-authorization",
        },
      },
    ];
    for (const walletIntent of tampered) {
      expect(() => encodeExecutionRunV1({
        ...prompted,
        revision: persistedRevision,
        operations: [{
          ...prompted.operations[0],
          walletPromptAuthorization: {
            ...prompted.operations[0].walletPromptAuthorization!,
            walletIntent,
          },
        }, prompted.operations[1], prompted.operations[2]],
      })).toThrow();
    }
  });

  it("creates TokenIdentityV1 only from strict server read-back evidence", async () => {
    let run = beginBrickkenCorrelationV4({
      run: await rpcVerifiedRun(), kind: "TOKENIZE", id: "correlate", at: "2026-09-11T09:50:00.000Z",
    });
    const pair = run.operations[0].brickkenCorrelation!.pair;
    run = recordBrickkenCorrelatedV4({
      run, kind: "TOKENIZE", pair, id: "correlated", at: "2026-09-11T09:50:01.000Z",
    });
    run = recordBrickkenStatusEvidenceV4({
      run,
      kind: "TOKENIZE",
      evidence: {
        evidenceVersion: "1.0",
        observedAt: "2026-09-11T09:50:02.000Z",
        txId: pair.txId,
        txHash: pair.txHash,
        status: "rejected",
      },
      id: "status",
    });
    run = {
      ...run,
      operations: [{
        ...run.operations[0],
        transactionReceiptEvidence: {
          evidenceVersion: "1.0",
          observedAt: "2026-09-11T09:50:03.000Z",
          transactionHash: TX_HASH,
          blockHash: `0x${"12".repeat(32)}`,
          blockNumber: "0x20",
          transactionIndex: "0x0",
          from: TOKENIZER_ADDRESS,
          to: TO,
          type: "0x2",
          gasUsed: "0xf0",
          effectiveGasPrice: "0x10",
          contractAddress: null,
          executionStatus: "SUCCESS",
          identityStatus: "MATCH",
          finalityStatus: "FINALIZED",
          finalizedBlockHash: `0x${"34".repeat(32)}`,
          finalizedBlockNumber: "0x21",
          reconciliationStatus: "CLEAR",
        },
      }, run.operations[1], run.operations[2]],
    };
    const readBack = {
      chainId: "11155111",
      tokenAddress: "0x6666666666666666666666666666666666666666",
      tokenSymbol: run.manifest.asset.symbol,
      tokenizerWalletAddress: TOKENIZER_ADDRESS,
      tokenizationTxHash: TX_HASH,
      manifestHash: run.manifestHash,
      planHash: run.planHash,
      verifiedAt: "2026-09-11T09:50:04.000Z",
      readBackEvidenceHash: `sha256:${"9".repeat(64)}`,
    };
    expect(() => recordTokenIdentityFromReadBackV4({
      run,
      readBack: { ...readBack, frontendTokenAddress: "0x7777777777777777777777777777777777777777" },
      id: "read-back",
    })).toThrow();
    const verified = recordTokenIdentityFromReadBackV4({ run, readBack, id: "read-back" });
    expect(verified.tokenIdentity?.tokenAddress).toBe(readBack.tokenAddress);
    expect(verified.operations[0].stage).toBe("READ_BACK_VERIFIED");
  });
});
