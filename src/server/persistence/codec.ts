import "server-only";

import { canonicalizeJson, validateAssetManifestV1 } from "@/core";
import { z } from "zod";
import { InvalidRunSnapshotError, PersistenceDataError } from "../execution/errors";
import {
  onchainTransactionEvidenceV1Schema,
  transactionReceiptEvidenceV1Schema,
} from "../execution/onchain-evidence";
import type { ExecutionRun } from "../execution/types";

export const EXECUTION_RUN_PERSISTENCE_SCHEMA_VERSIONS = ["1.0", "2.0", "3.0"] as const;
export const EXECUTION_RUN_PERSISTENCE_SCHEMA_VERSION = "3.0" as const;
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

const executionRunSchema = z.discriminatedUnion("schemaVersion", [
  executionRunV1Schema,
  executionRunV2Schema,
  executionRunV3Schema,
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
