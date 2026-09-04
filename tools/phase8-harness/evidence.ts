import { assertBoundedWalletValue } from "../../src/shared/wallet/bounds";
import { WALLET_BOUNDARY_LIMITS } from "../../src/shared/wallet/limits";
import { z } from "zod";
import type { Phase8PublicTarget } from "./types";

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoUtc = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value,
);
const detailValue = z.union([z.string().max(16_384), z.number().int().safe(), z.boolean(), z.null()]);

export const phase8ActionEvidenceV1Schema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  harnessVersion: z.literal("1.0"),
  observedAt: isoUtc,
  action: z.enum([
    "BRICKKEN_READ", "BRICKKEN_PREPARE", "WALLET_APPROVAL", "WALLET_SEND",
    "RPC_TRANSACTION_COMPARE", "BRICKKEN_CONFIRM", "BRICKKEN_POLL", "RPC_FINALITY",
    "BRICKKEN_READ_BACK",
  ]),
  runId: z.string().min(1).max(128),
  operation: z.enum(["TOKENIZE", "WHITELIST", "MINT"]),
  walletRequestHash: hash.nullable(),
  evidenceStatus: z.enum(["PASSED", "FAILED", "BLOCKED"]),
  resultFingerprint: hash.nullable(),
  details: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/), detailValue)
    .refine((value) => Object.keys(value).length <= 64),
  limitations: z.array(z.string().min(1).max(500)).max(32),
  redactions: z.array(z.enum([
    "CREDENTIALS",
    "RAW_EXTERNAL_RESPONSES",
    "COMPLETE_CALLDATA",
    "APPROVAL_SIGNATURES",
    "RUN_CAPABILITIES",
  ])).max(5),
});

export type Phase8ActionEvidenceV1 = z.infer<typeof phase8ActionEvidenceV1Schema>;

const forbiddenDetailName = /(?:apikey|authorization|capability|databaseurl|password|privatekey|secret|seedphrase|signature)/;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

export function validatePhase8ActionEvidenceV1(
  raw: unknown,
  target: Phase8PublicTarget,
  sensitiveValues: readonly string[],
): Phase8ActionEvidenceV1 {
  assertBoundedWalletValue(raw, {
    maxCodeUnits: WALLET_BOUNDARY_LIMITS.compatibilityEvidenceCodeUnits,
    maxArrayLength: 64,
    maxProperties: 64,
  });
  const parsed = phase8ActionEvidenceV1Schema.parse(raw);
  if (
    parsed.action !== target.action || parsed.runId !== target.runId ||
    parsed.operation !== target.operation || parsed.walletRequestHash !== target.walletRequestHash ||
    Object.keys(parsed.details).some((key) => forbiddenDetailName.test(
      key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""),
    ))
  ) {
    throw new Error("PHASE8_EVIDENCE_INVALID");
  }
  const serialized = JSON.stringify(parsed);
  if (sensitiveValues.some((value) => value.length >= 8 && serialized.includes(value))) {
    throw new Error("PHASE8_EVIDENCE_INVALID");
  }
  return deepFreeze(parsed);
}
