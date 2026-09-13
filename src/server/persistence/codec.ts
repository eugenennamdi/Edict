import "server-only";

import { canonicalizeJson, validateAssetManifestV1 } from "@/core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { InvalidRunSnapshotError, PersistenceDataError } from "../execution/errors";
import {
  onchainTransactionEvidenceV1Schema,
  transactionReceiptEvidenceV1Schema,
} from "../execution/onchain-evidence";
import {
  brickkenCorrelationV1Schema,
  brickkenStatusEvidenceV1Schema,
  preparationAttemptV1Schema,
  rpcTransactionAuthorizationEvidenceV1Schema,
  tokenIdentityV1Schema,
  walletPromptAuthorizationRecordV1Schema,
} from "../execution/v4-contracts";
import type { ExecutionRun } from "../execution/types";

export const EXECUTION_RUN_PERSISTENCE_SCHEMA_VERSIONS = ["1.0", "2.0", "3.0", "4.0"] as const;
export const EXECUTION_RUN_PERSISTENCE_SCHEMA_VERSION = "4.0" as const;
export type ExecutionRunPersistenceSchemaVersion =
  (typeof EXECUTION_RUN_PERSISTENCE_SCHEMA_VERSIONS)[number];

export interface PersistedExecutionRunRow {
  readonly runId: string;
  readonly schemaVersion: ExecutionRunPersistenceSchemaVersion;
  readonly revision: number;
  readonly manifestHash: string;
  readonly planHash: string;
  readonly status: ExecutionRun["status"];
  readonly snapshot: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().int().safe(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const identifier = z.string().min(1);
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const wallet = z.string().regex(/^0x[0-9a-f]{40}$/);
const positiveIntegerString = z.string().regex(/^[1-9][0-9]*$/);
const isoUtc = z.string().refine(
  (value) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    return new Date(value).toISOString() === value;
  },
  { message: "Expected a canonical ISO-8601 UTC timestamp." },
);

const manifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  environment: z.literal("sandbox"),
  chainId: z.literal("11155111"),
  tokenizer: z.object({ email: identifier, walletAddress: wallet }).strict(),
  asset: z.object({
    name: identifier,
    symbol: z.string().regex(/^[A-Z0-9]{3,5}$/),
    tokenType: z.literal("RWA_TOKEN"),
    supplyCap: positiveIntegerString,
    documentationUrl: identifier,
  }).strict(),
  investor: z.object({
    email: identifier,
    walletAddress: wallet,
    mintAmount: positiveIntegerString,
  }).strict(),
}).strict();

const planSchema = z.object({
  planVersion: z.literal("1.0"),
  manifestHash: hash,
  environment: z.literal("sandbox"),
  chainId: z.literal("11155111"),
  requiredSigner: z.object({ role: z.literal("tokenizer"), walletAddress: wallet }).strict(),
  planHash: hash,
}).strict();

const operationKind = z.enum(["TOKENIZE", "WHITELIST", "MINT"]);
const operationSchema = z.object({
  id: identifier,
  kind: operationKind,
  stage: z.enum([
    "NOT_STARTED",
    "PREPARE_INTENT",
    "PREPARED",
    "WALLET_PROMPT_RECORDED",
    "WALLET_REJECTED",
    "BROADCAST_HASH_PERSISTED",
    "CONFIRMATION_SUBMITTED",
    "PENDING",
    "CONFIRMED",
    "READ_BACK_VERIFIED",
    "REJECTED",
    "PREPARE_UNKNOWN",
    "BROADCAST_UNKNOWN",
  ]),
  preparedTxId: identifier.nullable(),
  unsignedTransaction: z.record(z.string(), jsonValueSchema).nullable(),
  blockchainTxHash: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
  brickkenStatus: z.enum(["pending", "success", "rejected"]).nullable(),
  brickkenError: z.string().nullable(),
  timeout: z.boolean(),
  prepareIntentAt: isoUtc.nullable(),
  preparedAt: isoUtc.nullable(),
  walletPromptAt: isoUtc.nullable(),
  broadcastAt: isoUtc.nullable(),
  confirmedAt: isoUtc.nullable(),
  verifiedAt: isoUtc.nullable(),
}).strict();

const operationV3Schema = operationSchema.extend({
  onchainTransactionEvidence: onchainTransactionEvidenceV1Schema.nullable(),
  transactionReceiptEvidence: transactionReceiptEvidenceV1Schema.nullable(),
}).strict();

const operationV4Schema = operationV3Schema.omit({ stage: true }).extend({
  stage: z.enum([
    "NOT_STARTED",
    "PREPARE_INTENT",
    "PREPARED",
    "PREPARED_STALE",
    "REPREPARE_INTENT",
    "WALLET_PROMPT_RECORDED",
    "WALLET_REJECTED",
    "BROADCAST_HASH_PERSISTED",
    "BROADCAST_UNKNOWN",
    "RPC_TRANSACTION_VERIFIED",
    "POLICY_VIOLATION_ONCHAIN",
    "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
    "BRICKKEN_CORRELATION_PENDING",
    "BRICKKEN_CORRELATED",
    "READ_BACK_VERIFIED",
    "PREPARE_UNKNOWN",
    "REJECTED",
  ]),
  preparationAttempts: z.array(preparationAttemptV1Schema).max(32),
  activePreparationAttemptId: identifier.nullable(),
  walletPromptAuthorization: walletPromptAuthorizationRecordV1Schema.nullable(),
  rpcTransactionEvidence: rpcTransactionAuthorizationEvidenceV1Schema.nullable(),
  brickkenCorrelation: brickkenCorrelationV1Schema.nullable(),
  brickkenStatusEvidence: z.array(brickkenStatusEvidenceV1Schema).max(256),
}).strict();

const approvalV1Schema = z.object({
  planHash: hash,
  approvedByWallet: wallet,
  approvedAt: isoUtc,
  approvalRevision: z.number().int().safe().nonnegative(),
}).strict();

const approvalProofV1Schema = z.object({
  scheme: z.literal("EIP712_EOA"),
  proofVersion: z.literal("1.0"),
  domainVersion: z.literal("1"),
  runId: identifier,
  manifestHash: hash,
  planHash: hash,
  environment: z.literal("sandbox"),
  chainId: z.literal("11155111"),
  approvalRevision: z.number().int().safe().nonnegative(),
  requiredSigner: wallet,
  recoveredSigner: wallet,
  challengeNonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  issuedAt: isoUtc,
  expiresAt: isoUtc,
  verifiedAt: isoUtc,
  typedDataDigest: z.string().regex(/^0x[0-9a-f]{64}$/),
  publicSignature: z.string().regex(/^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/),
}).strict();

const approvalV2Schema = approvalV1Schema.extend({
  proof: approvalProofV1Schema,
}).strict();

const eventSchema = z.object({
  id: identifier,
  sequence: z.number().int().safe().positive(),
  type: identifier,
  at: isoUtc,
  actor: z.enum(["USER", "SERVER", "WALLET", "BRICKKEN"]),
  operationKind: operationKind.nullable(),
}).strict();

const observationSchema = z.object({
  operationKind,
  read: z.string(),
  at: isoUtc,
}).strict();

const executionRunCommonShape = {
  id: identifier,
  manifest: manifestSchema,
  manifestHash: hash,
  plan: planSchema,
  planHash: hash,
  environment: z.literal("sandbox"),
  chainId: z.literal("11155111"),
  requiredSigner: z.object({ role: z.literal("tokenizer"), walletAddress: wallet }).strict(),
  phase: z.enum(["PLAN", "TOKENIZATION", "WHITELIST", "MINT", "VERIFICATION"]),
  status: z.enum([
    "AWAITING_APPROVAL",
    "PREPARING",
    "AWAITING_WALLET",
    "BROADCAST_RECORDED",
    "CONFIRMING",
    "SUCCEEDED",
    "TIMED_OUT",
    "FAILED",
    "RECONCILIATION_REQUIRED",
  ]),
  terminalOutcome: z.enum(["FAILED", "VERIFICATION_FAILED", "CANCELLED"]).nullable(),
  observations: z.array(observationSchema),
  events: z.array(eventSchema),
  receiptEligible: z.boolean(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
  revision: z.number().int().safe().nonnegative(),
};

const executionRunV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  ...executionRunCommonShape,
  approval: approvalV1Schema.nullable(),
  operations: z.tuple([operationSchema, operationSchema, operationSchema]),
}).strict();

const executionRunV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  ...executionRunCommonShape,
  approval: approvalV2Schema.nullable(),
  operations: z.tuple([operationSchema, operationSchema, operationSchema]),
}).strict();

const executionRunV3Schema = z.object({
  schemaVersion: z.literal("3.0"),
  ...executionRunCommonShape,
  approval: z.union([approvalV1Schema, approvalV2Schema]).nullable(),
  operations: z.tuple([operationV3Schema, operationV3Schema, operationV3Schema]),
}).strict();

const executionRunV4Schema = z.object({
  schemaVersion: z.literal("4.0"),
  ...executionRunCommonShape,
  approval: approvalV2Schema,
  operations: z.tuple([operationV4Schema, operationV4Schema, operationV4Schema]),
  tokenIdentity: tokenIdentityV1Schema.nullable(),
}).strict();

const executionRunSchema = z.discriminatedUnion("schemaVersion", [
  executionRunV1Schema,
  executionRunV2Schema,
  executionRunV3Schema,
  executionRunV4Schema,
]);

const FORBIDDEN_PROPERTY_NAMES = new Set([
  "apikey",
  "authorization",
  "databaseurl",
  "mnemonic",
  "password",
  "privatekey",
  "rawtransaction",
  "rawsignedtransaction",
  "secret",
  "seedphrase",
  "signature",
  "signedtransaction",
  "signedrawtransaction",
  "walletsecret",
]);

function normalizedPropertyName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function assertNoForbiddenProperties(value: JsonValue, path = "$"): void {
  if (typeof value === "string") {
    if (
      /^postgres(?:ql)?:\/\//i.test(value) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
    ) {
      throw new TypeError("Persistence snapshots contain forbidden data.");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoForbiddenProperties(value[index]!, `${path}[${index}]`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const propertyPath = `${path}.${key}`;
    const isApprovedPublicSignature = propertyPath === "$.approval.proof.publicSignature";
    if (FORBIDDEN_PROPERTY_NAMES.has(normalizedPropertyName(key)) && !isApprovedPublicSignature) {
      throw new TypeError("Persistence snapshots contain a forbidden property.");
    }
    assertNoForbiddenProperties(item, propertyPath);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex")}`;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function parseSnapshot(value: unknown): ExecutionRun {
  const canonical = canonicalizeJson(value);
  const json: JsonValue = JSON.parse(canonical);
  assertNoForbiddenProperties(json);
  const parsed = executionRunSchema.parse(json);
  const normalizedManifest = validateAssetManifestV1(parsed.manifest);

  if (
    !normalizedManifest.ok ||
    canonicalizeJson(normalizedManifest.value) !== canonicalizeJson(parsed.manifest) ||
    parsed.manifestHash !== parsed.plan.manifestHash ||
    parsed.planHash !== parsed.plan.planHash ||
    parsed.environment !== parsed.manifest.environment ||
    parsed.environment !== parsed.plan.environment ||
    parsed.chainId !== parsed.manifest.chainId ||
    parsed.chainId !== parsed.plan.chainId ||
    parsed.requiredSigner.walletAddress !== parsed.manifest.tokenizer.walletAddress ||
    parsed.requiredSigner.walletAddress !== parsed.plan.requiredSigner.walletAddress ||
    (parsed.approval !== null &&
      (parsed.approval.planHash !== parsed.planHash ||
        parsed.approval.approvedByWallet !== parsed.requiredSigner.walletAddress ||
        parsed.approval.approvalRevision > parsed.revision)) ||
    (parsed.schemaVersion !== "1.0" && parsed.approval !== null && "proof" in parsed.approval &&
      (parsed.approval.proof.runId !== parsed.id ||
        parsed.approval.proof.manifestHash !== parsed.manifestHash ||
        parsed.approval.proof.planHash !== parsed.planHash ||
        parsed.approval.proof.environment !== parsed.environment ||
        parsed.approval.proof.chainId !== parsed.chainId ||
        parsed.approval.proof.approvalRevision !== parsed.approval.approvalRevision ||
        parsed.approval.proof.requiredSigner !== parsed.requiredSigner.walletAddress ||
        parsed.approval.proof.recoveredSigner !== parsed.approval.approvedByWallet ||
        parsed.approval.proof.verifiedAt !== parsed.approval.approvedAt ||
        parsed.approval.proof.expiresAt <= parsed.approval.proof.issuedAt)) ||
    parsed.operations[0].kind !== "TOKENIZE" ||
    parsed.operations[1].kind !== "WHITELIST" ||
    parsed.operations[2].kind !== "MINT" ||
    new Set(parsed.operations.map((operation) => operation.id)).size !== 3 ||
    parsed.events.some((event, index) => event.sequence !== index + 1) ||
    parsed.updatedAt < parsed.createdAt
  ) {
    throw new TypeError("Persistence snapshot invariants failed.");
  }


  if (parsed.schemaVersion === "3.0") {
    const hasTransactionEvidence = parsed.operations.some(
      (operation) => operation.onchainTransactionEvidence !== null,
    );
    const evidenceInvalid = parsed.operations.some((operation) => {
      const transaction = operation.onchainTransactionEvidence;
      const receipt = operation.transactionReceiptEvidence;
      if (receipt !== null && transaction === null) return true;
      if (transaction !== null && (
        operation.blockchainTxHash === null ||
        transaction.requestedHash !== operation.blockchainTxHash ||
        (transaction.comparisonStatus === "MISMATCH" && parsed.status !== "RECONCILIATION_REQUIRED") ||
        (transaction.reconciliationStatus === "REQUIRED" && parsed.status !== "RECONCILIATION_REQUIRED")
      )) return true;
      if (receipt !== null && (
        (receipt.identityStatus === "MATCH" && (
          receipt.transactionHash !== operation.blockchainTxHash ||
          receipt.transactionHash !== transaction?.returnedHash
        )) ||
        (receipt.identityStatus === "MISMATCH" && parsed.status !== "RECONCILIATION_REQUIRED") ||
        (receipt.reconciliationStatus === "REQUIRED" && parsed.status !== "RECONCILIATION_REQUIRED") ||
        (operation.stage === "READ_BACK_VERIFIED" && (
          receipt.executionStatus !== "SUCCESS" || receipt.finalityStatus !== "FINALIZED"
        ))
      )) return true;
      return false;
    });
    if (!hasTransactionEvidence || evidenceInvalid) {
      throw new TypeError("Persistence snapshot evidence invariants failed.");
    }
  }

  if (parsed.schemaVersion === "4.0") {
    const invalidOperation = parsed.operations.some((operation) => {
      if (
        operation.preparationAttempts.some((attempt, index) => attempt.sequence !== index + 1) ||
        new Set(operation.preparationAttempts.map((attempt) => attempt.attemptId)).size !==
          operation.preparationAttempts.length
      ) return true;
      const active = operation.activePreparationAttemptId === null
        ? null
        : operation.preparationAttempts.find(
          (attempt) => attempt.attemptId === operation.activePreparationAttemptId,
        ) ?? null;
      if ((operation.activePreparationAttemptId !== null) !== (active !== null)) return true;
      if (active !== null) {
        const stageStateValid =
          (operation.stage === "PREPARED" && active.state === "PREPARED" &&
            operation.walletPromptAuthorization === null && operation.blockchainTxHash === null) ||
          (operation.stage === "PREPARED_STALE" && active.state === "STALE" &&
            operation.walletPromptAuthorization === null && operation.blockchainTxHash === null) ||
          (operation.stage === "REPREPARE_INTENT" && active.state === "REPREPARE_INTENT" &&
            operation.preparedTxId === null && operation.unsignedTransaction === null) ||
          (operation.stage === "PREPARE_UNKNOWN" && active.state === "PREPARE_UNKNOWN") ||
          (operation.stage === "REJECTED" && active.state === "REFUSED") ||
          ([
            "WALLET_PROMPT_RECORDED",
            "WALLET_REJECTED",
            "BROADCAST_HASH_PERSISTED",
            "BROADCAST_UNKNOWN",
            "RPC_TRANSACTION_VERIFIED",
            "POLICY_VIOLATION_ONCHAIN",
            "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
            "BRICKKEN_CORRELATION_PENDING",
            "BRICKKEN_CORRELATED",
            "READ_BACK_VERIFIED",
          ].includes(operation.stage) && active.state === "PREPARED");
        if (!stageStateValid) return true;
      }
      if (active !== null && active.state !== "REPREPARE_INTENT") {
        if (
          active.txId !== operation.preparedTxId ||
          canonicalizeJson(active.unsignedTransaction) !== canonicalizeJson(operation.unsignedTransaction)
        ) return true;
      }
      if (
        active !== null && active.preparationFingerprint !== null &&
        active.preparedRunRevision !== null && active.txId !== null &&
        active.preparedAt !== null && active.immutableIdentity !== null &&
        active.feeAuthorization !== null &&
        active.preparationFingerprint !== sha256Canonical({
          domain: "edict.preparation-attempt.v1",
          runId: parsed.id,
          runRevision: active.preparedRunRevision,
          approvalRevision: parsed.approval.approvalRevision,
          manifestHash: parsed.manifestHash,
          planHash: parsed.planHash,
          operation: { id: operation.id, kind: operation.kind },
          attemptId: active.attemptId,
          txId: active.txId,
          preparedAt: active.preparedAt,
          immutableIdentity: active.immutableIdentity,
          feeAuthorization: active.feeAuthorization,
        })
      ) return true;
      const prompt = operation.walletPromptAuthorization;
      if (
        ["WALLET_PROMPT_RECORDED", "WALLET_REJECTED", "BROADCAST_HASH_PERSISTED",
          "BROADCAST_UNKNOWN", "RPC_TRANSACTION_VERIFIED",
          "POLICY_VIOLATION_ONCHAIN",
          "RPC_TRANSACTION_RECONCILIATION_REQUIRED", "BRICKKEN_CORRELATION_PENDING",
          "BRICKKEN_CORRELATED", "READ_BACK_VERIFIED"].includes(operation.stage) && prompt === null
      ) return true;
      if (prompt !== null) {
        const intent = prompt.walletIntent;
        if (
          active === null || active.preparationFingerprint === null ||
          intent.runId !== parsed.id || intent.runRevision > parsed.revision ||
          intent.approvalIdentity.approvalRevision !== parsed.approval.approvalRevision ||
          intent.approvalIdentity.typedDataDigest !== parsed.approval.proof.typedDataDigest ||
          intent.manifestHash !== parsed.manifestHash || intent.planHash !== parsed.planHash ||
          intent.operation.id !== operation.id || intent.operation.kind !== operation.kind ||
          intent.requiredSigner !== parsed.requiredSigner.walletAddress ||
          intent.brickkenPreparation.preparationAttemptId !== active.attemptId ||
          intent.brickkenPreparation.preparedTxId !== active.txId ||
          intent.brickkenPreparation.preparationFingerprint !== active.preparationFingerprint ||
          canonicalizeJson(intent.immutableIdentity) !== canonicalizeJson(active.immutableIdentity) ||
          canonicalizeJson(intent.feeAuthorization) !== canonicalizeJson(active.feeAuthorization) ||
          prompt.walletIntentHash !== sha256Canonical(intent) ||
          intent.semanticAuthorization.calldataCommitment !== sha256Text(intent.immutableIdentity.data)
        ) return true;
        if (
          (operation.stage === "WALLET_REJECTED" &&
            prompt.providerInvocation !== "PROVEN_NOT_INVOKED") ||
          (["BROADCAST_HASH_PERSISTED", "BROADCAST_UNKNOWN", "RPC_TRANSACTION_VERIFIED",
            "POLICY_VIOLATION_ONCHAIN", "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
            "BRICKKEN_CORRELATION_PENDING", "BRICKKEN_CORRELATED", "READ_BACK_VERIFIED"]
            .includes(operation.stage) && prompt.providerInvocation !== "INVOKED_OR_UNKNOWN") ||
          (operation.stage === "BROADCAST_UNKNOWN" && prompt.unresolvedOutcome === null) ||
          (operation.stage !== "BROADCAST_UNKNOWN" && prompt.unresolvedOutcome !== null)
        ) return true;
      }
      const correlation = operation.brickkenCorrelation;
      if (
        (operation.stage === "BRICKKEN_CORRELATION_PENDING" && correlation?.lifecycle !== "PENDING") ||
        (["BRICKKEN_CORRELATED", "READ_BACK_VERIFIED"].includes(operation.stage) &&
          correlation?.lifecycle !== "CORRELATED")
      ) return true;
      if (correlation !== null && (
        active === null || correlation.pair.txId !== active.txId ||
        correlation.pair.txHash !== operation.blockchainTxHash ||
        operation.rpcTransactionEvidence === null ||
        operation.rpcTransactionEvidence.immutableIdentityStatus !== "MATCH"
      )) return true;
      const rpcEvidence = operation.rpcTransactionEvidence;
      if (rpcEvidence !== null && (
        operation.blockchainTxHash === null ||
        rpcEvidence.transactionHash !== operation.blockchainTxHash ||
        active === null ||
        ((rpcEvidence.immutableIdentityStatus === "MATCH") !==
          (canonicalizeJson(rpcEvidence.immutableIdentity) ===
            canonicalizeJson(active.immutableIdentity))) ||
        (rpcEvidence.feeAuthorizationStatus === "POLICY_VIOLATION" &&
          parsed.status !== "RECONCILIATION_REQUIRED") ||
        (rpcEvidence.immutableIdentityStatus === "MISMATCH" &&
          parsed.status !== "RECONCILIATION_REQUIRED")
      )) return true;
      if (
        (operation.stage === "RPC_TRANSACTION_VERIFIED" &&
          rpcEvidence?.feeAuthorizationStatus !== "WITHIN_ENVELOPE") ||
        (operation.stage === "POLICY_VIOLATION_ONCHAIN" &&
          rpcEvidence?.feeAuthorizationStatus !== "POLICY_VIOLATION") ||
        (operation.stage === "RPC_TRANSACTION_RECONCILIATION_REQUIRED" &&
          rpcEvidence !== null && rpcEvidence.immutableIdentityStatus !== "MISMATCH") ||
        (operation.transactionReceiptEvidence !== null && (
          rpcEvidence === null || operation.blockchainTxHash === null ||
          operation.transactionReceiptEvidence.transactionHash !== operation.blockchainTxHash ||
          operation.transactionReceiptEvidence.from !== rpcEvidence.immutableIdentity.from ||
          operation.transactionReceiptEvidence.to !== rpcEvidence.immutableIdentity.to ||
          operation.transactionReceiptEvidence.type !== "0x2"
        ))
      ) return true;
      return operation.brickkenStatusEvidence.some((evidence) =>
        correlation === null || evidence.txId !== correlation.pair.txId ||
        evidence.txHash !== correlation.pair.txHash
      );
    });
    const tokenIdentityInvalid = parsed.tokenIdentity !== null && (
      parsed.operations[0].stage !== "READ_BACK_VERIFIED" ||
      parsed.operations[0].rpcTransactionEvidence?.feeAuthorizationStatus !== "WITHIN_ENVELOPE" ||
      parsed.status === "RECONCILIATION_REQUIRED" ||
      parsed.tokenIdentity.chainId !== parsed.chainId ||
      parsed.tokenIdentity.tokenSymbol !== parsed.manifest.asset.symbol ||
      parsed.tokenIdentity.tokenizerWalletAddress !== parsed.requiredSigner.walletAddress ||
      parsed.tokenIdentity.tokenizationTxHash !== parsed.operations[0].blockchainTxHash ||
      parsed.tokenIdentity.manifestHash !== parsed.manifestHash ||
      parsed.tokenIdentity.planHash !== parsed.planHash
    );
    if (invalidOperation || tokenIdentityInvalid) {
      throw new TypeError("Persistence snapshot V4 invariants failed.");
    }
  }

  return deepFreeze(parsed);
}

export function encodeExecutionRunV1(run: unknown): PersistedExecutionRunRow {
  try {
    const snapshot = parseSnapshot(run);
    return deepFreeze({
      runId: snapshot.id,
      schemaVersion: snapshot.schemaVersion,
      revision: snapshot.revision,
      manifestHash: snapshot.manifestHash,
      planHash: snapshot.planHash,
      status: snapshot.status,
      snapshot,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    });
  } catch {
    throw new InvalidRunSnapshotError();
  }
}

export function decodeExecutionRunV1(row: PersistedExecutionRunRow): ExecutionRun {
  try {
    const snapshot = parseSnapshot(row.snapshot);
    if (
      !EXECUTION_RUN_PERSISTENCE_SCHEMA_VERSIONS.includes(row.schemaVersion) ||
      row.runId !== snapshot.id ||
      row.schemaVersion !== snapshot.schemaVersion ||
      row.revision !== snapshot.revision ||
      row.manifestHash !== snapshot.manifestHash ||
      row.planHash !== snapshot.planHash ||
      row.status !== snapshot.status ||
      row.createdAt !== snapshot.createdAt ||
      row.updatedAt !== snapshot.updatedAt
    ) {
      throw new TypeError("Stored columns do not match the snapshot.");
    }
    return snapshot;
  } catch {
    throw new PersistenceDataError();
  }
}
