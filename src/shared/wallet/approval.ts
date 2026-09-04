import { canonicalizeJson } from "@/core";
import { getTypesForEIP712Domain, hashTypedData, serializeTypedData, type Hex } from "viem";
import { z } from "zod";
import { assertBoundedWalletValue } from "./bounds";
import { WALLET_BOUNDARY_LIMITS } from "./limits";
import type { AuthorizedRunProjection } from "./types";

export const EDICT_APPROVAL_CHALLENGE_TTL_SECONDS = 5 * 60;

export const EDICT_APPROVAL_DOMAIN = Object.freeze({
  name: "Edict",
  version: "1",
  chainId: 11155111,
});

export const EDICT_APPROVAL_TYPES = Object.freeze({
  ApproveExecutionPlan: [
    { name: "runId", type: "string" },
    { name: "manifestHash", type: "bytes32" },
    { name: "planHash", type: "bytes32" },
    { name: "environment", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "approvalVersion", type: "string" },
    { name: "approvalRevision", type: "uint256" },
    { name: "requiredSigner", type: "address" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const);

export const EDICT_APPROVAL_RPC_TYPES = Object.freeze({
  EIP712Domain: getTypesForEIP712Domain({ domain: EDICT_APPROVAL_DOMAIN }),
  ...EDICT_APPROVAL_TYPES,
});

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
const uintStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const approvalTypedDataSchema = z.strictObject({
  domain: z.strictObject({
    name: z.literal("Edict"),
    version: z.literal("1"),
    chainId: z.union([z.literal(11155111), z.literal("11155111")]),
  }),
  types: z.strictObject({
    EIP712Domain: z.tuple([
      z.strictObject({ name: z.literal("name"), type: z.literal("string") }),
      z.strictObject({ name: z.literal("version"), type: z.literal("string") }),
      z.strictObject({ name: z.literal("chainId"), type: z.literal("uint256") }),
    ]),
    ApproveExecutionPlan: z.tuple([
      z.strictObject({ name: z.literal("runId"), type: z.literal("string") }),
      z.strictObject({ name: z.literal("manifestHash"), type: z.literal("bytes32") }),
      z.strictObject({ name: z.literal("planHash"), type: z.literal("bytes32") }),
      z.strictObject({ name: z.literal("environment"), type: z.literal("string") }),
      z.strictObject({ name: z.literal("chainId"), type: z.literal("uint256") }),
      z.strictObject({ name: z.literal("approvalVersion"), type: z.literal("string") }),
      z.strictObject({ name: z.literal("approvalRevision"), type: z.literal("uint256") }),
      z.strictObject({ name: z.literal("requiredSigner"), type: z.literal("address") }),
      z.strictObject({ name: z.literal("issuedAt"), type: z.literal("uint64") }),
      z.strictObject({ name: z.literal("expiresAt"), type: z.literal("uint64") }),
      z.strictObject({ name: z.literal("nonce"), type: z.literal("bytes32") }),
    ]),
  }),
  primaryType: z.literal("ApproveExecutionPlan"),
  message: z.strictObject({
    runId: z.string().uuid(),
    manifestHash: hex32Schema,
    planHash: hex32Schema,
    environment: z.literal("sandbox"),
    chainId: z.literal("11155111"),
    approvalVersion: z.literal("1.0"),
    approvalRevision: uintStringSchema,
    requiredSigner: addressSchema,
    issuedAt: uintStringSchema,
    expiresAt: uintStringSchema,
    nonce: hex32Schema,
  }),
});

export type EdictApprovalTypedDataV1 = z.infer<typeof approvalTypedDataSchema>;

export const approvalChallengeEnvelopeSchema = z.strictObject({
  challengeToken: z.string().min(1).max(WALLET_BOUNDARY_LIMITS.challengeTokenCodeUnits),
  typedData: approvalTypedDataSchema,
  typedDataDigest: hex32Schema,
  signingRequest: z.strictObject({
    method: z.literal("eth_signTypedData_v4"),
    params: z.tuple([
      addressSchema,
      z.string().min(1).max(WALLET_BOUNDARY_LIMITS.typedDataSerializationCodeUnits),
    ]),
  }),
});

export type ApprovalChallengeEnvelopeV1 = z.infer<typeof approvalChallengeEnvelopeSchema>;

export type ApprovalChallengeValidation =
  | Readonly<{ ok: true; value: ApprovalChallengeEnvelopeV1 }>
  | Readonly<{
      ok: false;
      code: "APPROVAL_CHALLENGE_MALFORMED" | "APPROVAL_CHALLENGE_EXPIRED" | "TYPED_DATA_MISMATCH";
    }>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function hashToBytes32(value: string): string {
  const parsed = sha256Schema.safeParse(value);
  return parsed.success ? `0x${parsed.data.slice(7)}` : "";
}

export function createApprovalRpcMaterial(typedData: {
  readonly domain: typeof EDICT_APPROVAL_DOMAIN;
  readonly primaryType: "ApproveExecutionPlan";
  readonly message: Record<string, unknown>;
}) {
  const complete = {
    domain: typedData.domain,
    types: EDICT_APPROVAL_RPC_TYPES,
    primaryType: typedData.primaryType,
    message: typedData.message,
  } as const;
  const serialized = serializeTypedData(complete as never);
  const parsed = deepFreeze(approvalTypedDataSchema.parse(JSON.parse(serialized)));
  return Object.freeze({
    typedData: parsed,
    typedDataDigest: hashTypedData(complete as never),
    serialized,
  });
}

export function validateApprovalChallenge(
  raw: unknown,
  run: AuthorizedRunProjection,
  nowEpochSeconds: bigint,
): ApprovalChallengeValidation {
  try {
    assertBoundedWalletValue(raw, {
      maxCodeUnits: WALLET_BOUNDARY_LIMITS.compatibilityEvidenceCodeUnits,
      maxArrayLength: 64,
      maxProperties: 32,
    });
    canonicalizeJson(raw);
  } catch {
    return Object.freeze({ ok: false, code: "APPROVAL_CHALLENGE_MALFORMED" });
  }
  const parsed = approvalChallengeEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return Object.freeze({ ok: false, code: "APPROVAL_CHALLENGE_MALFORMED" });
  const value = parsed.data;
  let serialized: unknown;
  try {
    serialized = JSON.parse(value.signingRequest.params[1]);
  } catch {
    return Object.freeze({ ok: false, code: "APPROVAL_CHALLENGE_MALFORMED" });
  }
  const serializedParsed = approvalTypedDataSchema.safeParse(serialized);
  if (!serializedParsed.success) {
    return Object.freeze({ ok: false, code: "APPROVAL_CHALLENGE_MALFORMED" });
  }
  const message = value.typedData.message;
  const issuedAt = BigInt(message.issuedAt);
  const expiresAt = BigInt(message.expiresAt);
  if (expiresAt <= nowEpochSeconds) {
    return Object.freeze({ ok: false, code: "APPROVAL_CHALLENGE_EXPIRED" });
  }
  const mismatch =
    canonicalizeJson(value.typedData) !== canonicalizeJson(serializedParsed.data) ||
    value.signingRequest.params[0] !== run.requiredSigner.walletAddress ||
    message.runId !== run.id ||
    message.manifestHash !== hashToBytes32(run.manifestHash) ||
    message.planHash !== hashToBytes32(run.planHash) ||
    message.environment !== run.environment ||
    message.chainId !== run.chainId ||
    BigInt(message.approvalRevision) !== BigInt(run.revision) ||
    message.requiredSigner !== run.requiredSigner.walletAddress ||
    issuedAt > nowEpochSeconds + 30n ||
    expiresAt - issuedAt !== BigInt(EDICT_APPROVAL_CHALLENGE_TTL_SECONDS);
  if (mismatch) return Object.freeze({ ok: false, code: "TYPED_DATA_MISMATCH" });
  let digest: Hex;
  try {
    digest = hashTypedData(value.typedData as never);
  } catch {
    return Object.freeze({ ok: false, code: "APPROVAL_CHALLENGE_MALFORMED" });
  }
  if (digest !== value.typedDataDigest) {
    return Object.freeze({ ok: false, code: "TYPED_DATA_MISMATCH" });
  }
  return Object.freeze({ ok: true, value });
}
