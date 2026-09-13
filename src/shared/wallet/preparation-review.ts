import { canonicalizeJson, hashCanonicalJson } from "@/core";
import { z } from "zod";
import { walletTransactionRequestV1Schema, type WalletTransactionRequestV1 } from "./transaction";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const identifierSchema = z.string().min(1).max(1024);

export interface PreparedTransactionReviewIdentityV1 {
  readonly domain: "edict.prepared-transaction-review.v1";
  readonly runId: string;
  readonly runRevision: number;
  readonly manifestHash: `sha256:${string}`;
  readonly planHash: `sha256:${string}`;
  readonly approvalRevision: number;
  readonly environment: "sandbox";
  readonly chainId: "11155111";
  readonly operation: {
    readonly id: string;
    readonly kind: "TOKENIZE";
    readonly sequence: 1;
  };
  readonly requiredSigner: string;
  readonly brickken: {
    readonly method: "newTokenization";
    readonly executionMode: "client-broadcast";
  };
  readonly preparedTransactionId: string;
  readonly walletRequestVersion: "1.0";
  readonly walletRequest: WalletTransactionRequestV1;
  readonly chainRequirement: {
    readonly mode: "PROVIDER_PRECONDITION";
    readonly decimalChainId: "11155111";
    readonly rpcChainId: "0xaa36a7";
  };
}

export interface PreparedTransactionReviewV1
  extends Omit<PreparedTransactionReviewIdentityV1, "domain"> {
  readonly reviewVersion: "1.0";
  readonly calldataSemantics: "OPAQUE_SERVER_PREPARED";
  readonly walletConfirmation: "NOT_REQUESTED";
  readonly integrity: {
    readonly algorithm: "SHA-256";
    readonly preparedTransactionFingerprint: `sha256:${string}`;
  };
}

export const preparedTransactionReviewV1Schema = z.strictObject({
  reviewVersion: z.literal("1.0"),
  runId: z.string().uuid(),
  runRevision: z.number().int().safe().positive(),
  manifestHash: digestSchema,
  planHash: digestSchema,
  approvalRevision: z.number().int().safe().positive(),
  environment: z.literal("sandbox"),
  chainId: z.literal("11155111"),
  operation: z.strictObject({
    id: identifierSchema,
    kind: z.literal("TOKENIZE"),
    sequence: z.literal(1),
  }),
  requiredSigner: addressSchema,
  brickken: z.strictObject({
    method: z.literal("newTokenization"),
    executionMode: z.literal("client-broadcast"),
  }),
  preparedTransactionId: z.string().min(1).max(256),
  walletRequestVersion: z.literal("1.0"),
  walletRequest: walletTransactionRequestV1Schema,
  chainRequirement: z.strictObject({
    mode: z.literal("PROVIDER_PRECONDITION"),
    decimalChainId: z.literal("11155111"),
    rpcChainId: z.literal("0xaa36a7"),
  }),
  calldataSemantics: z.literal("OPAQUE_SERVER_PREPARED"),
  walletConfirmation: z.literal("NOT_REQUESTED"),
  integrity: z.strictObject({
    algorithm: z.literal("SHA-256"),
    preparedTransactionFingerprint: digestSchema,
  }),
});

function identityFromReview(
  review: Omit<PreparedTransactionReviewV1, "integrity">,
): PreparedTransactionReviewIdentityV1 {
  return Object.freeze({
    domain: "edict.prepared-transaction-review.v1",
    runId: review.runId,
    runRevision: review.runRevision,
    manifestHash: review.manifestHash,
    planHash: review.planHash,
    approvalRevision: review.approvalRevision,
    environment: review.environment,
    chainId: review.chainId,
    operation: Object.freeze({ ...review.operation }),
    requiredSigner: review.requiredSigner,
    brickken: Object.freeze({ ...review.brickken }),
    preparedTransactionId: review.preparedTransactionId,
    walletRequestVersion: review.walletRequestVersion,
    walletRequest: Object.freeze({ ...review.walletRequest }),
    chainRequirement: Object.freeze({ ...review.chainRequirement }),
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export async function createPreparedTransactionReviewV1(
  input: Omit<PreparedTransactionReviewV1, "integrity">,
): Promise<PreparedTransactionReviewV1> {
  const parsed = preparedTransactionReviewV1Schema.omit({ integrity: true }).parse(input);
  const frozen = deepFreeze(parsed) as Omit<PreparedTransactionReviewV1, "integrity">;
  const { hash } = await hashCanonicalJson(identityFromReview(frozen));
  return deepFreeze({
    ...frozen,
    integrity: {
      algorithm: "SHA-256" as const,
      preparedTransactionFingerprint: hash,
    },
  });
}

export async function validatePreparedTransactionReviewV1(
  raw: unknown,
): Promise<PreparedTransactionReviewV1> {
  canonicalizeJson(raw);
  const parsed = preparedTransactionReviewV1Schema.parse(raw) as PreparedTransactionReviewV1;
  const rebuilt = await createPreparedTransactionReviewV1({
    reviewVersion: parsed.reviewVersion,
    runId: parsed.runId,
    runRevision: parsed.runRevision,
    manifestHash: parsed.manifestHash,
    planHash: parsed.planHash,
    approvalRevision: parsed.approvalRevision,
    environment: parsed.environment,
    chainId: parsed.chainId,
    operation: parsed.operation,
    requiredSigner: parsed.requiredSigner,
    brickken: parsed.brickken,
    preparedTransactionId: parsed.preparedTransactionId,
    walletRequestVersion: parsed.walletRequestVersion,
    walletRequest: parsed.walletRequest,
    chainRequirement: parsed.chainRequirement,
    calldataSemantics: parsed.calldataSemantics,
    walletConfirmation: parsed.walletConfirmation,
  });
  if (
    rebuilt.integrity.preparedTransactionFingerprint !==
    parsed.integrity.preparedTransactionFingerprint
  ) {
    throw new Error("PREPARED_TRANSACTION_FINGERPRINT_MISMATCH");
  }
  return rebuilt;
}
