import "server-only";

import { canonicalizeJson, hashCanonicalJson, sha256Utf8 } from "@/core";
import {
  createInitialFeeAuthorizationV1,
  evaluateFeeAuthorizationV1,
  hashWalletExecutionIntentV1,
  immutableExecutionIdentityV1Schema,
  semanticAuthorizationV1Schema,
  type SemanticAuthorizationV1,
  type WalletExecutionIntentV1,
} from "@/shared/wallet/execution-authorization";
import { projectPreparedTransactionV1 } from "@/shared/wallet/transaction";
import { IllegalStateTransitionError } from "./errors";
import { jsonClone } from "./infrastructure";
import {
  transactionReceiptEvidenceV1Schema,
  type TransactionReceiptEvidenceV1,
} from "./onchain-evidence";
import type {
  AuditEvent,
  BrickkenCorrelationAttemptV1,
  BrickkenStatusEvidenceV1,
  ExecutionRun,
  ExecutionRunV4,
  IsoUtcTimestamp,
  NonceFreshnessEvidenceV1,
  OperationKind,
  PreparationAttemptV1,
  RpcTransactionAuthorizationEvidenceV1,
  TokenIdentityV1,
  WriteOperationV4,
} from "./types";
import {
  brickkenStatusEvidenceV1Schema,
  nonceFreshnessEvidenceV1Schema,
  observedImmutableExecutionIdentityV1Schema,
  tokenIdentityV1Schema,
} from "./v4-contracts";

const HASH = /^sha256:[0-9a-f]{64}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;
const MAX_CORRELATION_ATTEMPTS = 3;
const BROADCAST_UNKNOWN_REASONS = new Set([
  "BROWSER_DISAPPEARED",
  "CLIENT_CLAIMED_NOT_INVOKED",
  "PROVIDER_4001",
  "PROVIDER_TIMEOUT",
  "PROVIDER_ERROR",
  "HASH_PERSISTENCE_UNCONFIRMED",
]);

export interface V4PreparationFoundationInput {
  readonly attemptId: string;
  readonly freshnessPolicyVersion: string;
}

function indexFor(kind: OperationKind): 0 | 1 | 2 {
  if (kind === "TOKENIZE") return 0;
  if (kind === "WHITELIST") return 1;
  return 2;
}

function operationSequence(kind: OperationKind): 1 | 2 | 3 {
  if (kind === "TOKENIZE") return 1;
  if (kind === "WHITELIST") return 2;
  return 3;
}

function methodFor(kind: OperationKind): "newTokenization" | "whitelistUser" | "mintToken" {
  if (kind === "TOKENIZE") return "newTokenization";
  if (kind === "WHITELIST") return "whitelistUser";
  return "mintToken";
}

function clone<T>(value: T): T {
  return jsonClone(value);
}

function appendEvent(
  run: ExecutionRunV4,
  input: { readonly id: string; readonly at: IsoUtcTimestamp; readonly type: string },
  kind: OperationKind,
  actor: AuditEvent["actor"] = "SERVER",
): ExecutionRunV4 {
  return {
    ...run,
    updatedAt: input.at,
    events: [
      ...run.events,
      {
        id: input.id,
        sequence: run.events.length + 1,
        type: input.type,
        at: input.at,
        actor,
        operationKind: kind,
      },
    ],
  };
}

function replaceOperation(
  run: ExecutionRunV4,
  kind: OperationKind,
  operation: WriteOperationV4,
): ExecutionRunV4 {
  const index = indexFor(kind);
  const operations: [WriteOperationV4, WriteOperationV4, WriteOperationV4] = [
    run.operations[0],
    run.operations[1],
    run.operations[2],
  ];
  operations[index] = operation;
  return { ...run, operations };
}

function activeAttempt(operation: WriteOperationV4): PreparationAttemptV1 {
  const attempt = operation.preparationAttempts.find(
    (candidate) => candidate.attemptId === operation.activePreparationAttemptId,
  );
  if (!attempt) throw new IllegalStateTransitionError();
  return attempt;
}

function replaceActiveAttempt(
  operation: WriteOperationV4,
  nextAttempt: PreparationAttemptV1,
): WriteOperationV4 {
  const attempts = operation.preparationAttempts.map((attempt) =>
    attempt.attemptId === nextAttempt.attemptId ? nextAttempt : attempt
  );
  if (attempts.filter((attempt) => attempt.attemptId === nextAttempt.attemptId).length !== 1) {
    throw new IllegalStateTransitionError();
  }
  return { ...operation, preparationAttempts: attempts };
}

function v4OperationFromLegacy(
  operation: ExecutionRun["operations"][number],
): WriteOperationV4 {
  return {
    ...clone(operation),
    onchainTransactionEvidence:
      "onchainTransactionEvidence" in operation ? clone(operation.onchainTransactionEvidence) : null,
    transactionReceiptEvidence:
      "transactionReceiptEvidence" in operation ? clone(operation.transactionReceiptEvidence) : null,
    preparationAttempts: [],
    activePreparationAttemptId: null,
    walletPromptAuthorization: null,
    rpcTransactionEvidence: null,
    brickkenCorrelation: null,
    brickkenStatusEvidence: [],
  };
}

export async function calculatePreparationFingerprintV1(input: {
  readonly run: ExecutionRun | ExecutionRunV4;
  readonly kind: OperationKind;
  readonly attemptId: string;
  readonly txId: string;
  readonly preparedAt: IsoUtcTimestamp;
  readonly preparedRunRevision: number;
  readonly immutableIdentity: PreparationAttemptV1["immutableIdentity"];
  readonly feeAuthorization: PreparationAttemptV1["feeAuthorization"];
}): Promise<`sha256:${string}`> {
  if (input.immutableIdentity === null || input.feeAuthorization === null) {
    throw new IllegalStateTransitionError();
  }
  return (await hashCanonicalJson({
    domain: "edict.preparation-attempt.v1",
    runId: input.run.id,
    runRevision: input.preparedRunRevision,
    approvalRevision: input.run.approval?.approvalRevision,
    manifestHash: input.run.manifestHash,
    planHash: input.run.planHash,
    operation: { id: input.run.operations[indexFor(input.kind)].id, kind: input.kind },
    attemptId: input.attemptId,
    txId: input.txId,
    preparedAt: input.preparedAt,
    immutableIdentity: input.immutableIdentity,
    feeAuthorization: input.feeAuthorization,
  })).hash as `sha256:${string}`;
}

async function preparedAttempt(input: {
  readonly run: ExecutionRun | ExecutionRunV4;
  readonly kind: OperationKind;
  readonly attemptId: string;
  readonly sequence: number;
  readonly txId: string;
  readonly unsignedTransaction: Record<string, unknown>;
  readonly preparedAt: IsoUtcTimestamp;
  readonly freshnessPolicyVersion: string;
}): Promise<PreparationAttemptV1> {
  const normalized = projectPreparedTransactionV1(input.unsignedTransaction);
  const request = normalized.walletRequest;
  if (
    normalized.chainId !== "0xaa36a7" ||
    request.from !== input.run.requiredSigner.walletAddress ||
    request.to === undefined || request.data === undefined || request.value === undefined ||
    request.nonce === undefined || request.gas === undefined || request.type !== "0x2" ||
    request.maxFeePerGas === undefined || request.maxPriorityFeePerGas === undefined ||
    request.gasPrice !== undefined
  ) throw new IllegalStateTransitionError();
  const immutableIdentity = immutableExecutionIdentityV1Schema.parse({
    identityVersion: "1.0",
    chainId: "11155111",
    from: request.from,
    to: request.to,
    data: request.data,
    value: request.value,
    nonce: request.nonce,
  });
  const feeAuthorization = createInitialFeeAuthorizationV1({
    gasLimit: request.gas,
    maxFeePerGas: request.maxFeePerGas,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    preparedAccessList: request.accessList ?? [],
  });
  const preparationFingerprint = await calculatePreparationFingerprintV1({
    run: input.run,
    kind: input.kind,
    attemptId: input.attemptId,
    txId: input.txId,
    preparedAt: input.preparedAt,
    preparedRunRevision: input.run.revision,
    immutableIdentity,
    feeAuthorization,
  });
  return {
    attemptId: input.attemptId,
    sequence: input.sequence,
    state: "PREPARED",
    txId: input.txId,
    unsignedTransaction: clone(input.unsignedTransaction),
    preparationFingerprint,
    immutableIdentity,
    feeAuthorization,
    preparedAt: input.preparedAt,
    preparedRunRevision: input.run.revision,
    freshnessPolicyVersion: input.freshnessPolicyVersion,
    freshnessEvaluatedAt: null,
    nonceFreshnessEvidence: null,
    staleAt: null,
    staleReason: null,
  };
}

export async function upgradePreparedRunToV4(
  rawRun: ExecutionRun,
  kind: OperationKind,
  foundation: V4PreparationFoundationInput,
): Promise<ExecutionRunV4> {
  if (rawRun.schemaVersion === "4.0") return clone(rawRun);
  if (rawRun.approval === null || !("proof" in rawRun.approval)) {
    throw new IllegalStateTransitionError();
  }
  const current = rawRun.operations[indexFor(kind)];
  if (
    current.stage !== "PREPARED" || current.preparedTxId === null ||
    current.unsignedTransaction === null || current.preparedAt === null ||
    current.blockchainTxHash !== null
  ) throw new IllegalStateTransitionError();
  const attempt = await preparedAttempt({
    run: rawRun,
    kind,
    attemptId: foundation.attemptId,
    sequence: 1,
    txId: current.preparedTxId,
    unsignedTransaction: current.unsignedTransaction,
    preparedAt: current.preparedAt,
    freshnessPolicyVersion: foundation.freshnessPolicyVersion,
  });
  const operations = rawRun.operations.map(v4OperationFromLegacy) as unknown as [
    WriteOperationV4,
    WriteOperationV4,
    WriteOperationV4,
  ];
  operations[indexFor(kind)] = {
    ...operations[indexFor(kind)],
    preparationAttempts: [attempt],
    activePreparationAttemptId: attempt.attemptId,
  };
  return {
    ...clone(rawRun),
    schemaVersion: "4.0",
    approval: clone(rawRun.approval),
    operations,
    tokenIdentity: null,
  };
}

function assertNonceEvidence(
  run: ExecutionRunV4,
  kind: OperationKind,
  evidenceRaw: unknown,
  expectedStatus: "FRESH" | "STALE",
): NonceFreshnessEvidenceV1 {
  const evidence = nonceFreshnessEvidenceV1Schema.parse(evidenceRaw);
  const attempt = activeAttempt(run.operations[indexFor(kind)]);
  if (
    attempt.immutableIdentity === null || evidence.status !== expectedStatus ||
    evidence.chainId !== run.chainId || evidence.requiredSigner !== run.requiredSigner.walletAddress ||
    BigInt(evidence.preparedNonce) !== BigInt(attempt.immutableIdentity.nonce)
  ) throw new IllegalStateTransitionError();
  return evidence;
}

export async function markPreparedStaleV4(input: {
  readonly run: ExecutionRun;
  readonly kind: OperationKind;
  readonly foundation: V4PreparationFoundationInput;
  readonly nonceEvidence: unknown;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): Promise<ExecutionRunV4> {
  const run = await upgradePreparedRunToV4(input.run, input.kind, input.foundation);
  const operation = run.operations[indexFor(input.kind)];
  if (operation.stage !== "PREPARED" || operation.walletPromptAuthorization !== null) {
    throw new IllegalStateTransitionError();
  }
  if (input.kind !== "TOKENIZE" && run.tokenIdentity === null) {
    throw new IllegalStateTransitionError();
  }
  const evidence = assertNonceEvidence(run, input.kind, input.nonceEvidence, "STALE");
  if (evidence.observedAt !== input.at) throw new IllegalStateTransitionError();
  const attempt = activeAttempt(operation);
  const nextAttempt: PreparationAttemptV1 = {
    ...attempt,
    state: "STALE",
    freshnessEvaluatedAt: evidence.observedAt,
    nonceFreshnessEvidence: evidence,
    staleAt: input.at,
    staleReason: "NONCE_MISMATCH",
  };
  const nextOperation = {
    ...replaceActiveAttempt(operation, nextAttempt),
    stage: "PREPARED_STALE" as const,
  };
  return appendEvent(
    replaceOperation({ ...run, status: "AWAITING_WALLET" }, input.kind, nextOperation),
    { id: input.id, at: input.at, type: "MARK_PREPARED_STALE" },
    input.kind,
  );
}

export function beginReprepareV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly attemptId: string;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const prior = activeAttempt(operation);
  if (
    operation.stage !== "PREPARED_STALE" || prior.state !== "STALE" ||
    operation.walletPromptAuthorization !== null || operation.blockchainTxHash !== null ||
    operation.preparationAttempts.some((attempt) => attempt.attemptId === input.attemptId)
  ) throw new IllegalStateTransitionError();
  const attempt: PreparationAttemptV1 = {
    attemptId: input.attemptId,
    sequence: operation.preparationAttempts.length + 1,
    state: "REPREPARE_INTENT",
    txId: null,
    unsignedTransaction: null,
    preparationFingerprint: null,
    immutableIdentity: null,
    feeAuthorization: null,
    preparedAt: null,
    preparedRunRevision: null,
    freshnessPolicyVersion: prior.freshnessPolicyVersion,
    freshnessEvaluatedAt: null,
    nonceFreshnessEvidence: null,
    staleAt: null,
    staleReason: null,
  };
  const nextOperation: WriteOperationV4 = {
    ...operation,
    stage: "REPREPARE_INTENT",
    preparedTxId: null,
    unsignedTransaction: null,
    preparedAt: null,
    preparationAttempts: [...operation.preparationAttempts, attempt],
    activePreparationAttemptId: attempt.attemptId,
  };
  return appendEvent(
    replaceOperation({ ...run, status: "PREPARING" }, input.kind, nextOperation),
    { id: input.id, at: input.at, type: "BEGIN_REPREPARE" },
    input.kind,
    "USER",
  );
}

export async function recordRepreparedV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly txId: string;
  readonly unsignedTransaction: Record<string, unknown>;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): Promise<ExecutionRunV4> {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const active = activeAttempt(operation);
  if (operation.stage !== "REPREPARE_INTENT" || active.state !== "REPREPARE_INTENT") {
    throw new IllegalStateTransitionError();
  }
  const attempt = await preparedAttempt({
    run,
    kind: input.kind,
    attemptId: active.attemptId,
    sequence: active.sequence,
    txId: input.txId,
    unsignedTransaction: input.unsignedTransaction,
    preparedAt: input.at,
    freshnessPolicyVersion: active.freshnessPolicyVersion,
  });
  const nextOperation: WriteOperationV4 = {
    ...replaceActiveAttempt(operation, attempt),
    stage: "PREPARED",
    preparedTxId: input.txId,
    unsignedTransaction: clone(input.unsignedTransaction),
    preparedAt: input.at,
  };
  return appendEvent(
    replaceOperation({ ...run, status: "AWAITING_WALLET" }, input.kind, nextOperation),
    { id: input.id, at: input.at, type: "RECORD_REPREPARED" },
    input.kind,
    "BRICKKEN",
  );
}

export function recordReprepareOutcomeV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly outcome: "PREPARE_UNKNOWN" | "REFUSED";
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const active = activeAttempt(operation);
  if (operation.stage !== "REPREPARE_INTENT" || active.state !== "REPREPARE_INTENT") {
    throw new IllegalStateTransitionError();
  }
  const attempt: PreparationAttemptV1 = { ...active, state: input.outcome };
  const nextOperation: WriteOperationV4 = {
    ...replaceActiveAttempt(operation, attempt),
    stage: input.outcome === "PREPARE_UNKNOWN" ? "PREPARE_UNKNOWN" : "REJECTED",
  };
  return appendEvent(
    replaceOperation({
      ...run,
      status: input.outcome === "PREPARE_UNKNOWN" ? "RECONCILIATION_REQUIRED" : "FAILED",
      terminalOutcome: input.outcome === "REFUSED" ? "FAILED" : run.terminalOutcome,
    }, input.kind, nextOperation),
    { id: input.id, at: input.at, type: `RECORD_${input.outcome}` },
    input.kind,
    "BRICKKEN",
  );
}

export async function recordWalletPromptAuthorizationV4(input: {
  readonly run: ExecutionRun;
  readonly kind: OperationKind;
  readonly foundation: V4PreparationFoundationInput;
  readonly nonceEvidence: unknown;
  readonly semanticAuthorization: SemanticAuthorizationV1;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): Promise<ExecutionRunV4> {
  const run = await upgradePreparedRunToV4(input.run, input.kind, input.foundation);
  const operation = run.operations[indexFor(input.kind)];
  if (operation.stage !== "PREPARED" || operation.walletPromptAuthorization !== null) {
    throw new IllegalStateTransitionError();
  }
  if (input.kind !== "TOKENIZE" && run.tokenIdentity === null) {
    throw new IllegalStateTransitionError();
  }
  const attempt = activeAttempt(operation);
  if (
    attempt.txId === null || attempt.preparationFingerprint === null ||
    attempt.immutableIdentity === null || attempt.feeAuthorization === null ||
    run.approval === null
  ) throw new IllegalStateTransitionError();
  const nonceEvidence = assertNonceEvidence(run, input.kind, input.nonceEvidence, "FRESH");
  if (nonceEvidence.observedAt !== input.at) throw new IllegalStateTransitionError();
  const semantic = semanticAuthorizationV1Schema.parse(input.semanticAuthorization);
  if (
    semantic.brickkenMethod !== methodFor(input.kind) ||
    semantic.destinationPolicy.reviewedDestination !== attempt.immutableIdentity.to ||
    semantic.selectorPolicy.reviewedSelector !== attempt.immutableIdentity.data.slice(0, 10) ||
    semantic.calldataCommitment !== await sha256Utf8(attempt.immutableIdentity.data)
  ) throw new IllegalStateTransitionError();
  const walletIntent: WalletExecutionIntentV1 = {
    domain: "edict.wallet-execution-intent.v1",
    runId: run.id,
    runRevision: run.revision + 1,
    approvalIdentity: {
      approvalRevision: run.approval.approvalRevision,
      typedDataDigest: run.approval.proof.typedDataDigest,
    },
    manifestHash: run.manifestHash as `sha256:${string}`,
    planHash: run.planHash as `sha256:${string}`,
    environment: run.environment,
    operation: {
      id: operation.id,
      kind: input.kind,
      sequence: operationSequence(input.kind),
    },
    requiredSigner: run.requiredSigner.walletAddress,
    chainRequirement: {
      decimalChainId: "11155111",
      rpcChainId: "0xaa36a7",
      authority: "TRUSTED_SERVER_RPC",
    },
    immutableIdentity: attempt.immutableIdentity,
    feeAuthorization: attempt.feeAuthorization,
    brickkenPreparation: {
      identityVersion: "1.0",
      method: methodFor(input.kind),
      executionMode: "client-broadcast",
      preparationAttemptId: attempt.attemptId,
      preparedTxId: attempt.txId,
      preparationFingerprint: attempt.preparationFingerprint as `sha256:${string}`,
    },
    semanticAuthorization: semantic,
  };
  const walletIntentHash = (await hashWalletExecutionIntentV1(walletIntent)).hash;
  const nextAttempt: PreparationAttemptV1 = {
    ...attempt,
    freshnessEvaluatedAt: nonceEvidence.observedAt,
    nonceFreshnessEvidence: nonceEvidence,
  };
  const nextOperation: WriteOperationV4 = {
    ...replaceActiveAttempt(operation, nextAttempt),
    stage: "WALLET_PROMPT_RECORDED",
    walletPromptAt: input.at,
    walletPromptAuthorization: {
      authorizationVersion: "1.0",
      walletIntent,
      walletIntentHash,
      providerInvocation: "PROVEN_NOT_INVOKED",
      invocationAttemptId: null,
      authorityReleasedAt: null,
      unresolvedOutcome: null,
      unresolvedAt: null,
      recordedAt: input.at,
    },
  };
  return appendEvent(
    replaceOperation({ ...run, status: "AWAITING_WALLET" }, input.kind, nextOperation),
    { id: input.id, at: input.at, type: "RECORD_V4_WALLET_PROMPT" },
    input.kind,
    "USER",
  );
}

export function authorizeProviderInvocationV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly invocationAttemptId: string;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const prompt = operation.walletPromptAuthorization;
  if (
    operation.stage !== "WALLET_PROMPT_RECORDED" || prompt === null ||
    prompt.providerInvocation !== "PROVEN_NOT_INVOKED" || operation.blockchainTxHash !== null ||
    typeof input.invocationAttemptId !== "string" || input.invocationAttemptId.length === 0 ||
    input.invocationAttemptId.length > 1_024
  ) throw new IllegalStateTransitionError();
  const nextOperation: WriteOperationV4 = {
    ...operation,
    walletPromptAuthorization: {
      ...prompt,
      providerInvocation: "INVOKED_OR_UNKNOWN",
      invocationAttemptId: input.invocationAttemptId,
      authorityReleasedAt: input.at,
    },
  };
  return appendEvent(
    replaceOperation(run, input.kind, nextOperation),
    { id: input.id, at: input.at, type: "AUTHORIZE_PROVIDER_INVOCATION" },
    input.kind,
  );
}

export function recordWalletRejectedV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  if (
    operation.stage !== "WALLET_PROMPT_RECORDED" ||
    operation.walletPromptAuthorization?.providerInvocation !== "PROVEN_NOT_INVOKED"
  ) throw new IllegalStateTransitionError();
  return appendEvent(
    replaceOperation(run, input.kind, { ...operation, stage: "WALLET_REJECTED" }),
    { id: input.id, at: input.at, type: "RECORD_WALLET_REJECTION" },
    input.kind,
    "USER",
  );
}

function assertInvokedPrompt(operation: WriteOperationV4): void {
  if (
    operation.stage !== "WALLET_PROMPT_RECORDED" ||
    operation.walletPromptAuthorization?.providerInvocation !== "INVOKED_OR_UNKNOWN" ||
    operation.blockchainTxHash !== null
  ) throw new IllegalStateTransitionError();
}

export function recordBroadcastUnknownV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly reason:
    | "BROWSER_DISAPPEARED"
    | "CLIENT_CLAIMED_NOT_INVOKED"
    | "PROVIDER_4001"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_ERROR"
    | "HASH_PERSISTENCE_UNCONFIRMED";
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  assertInvokedPrompt(operation);
  if (!BROADCAST_UNKNOWN_REASONS.has(input.reason)) throw new IllegalStateTransitionError();
  return appendEvent(
    replaceOperation({ ...run, status: "RECONCILIATION_REQUIRED" }, input.kind, {
      ...operation,
      stage: "BROADCAST_UNKNOWN",
      walletPromptAuthorization: {
        ...operation.walletPromptAuthorization!,
        unresolvedOutcome: input.reason,
        unresolvedAt: input.at,
      },
    }),
    { id: input.id, at: input.at, type: "RECORD_BROADCAST_UNKNOWN" },
    input.kind,
    "WALLET",
  );
}

export function recordBroadcastHashV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly txHash: string;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  assertInvokedPrompt(operation);
  if (!TX_HASH.test(input.txHash)) throw new IllegalStateTransitionError();
  return appendEvent(
    replaceOperation({ ...run, status: "BROADCAST_RECORDED" }, input.kind, {
      ...operation,
      stage: "BROADCAST_HASH_PERSISTED",
      blockchainTxHash: input.txHash,
      broadcastAt: input.at,
    }),
    { id: input.id, at: input.at, type: "RECORD_BROADCAST_HASH" },
    input.kind,
    "WALLET",
  );
}

export function recordRpcTransactionV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly txHash: string;
  readonly immutableIdentity: unknown;
  readonly actualFeeFields: unknown;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const attempt = activeAttempt(operation);
  if (
    operation.stage !== "BROADCAST_HASH_PERSISTED" || operation.blockchainTxHash !== input.txHash ||
    attempt.immutableIdentity === null || attempt.feeAuthorization === null
  ) throw new IllegalStateTransitionError();
  let observedIdentity: ReturnType<typeof observedImmutableExecutionIdentityV1Schema.parse> | null = null;
  let feeDecision: ReturnType<typeof evaluateFeeAuthorizationV1> | null = null;
  try {
    observedIdentity = observedImmutableExecutionIdentityV1Schema.parse(input.immutableIdentity);
  } catch {
    // A blockchain transaction may exist, so malformed evidence is reconciliation-required.
  }
  if (observedIdentity === null) {
    return appendEvent(
      replaceOperation({ ...run, status: "RECONCILIATION_REQUIRED" }, input.kind, {
        ...operation,
        stage: "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
      }),
      { id: input.id, at: input.at, type: "RECORD_RPC_TRANSACTION_MISMATCH" },
      input.kind,
    );
  }
  const identityMatches = canonicalizeJson(observedIdentity) ===
    canonicalizeJson(attempt.immutableIdentity);
  if (!identityMatches) {
    const evidence: RpcTransactionAuthorizationEvidenceV1 = {
      evidenceVersion: "1.0",
      observedAt: input.at,
      transactionHash: input.txHash,
      immutableIdentity: observedIdentity,
      immutableIdentityStatus: "MISMATCH",
      feeAuthorizationStatus: "NOT_EVALUATED",
      feePolicyViolationCode: null,
      observedMaximumNetworkFeeWei: null,
    };
    return appendEvent(
      replaceOperation({ ...run, status: "RECONCILIATION_REQUIRED" }, input.kind, {
        ...operation,
        stage: "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
        rpcTransactionEvidence: evidence,
      }),
      { id: input.id, at: input.at, type: "RECORD_RPC_TRANSACTION_MISMATCH" },
      input.kind,
    );
  }
  try {
    feeDecision = evaluateFeeAuthorizationV1(attempt.feeAuthorization, input.actualFeeFields);
  } catch {
    // The immutable transaction exists and matches; invalid fee evidence is a policy violation.
  }
  if (feeDecision === null || !feeDecision.accepted) {
    const evidence: RpcTransactionAuthorizationEvidenceV1 = {
      evidenceVersion: "1.0",
      observedAt: input.at,
      transactionHash: input.txHash,
      immutableIdentity: observedIdentity,
      immutableIdentityStatus: "MATCH",
      feeAuthorizationStatus: "POLICY_VIOLATION",
      feePolicyViolationCode: feeDecision?.code ?? "INVALID_FEE_EVIDENCE",
      observedMaximumNetworkFeeWei: null,
    };
    return appendEvent(
      replaceOperation({ ...run, status: "RECONCILIATION_REQUIRED" }, input.kind, {
        ...operation,
        stage: "POLICY_VIOLATION_ONCHAIN",
        rpcTransactionEvidence: evidence,
      }),
      { id: input.id, at: input.at, type: "RECORD_ONCHAIN_FEE_POLICY_VIOLATION" },
      input.kind,
    );
  }
  const evidence: RpcTransactionAuthorizationEvidenceV1 = {
    evidenceVersion: "1.0",
    observedAt: input.at,
    transactionHash: input.txHash,
    immutableIdentity: observedIdentity,
    immutableIdentityStatus: "MATCH",
    feeAuthorizationStatus: "WITHIN_ENVELOPE",
    feePolicyViolationCode: null,
    observedMaximumNetworkFeeWei: feeDecision.maximumNetworkFeeWei,
  };
  return appendEvent(
    replaceOperation({ ...run, status: "BROADCAST_RECORDED" }, input.kind, {
      ...operation,
      stage: "RPC_TRANSACTION_VERIFIED",
      rpcTransactionEvidence: evidence,
    }),
    { id: input.id, at: input.at, type: "RECORD_RPC_TRANSACTION_VERIFIED" },
    input.kind,
  );
}

export function beginBrickkenCorrelationV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const attempt = activeAttempt(operation);
  const rpcEvidence = operation.rpcTransactionEvidence;
  if (
    !["RPC_TRANSACTION_VERIFIED", "POLICY_VIOLATION_ONCHAIN"].includes(operation.stage) ||
    rpcEvidence === null || rpcEvidence.immutableIdentityStatus !== "MATCH" ||
    operation.blockchainTxHash === null || attempt.txId === null || operation.brickkenCorrelation !== null
  ) throw new IllegalStateTransitionError();
  const correlationAttempt: BrickkenCorrelationAttemptV1 = {
    attempt: 1,
    authorizedAt: input.at,
    result: "AUTHORIZED",
  };
  const nextOperation: WriteOperationV4 = {
    ...operation,
    stage: "BRICKKEN_CORRELATION_PENDING",
    brickkenCorrelation: {
      correlationVersion: "1.0",
      pair: { txId: attempt.txId, txHash: operation.blockchainTxHash },
      lifecycle: "PENDING",
      attempts: [correlationAttempt],
      correlatedAt: null,
    },
  };
  return appendEvent(
    replaceOperation({
      ...run,
      status: rpcEvidence.feeAuthorizationStatus === "POLICY_VIOLATION"
        ? "RECONCILIATION_REQUIRED"
        : "CONFIRMING",
    }, input.kind, nextOperation),
    { id: input.id, at: input.at, type: "BEGIN_BRICKKEN_CORRELATION" },
    input.kind,
  );
}

export function recordCorrelationUncertainV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly pair: { readonly txId: string; readonly txHash: string };
  readonly result: "TEMPORARILY_NOT_FOUND" | "TRANSPORT_UNKNOWN";
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const correlation = operation.brickkenCorrelation;
  if (
    operation.stage !== "BRICKKEN_CORRELATION_PENDING" || correlation === null ||
    canonicalizeJson(correlation.pair) !== canonicalizeJson(input.pair) ||
    correlation.lifecycle !== "PENDING"
  ) throw new IllegalStateTransitionError();
  const attempts = [...correlation.attempts];
  const last = attempts.at(-1);
  if (!last || last.result !== "AUTHORIZED") throw new IllegalStateTransitionError();
  attempts[attempts.length - 1] = { ...last, result: input.result };
  return appendEvent(
    replaceOperation(run, input.kind, {
      ...operation,
      brickkenCorrelation: { ...correlation, attempts },
    }),
    { id: input.id, at: input.at, type: "RECORD_BRICKKEN_CORRELATION_UNCERTAIN" },
    input.kind,
    "BRICKKEN",
  );
}

export function authorizeCorrelationRetryV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly pair: { readonly txId: string; readonly txHash: string };
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const correlation = operation.brickkenCorrelation;
  if (
    operation.stage !== "BRICKKEN_CORRELATION_PENDING" || correlation === null ||
    canonicalizeJson(correlation.pair) !== canonicalizeJson(input.pair) ||
    correlation.lifecycle !== "PENDING" || correlation.attempts.length >= MAX_CORRELATION_ATTEMPTS ||
    correlation.attempts.at(-1)?.result === "AUTHORIZED"
  ) throw new IllegalStateTransitionError();
  const nextAttempt: BrickkenCorrelationAttemptV1 = {
    attempt: correlation.attempts.length + 1,
    authorizedAt: input.at,
    result: "AUTHORIZED",
  };
  return appendEvent(
    replaceOperation(run, input.kind, {
      ...operation,
      brickkenCorrelation: {
        ...correlation,
        attempts: [...correlation.attempts, nextAttempt],
      },
    }),
    { id: input.id, at: input.at, type: "AUTHORIZE_BRICKKEN_CORRELATION_RETRY" },
    input.kind,
  );
}

export function recordBrickkenCorrelatedV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly pair: { readonly txId: string; readonly txHash: string };
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const correlation = operation.brickkenCorrelation;
  if (
    operation.stage !== "BRICKKEN_CORRELATION_PENDING" || correlation === null ||
    correlation.lifecycle !== "PENDING" ||
    canonicalizeJson(correlation.pair) !== canonicalizeJson(input.pair)
  ) throw new IllegalStateTransitionError();
  const feePolicyViolated = operation.rpcTransactionEvidence?.feeAuthorizationStatus ===
    "POLICY_VIOLATION";
  return appendEvent(
    replaceOperation({
      ...run,
      status: feePolicyViolated ? "RECONCILIATION_REQUIRED" : "CONFIRMING",
    }, input.kind, {
      ...operation,
      stage: "BRICKKEN_CORRELATED",
      brickkenStatus: "pending",
      brickkenCorrelation: {
        ...correlation,
        lifecycle: "CORRELATED",
        correlatedAt: input.at,
      },
    }),
    { id: input.id, at: input.at, type: "RECORD_BRICKKEN_CORRELATED" },
    input.kind,
    "BRICKKEN",
  );
}

export function recordBrickkenStatusEvidenceV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly evidence: BrickkenStatusEvidenceV1;
  readonly id: string;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const correlation = operation.brickkenCorrelation;
  const evidence = brickkenStatusEvidenceV1Schema.parse(input.evidence);
  if (
    operation.stage !== "BRICKKEN_CORRELATED" || correlation?.lifecycle !== "CORRELATED" ||
    evidence.txId !== correlation.pair.txId || evidence.txHash !== correlation.pair.txHash
  ) throw new IllegalStateTransitionError();
  return appendEvent(
    replaceOperation(run, input.kind, {
      ...operation,
      brickkenStatus: evidence.status,
      brickkenStatusEvidence: [...operation.brickkenStatusEvidence, evidence],
    }),
    { id: input.id, at: evidence.observedAt, type: "RECORD_BRICKKEN_STATUS" },
    input.kind,
    "BRICKKEN",
  );
}

export function recordRpcReceiptEvidenceV4(input: {
  readonly run: ExecutionRunV4;
  readonly kind: OperationKind;
  readonly evidence: TransactionReceiptEvidenceV1;
  readonly id: string;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[indexFor(input.kind)];
  const rpcTransaction = operation.rpcTransactionEvidence;
  const evidence = transactionReceiptEvidenceV1Schema.parse(input.evidence);
  if (
    !["RPC_TRANSACTION_VERIFIED", "POLICY_VIOLATION_ONCHAIN",
      "RPC_TRANSACTION_RECONCILIATION_REQUIRED", "BRICKKEN_CORRELATION_PENDING",
      "BRICKKEN_CORRELATED"].includes(operation.stage) ||
    operation.blockchainTxHash === null || rpcTransaction === null ||
    evidence.transactionHash !== operation.blockchainTxHash ||
    evidence.from !== rpcTransaction.immutableIdentity.from ||
    evidence.to !== rpcTransaction.immutableIdentity.to || evidence.type !== "0x2"
  ) throw new IllegalStateTransitionError();
  const prior = operation.transactionReceiptEvidence;
  if (prior !== null) {
    const sameInclusion = prior.transactionHash === evidence.transactionHash &&
      prior.blockHash === evidence.blockHash && prior.blockNumber === evidence.blockNumber &&
      prior.transactionIndex === evidence.transactionIndex;
    if (!sameInclusion || prior.finalityStatus === "FINALIZED" ||
      evidence.finalityStatus !== "FINALIZED") throw new IllegalStateTransitionError();
  }
  const requiresReconciliation =
    rpcTransaction.immutableIdentityStatus !== "MATCH" ||
    rpcTransaction.feeAuthorizationStatus === "POLICY_VIOLATION" ||
    evidence.identityStatus !== "MATCH" || evidence.reconciliationStatus !== "CLEAR";
  const nextStatus = requiresReconciliation
    ? "RECONCILIATION_REQUIRED"
    : evidence.executionStatus === "REVERTED" ? "FAILED" : run.status;
  return appendEvent(
    replaceOperation({
      ...run,
      status: nextStatus,
      terminalOutcome: requiresReconciliation
        ? run.terminalOutcome
        : evidence.executionStatus === "REVERTED" ? "FAILED" : run.terminalOutcome,
    }, input.kind, { ...operation, transactionReceiptEvidence: evidence }),
    { id: input.id, at: evidence.observedAt, type: "RECORD_V4_RPC_RECEIPT_EVIDENCE" },
    input.kind,
  );
}

const tokenReadBackSchema = tokenIdentityV1Schema.omit({ identityVersion: true }).strict();

export function recordTokenIdentityFromReadBackV4(input: {
  readonly run: ExecutionRunV4;
  readonly readBack: unknown;
  readonly id: string;
}): ExecutionRunV4 {
  const run = clone(input.run);
  const operation = run.operations[0];
  const readBack = tokenReadBackSchema.parse(input.readBack);
  if (
    operation.stage !== "BRICKKEN_CORRELATED" || operation.brickkenCorrelation?.lifecycle !== "CORRELATED" ||
    operation.transactionReceiptEvidence?.executionStatus !== "SUCCESS" ||
    operation.transactionReceiptEvidence.finalityStatus !== "FINALIZED" ||
    operation.rpcTransactionEvidence?.feeAuthorizationStatus !== "WITHIN_ENVELOPE" ||
    run.status === "RECONCILIATION_REQUIRED" ||
    readBack.chainId !== run.chainId || readBack.tokenSymbol !== run.manifest.asset.symbol ||
    readBack.tokenizerWalletAddress !== run.requiredSigner.walletAddress ||
    readBack.tokenizationTxHash !== operation.blockchainTxHash ||
    readBack.manifestHash !== run.manifestHash || readBack.planHash !== run.planHash
  ) throw new IllegalStateTransitionError();
  const tokenIdentity: TokenIdentityV1 = tokenIdentityV1Schema.parse({
    identityVersion: "1.0",
    ...readBack,
  });
  const nextOperation: WriteOperationV4 = {
    ...operation,
    stage: "READ_BACK_VERIFIED",
    verifiedAt: readBack.verifiedAt,
  };
  return appendEvent(
    replaceOperation({
      ...run,
      phase: "WHITELIST",
      status: "PREPARING",
      tokenIdentity,
    }, "TOKENIZE", nextOperation),
    { id: input.id, at: readBack.verifiedAt, type: "RECORD_TOKEN_IDENTITY_FROM_READ_BACK" },
    "TOKENIZE",
  );
}

export function exactCorrelationPairV4(
  run: ExecutionRunV4,
  kind: OperationKind,
): Readonly<{ txId: string; txHash: string }> | null {
  const pair = run.operations[indexFor(kind)].brickkenCorrelation?.pair;
  return pair ? Object.freeze({ ...pair }) : null;
}

export function assertValidPreparationFingerprint(value: string): void {
  if (!HASH.test(value)) throw new IllegalStateTransitionError();
}
