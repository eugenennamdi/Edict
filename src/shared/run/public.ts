import { canonicalizeJson, validateAssetManifestV1, validateExecutionPlanV1 } from "@/core";
import type { ExecutionPlanV1, NormalizedAssetManifestV1 } from "@/core";
import {
  preparedTransactionReviewV1Schema,
  type PreparedTransactionReviewV1,
} from "@/shared/wallet";
import { z } from "zod";

const MAX_PUBLIC_RECORD_CODE_UNITS = 512 * 1024;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const publicRunIdSchema = z.string().length(36).regex(RUN_ID);

const identifierSchema = z.string().min(1).max(1024);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const walletSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const transactionHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const isoUtcSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
});

const requiredSignerSchema = z.strictObject({
  role: z.literal("tokenizer"),
  walletAddress: walletSchema,
});

const operationStageSchema = z.enum([
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
  "PREPARED_STALE",
  "REPREPARE_INTENT",
  "RPC_TRANSACTION_VERIFIED",
  "POLICY_VIOLATION_ONCHAIN",
  "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
  "BRICKKEN_CORRELATION_PENDING",
  "BRICKKEN_CORRELATED",
]);

function publicOperationSchema(kind: "TOKENIZE" | "WHITELIST" | "MINT") {
  return z.strictObject({
    id: identifierSchema,
    kind: z.literal(kind),
    stage: operationStageSchema,
    preparedTxId: identifierSchema.nullable(),
    blockchainTxHash: transactionHashSchema.nullable(),
    brickkenStatus: z.enum(["pending", "success", "rejected"]).nullable(),
    timeout: z.boolean(),
  });
}

const executionPreparationSchema = z.strictObject({
  projectionVersion: z.literal("1.0"),
  nextOperation: z.strictObject({
    id: identifierSchema,
    kind: z.literal("TOKENIZE"),
    sequence: z.literal(1),
    name: z.literal("Create tokenization"),
  }),
  preparationStatus: z.enum([
    "READY_FOR_PREPARATION",
    "PREPARATION_PENDING",
    "PREPARED_FOR_REVIEW",
    "PREPARATION_UNCONFIRMED",
  ]),
  transactionReview: preparedTransactionReviewV1Schema.nullable(),
});

export type PublicExecutionPreparation = Readonly<{
  projectionVersion: "1.0";
  nextOperation: Readonly<{
    id: string;
    kind: "TOKENIZE";
    sequence: 1;
    name: "Create tokenization";
  }>;
  preparationStatus:
    | "READY_FOR_PREPARATION"
    | "PREPARATION_PENDING"
    | "PREPARED_FOR_REVIEW"
    | "PREPARATION_UNCONFIRMED";
  transactionReview: PreparedTransactionReviewV1 | null;
}>;

export const publicRunProjectionSchema = z.strictObject({
  id: publicRunIdSchema,
  schemaVersion: z.enum(["1.0", "2.0", "3.0", "4.0"]),
  manifestHash: digestSchema,
  planHash: digestSchema,
  environment: z.literal("sandbox"),
  chainId: z.literal("11155111"),
  requiredSigner: requiredSignerSchema,
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
  approved: z.boolean(),
  execution: executionPreparationSchema.nullable(),
  operations: z.tuple([
    publicOperationSchema("TOKENIZE"),
    publicOperationSchema("WHITELIST"),
    publicOperationSchema("MINT"),
  ]),
  receiptEligible: z.boolean(),
  createdAt: isoUtcSchema,
  updatedAt: isoUtcSchema,
  revision: z.number().int().safe().positive(),
});

export type PublicRunProjection = Readonly<z.infer<typeof publicRunProjectionSchema>>;

export interface PublicPlanningRecord {
  readonly run: PublicRunProjection;
  readonly manifest: NormalizedAssetManifestV1;
  readonly plan: ExecutionPlanV1;
}

const planningEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  run: z.unknown(),
  manifest: z.unknown(),
  plan: z.unknown(),
});

const mutationEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  run: z.unknown(),
});

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function safeJsonValue(input: unknown): unknown {
  const canonical = canonicalizeJson(input);
  if (canonical.length > MAX_PUBLIC_RECORD_CODE_UNITS) throw new Error("PUBLIC_RUN_DTO_INVALID");
  return JSON.parse(canonical);
}

function assertExecutionProjection(run: PublicRunProjection): void {
  const execution = run.execution;
  const tokenization = run.operations[0];
  const expectedPreparationStatus =
    tokenization.stage === "NOT_STARTED" && run.status === "PREPARING"
      ? "READY_FOR_PREPARATION"
      : tokenization.stage === "PREPARE_INTENT" && run.status === "PREPARING"
        ? "PREPARATION_PENDING"
        : tokenization.stage === "PREPARED" && run.status === "AWAITING_WALLET"
          ? "PREPARED_FOR_REVIEW"
          : tokenization.stage === "PREPARE_UNKNOWN" && run.status === "RECONCILIATION_REQUIRED"
            ? "PREPARATION_UNCONFIRMED"
            : null;
  if (
    (execution !== null && (
      !run.approved ||
      run.terminalOutcome !== null ||
      run.phase !== "TOKENIZATION" ||
      expectedPreparationStatus === null ||
      execution.nextOperation.id !== tokenization.id ||
      execution.preparationStatus !== expectedPreparationStatus ||
      ((execution.preparationStatus === "PREPARED_FOR_REVIEW") !==
        (execution.transactionReview !== null)) ||
      (execution.transactionReview !== null && (
        execution.transactionReview.runId !== run.id ||
        execution.transactionReview.runRevision !== run.revision ||
        execution.transactionReview.approvalRevision >= run.revision ||
        execution.transactionReview.manifestHash !== run.manifestHash ||
        execution.transactionReview.planHash !== run.planHash ||
        execution.transactionReview.environment !== run.environment ||
        execution.transactionReview.chainId !== run.chainId ||
        execution.transactionReview.operation.id !== tokenization.id ||
        execution.transactionReview.operation.kind !== tokenization.kind ||
        execution.transactionReview.preparedTransactionId !== tokenization.preparedTxId ||
        execution.transactionReview.requiredSigner !== run.requiredSigner.walletAddress ||
        execution.transactionReview.walletRequest.from !== run.requiredSigner.walletAddress ||
        execution.transactionReview.walletRequest.to === undefined ||
        execution.transactionReview.walletRequest.data === undefined
      ))
    )) ||
    (execution === null &&
      run.approved &&
      run.terminalOutcome === null &&
      run.phase === "TOKENIZATION" &&
      expectedPreparationStatus !== null)
  ) throw new Error("PUBLIC_RUN_DTO_INVALID");
}

function parseRecordParts(input: {
  readonly run: unknown;
  readonly manifest: unknown;
  readonly plan: unknown;
}): PublicPlanningRecord {
  const run = publicRunProjectionSchema.parse(input.run);
  assertExecutionProjection(run);
  const manifestResult = validateAssetManifestV1(input.manifest);
  const planResult = validateExecutionPlanV1(input.plan);
  if (!manifestResult.ok || !planResult.ok) throw new Error("PUBLIC_RUN_DTO_INVALID");

  const manifest = manifestResult.value;
  const plan = planResult.value;
  if (
    canonicalizeJson(input.manifest) !== canonicalizeJson(manifest) ||
    run.manifestHash !== plan.manifestHash ||
    run.planHash !== plan.planHash ||
    run.environment !== manifest.environment ||
    run.environment !== plan.environment ||
    run.chainId !== manifest.chainId ||
    run.chainId !== plan.chainId ||
    run.requiredSigner.role !== plan.requiredSigner.role ||
    run.requiredSigner.walletAddress !== manifest.tokenizer.walletAddress ||
    run.requiredSigner.walletAddress !== plan.requiredSigner.walletAddress ||
    run.updatedAt < run.createdAt
  ) {
    throw new Error("PUBLIC_RUN_DTO_INVALID");
  }

  return deepFreeze({ run: deepFreeze(run), manifest, plan });
}

export function parsePublicPlanningRecordResponse(input: unknown): PublicPlanningRecord {
  const envelope = planningEnvelopeSchema.parse(safeJsonValue(input));
  return parseRecordParts(envelope);
}

export function parsePublicPlanningRecord(input: unknown): PublicPlanningRecord {
  const record = z.strictObject({
    run: z.unknown(),
    manifest: z.unknown(),
    plan: z.unknown(),
  }).parse(safeJsonValue(input));
  return parseRecordParts(record);
}

export function parsePublicRunMutationResponse(input: unknown): PublicRunProjection {
  const envelope = mutationEnvelopeSchema.parse(safeJsonValue(input));
  const run = publicRunProjectionSchema.parse(envelope.run);
  assertExecutionProjection(run);
  return deepFreeze(run);
}
