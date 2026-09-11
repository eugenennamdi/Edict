import "server-only";

import {
  feeAuthorizationV1Schema,
  immutableExecutionIdentityV1Schema,
  walletExecutionIntentV1Schema,
} from "@/shared/wallet/execution-authorization";
import { z } from "zod";

const identifier = z.string().min(1).max(1_024);
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const transactionHash = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const quantity = z.string().max(66).regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/);
const isoUtc = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value,
);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().int().safe(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const nonceFreshnessEvidenceV1Schema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  policyVersion: identifier,
  authority: z.literal("TRUSTED_SERVER_RPC"),
  rpcMethod: z.literal("eth_getTransactionCount"),
  blockTag: z.literal("pending"),
  chainId: z.literal("11155111"),
  requiredSigner: address,
  preparedNonce: quantity,
  observedPendingNonce: quantity,
  status: z.enum(["FRESH", "STALE"]),
  observedAt: isoUtc,
}).superRefine((evidence, context) => {
  const equal = BigInt(evidence.preparedNonce) === BigInt(evidence.observedPendingNonce);
  if ((evidence.status === "FRESH") !== equal) {
    context.addIssue({ code: "custom", message: "nonce freshness result mismatch" });
  }
});

export const preparationAttemptV1Schema = z.strictObject({
  attemptId: identifier,
  sequence: z.number().int().safe().positive(),
  state: z.enum(["PREPARED", "STALE", "REPREPARE_INTENT", "PREPARE_UNKNOWN", "REFUSED"]),
  txId: z.string().min(1).max(256).nullable(),
  unsignedTransaction: z.record(z.string(), jsonValueSchema).nullable(),
  preparationFingerprint: hash.nullable(),
  immutableIdentity: immutableExecutionIdentityV1Schema.nullable(),
  feeAuthorization: feeAuthorizationV1Schema.nullable(),
  preparedAt: isoUtc.nullable(),
  preparedRunRevision: z.number().int().safe().positive().nullable(),
  freshnessPolicyVersion: identifier,
  freshnessEvaluatedAt: isoUtc.nullable(),
  nonceFreshnessEvidence: nonceFreshnessEvidenceV1Schema.nullable(),
  staleAt: isoUtc.nullable(),
  staleReason: z.literal("NONCE_MISMATCH").nullable(),
}).superRefine((attempt, context) => {
  const complete = attempt.txId !== null && attempt.unsignedTransaction !== null &&
    attempt.preparationFingerprint !== null && attempt.immutableIdentity !== null &&
    attempt.feeAuthorization !== null && attempt.preparedAt !== null &&
    attempt.preparedRunRevision !== null;
  if (["PREPARED", "STALE"].includes(attempt.state) !== complete) {
    context.addIssue({ code: "custom", message: "preparation completeness mismatch" });
  }
  if (
    (attempt.state === "STALE") !==
      (attempt.staleAt !== null && attempt.staleReason === "NONCE_MISMATCH")
  ) {
    context.addIssue({ code: "custom", message: "preparation staleness mismatch" });
  }
  if (
    ["REPREPARE_INTENT", "PREPARE_UNKNOWN", "REFUSED"].includes(attempt.state) &&
    [attempt.txId, attempt.unsignedTransaction, attempt.preparationFingerprint,
      attempt.immutableIdentity, attempt.feeAuthorization, attempt.preparedAt,
      attempt.preparedRunRevision,
      attempt.nonceFreshnessEvidence, attempt.staleAt, attempt.staleReason].some((value) => value !== null)
  ) {
    context.addIssue({ code: "custom", message: "empty preparation attempt contains output" });
  }
  if (
    (attempt.freshnessEvaluatedAt === null) !== (attempt.nonceFreshnessEvidence === null) ||
    (attempt.nonceFreshnessEvidence !== null &&
      (attempt.freshnessEvaluatedAt !== attempt.nonceFreshnessEvidence.observedAt ||
        attempt.freshnessPolicyVersion !== attempt.nonceFreshnessEvidence.policyVersion))
  ) {
    context.addIssue({ code: "custom", message: "nonce freshness evidence mismatch" });
  }
  if (
    (attempt.state === "STALE" && attempt.nonceFreshnessEvidence?.status !== "STALE") ||
    (attempt.state === "PREPARED" && attempt.nonceFreshnessEvidence?.status === "STALE")
  ) {
    context.addIssue({ code: "custom", message: "nonce freshness state mismatch" });
  }
});

export const walletPromptAuthorizationRecordV1Schema = z.strictObject({
  authorizationVersion: z.literal("1.0"),
  walletIntent: walletExecutionIntentV1Schema,
  walletIntentHash: hash,
  providerInvocation: z.enum(["PROVEN_NOT_INVOKED", "INVOKED_OR_UNKNOWN"]),
  invocationAttemptId: identifier.nullable(),
  authorityReleasedAt: isoUtc.nullable(),
  unresolvedOutcome: z.enum([
    "BROWSER_DISAPPEARED",
    "CLIENT_CLAIMED_NOT_INVOKED",
    "PROVIDER_4001",
    "PROVIDER_TIMEOUT",
    "PROVIDER_ERROR",
    "HASH_PERSISTENCE_UNCONFIRMED",
  ]).nullable(),
  unresolvedAt: isoUtc.nullable(),
  recordedAt: isoUtc,
}).superRefine((authority, context) => {
  const released = authority.providerInvocation === "INVOKED_OR_UNKNOWN";
  if (
    released !== (authority.invocationAttemptId !== null && authority.authorityReleasedAt !== null) ||
    ((authority.unresolvedOutcome === null) !== (authority.unresolvedAt === null)) ||
    (authority.unresolvedOutcome !== null && !released) ||
    (authority.authorityReleasedAt !== null && authority.authorityReleasedAt < authority.recordedAt) ||
    (authority.unresolvedAt !== null && authority.authorityReleasedAt !== null &&
      authority.unresolvedAt < authority.authorityReleasedAt)
  ) {
    context.addIssue({ code: "custom", message: "invalid wallet invocation authority" });
  }
});

export const observedImmutableExecutionIdentityV1Schema = immutableExecutionIdentityV1Schema.extend({
  chainId: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
});

export const rpcTransactionAuthorizationEvidenceV1Schema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  observedAt: isoUtc,
  transactionHash,
  immutableIdentity: observedImmutableExecutionIdentityV1Schema,
  immutableIdentityStatus: z.enum(["MATCH", "MISMATCH"]),
  feeAuthorizationStatus: z.enum(["WITHIN_ENVELOPE", "POLICY_VIOLATION", "NOT_EVALUATED"]),
  feePolicyViolationCode: z.enum([
    "LEGACY_GAS_PRICE",
    "FEE_MODEL_CHANGED",
    "ACCESS_LIST_CHANGED",
    "GAS_LIMIT_CAP_EXCEEDED",
    "MAX_FEE_CAP_EXCEEDED",
    "PRIORITY_FEE_CAP_EXCEEDED",
    "NETWORK_FEE_CAP_EXCEEDED",
    "INVALID_FEE_EVIDENCE",
  ]).nullable(),
  observedMaximumNetworkFeeWei: quantity.nullable(),
}).superRefine((evidence, context) => {
  const feeCompliant = evidence.feeAuthorizationStatus === "WITHIN_ENVELOPE";
  const feeViolation = evidence.feeAuthorizationStatus === "POLICY_VIOLATION";
  if (
    (evidence.immutableIdentityStatus === "MISMATCH" &&
      evidence.feeAuthorizationStatus !== "NOT_EVALUATED") ||
    (evidence.immutableIdentityStatus === "MATCH" &&
      evidence.feeAuthorizationStatus === "NOT_EVALUATED") ||
    feeCompliant !== (evidence.observedMaximumNetworkFeeWei !== null) ||
    feeViolation !== (evidence.feePolicyViolationCode !== null)
  ) {
    context.addIssue({ code: "custom", message: "invalid RPC authorization evidence" });
  }
});

export const brickkenCorrelationAttemptV1Schema = z.strictObject({
  attempt: z.number().int().safe().min(1).max(3),
  authorizedAt: isoUtc,
  result: z.enum(["AUTHORIZED", "TEMPORARILY_NOT_FOUND", "TRANSPORT_UNKNOWN"]),
});

export const brickkenCorrelationV1Schema = z.strictObject({
  correlationVersion: z.literal("1.0"),
  pair: z.strictObject({
    txId: z.string().min(1).max(256),
    txHash: transactionHash,
  }),
  lifecycle: z.enum(["PENDING", "CORRELATED"]),
  attempts: z.array(brickkenCorrelationAttemptV1Schema).min(1).max(3),
  correlatedAt: isoUtc.nullable(),
}).superRefine((correlation, context) => {
  if (
    correlation.attempts.some((attempt, index) => attempt.attempt !== index + 1) ||
    (correlation.lifecycle === "CORRELATED") !== (correlation.correlatedAt !== null)
  ) {
    context.addIssue({ code: "custom", message: "invalid correlation lifecycle" });
  }
});

export const brickkenStatusEvidenceV1Schema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  observedAt: isoUtc,
  txId: z.string().min(1).max(256),
  txHash: transactionHash,
  status: z.enum(["pending", "success", "rejected"]),
});

export const tokenIdentityV1Schema = z.strictObject({
  identityVersion: z.literal("1.0"),
  chainId: z.literal("11155111"),
  tokenAddress: address,
  tokenSymbol: z.string().regex(/^[A-Z0-9]{3,5}$/),
  tokenizerWalletAddress: address,
  tokenizationTxHash: transactionHash,
  manifestHash: hash,
  planHash: hash,
  verifiedAt: isoUtc,
  readBackEvidenceHash: hash,
});
