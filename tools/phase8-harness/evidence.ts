import { assertBoundedWalletValue } from "../../src/shared/wallet/bounds";
import { WALLET_BOUNDARY_LIMITS } from "../../src/shared/wallet/limits";
import { z } from "zod";
import type { Phase8PublicTarget } from "./types";

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoUtc = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value,
);
const brickkenReadDetailsSchema = z.strictObject({
  checkKind: z.literal("BRICKKEN_SANDBOX_NETWORK_INFO"),
  checkVersion: z.literal("1.0"),
  environment: z.literal("sandbox"),
  requestedChainId: z.literal("11155111"),
  currencyName: z.literal("Sepolia ETH"),
  blockExplorerHost: z.literal("sepolia.etherscan.io"),
  authenticatedNetworkRead: z.literal(true),
  resultCategory: z.literal("BRICKKEN_NETWORK_READ_PASSED"),
  adapterVersion: z.literal("1.0"),
  sdkVersion: z.literal("0.2.1"),
});

export const BRICKKEN_READ_LIMITATIONS = Object.freeze([
  "Proves only that the supplied server-side credential was accepted for the sandbox network-information endpoint.",
  "Does not prove signer approval, license status, remaining credits, prepare eligibility, wallet compatibility, write capability, or blockchain execution readiness.",
] as const);

export const BRICKKEN_READ_REDACTIONS = Object.freeze([
  "CREDENTIALS",
  "RAW_EXTERNAL_RESPONSES",
  "REQUEST_RESPONSE_HEADERS",
  "DATABASE_RPC_URLS",
  "RUN_CAPABILITIES",
  "CHALLENGE_TOKENS",
  "APPROVAL_SIGNATURES",
  "PRIVATE_SIGNING_MATERIAL",
  "TOKENIZER_EMAIL",
  "CLAIMED_SIGNER_IDENTITY",
  "COMPLETE_PREPARED_TRANSACTIONS",
  "COMPLETE_CALLDATA",
] as const);

export const phase8ActionEvidenceV1Schema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  harnessVersion: z.literal("1.0"),
  observedAt: isoUtc,
  action: z.literal("BRICKKEN_READ"),
  runId: z.string().min(1).max(128),
  operation: z.enum(["TOKENIZE", "WHITELIST", "MINT"]),
  walletRequestHash: z.null(),
  evidenceStatus: z.literal("PASSED"),
  resultFingerprint: hash,
  details: brickkenReadDetailsSchema,
  limitations: z.tuple([
    z.literal(BRICKKEN_READ_LIMITATIONS[0]),
    z.literal(BRICKKEN_READ_LIMITATIONS[1]),
  ]),
  redactions: z.tuple([
    z.literal(BRICKKEN_READ_REDACTIONS[0]),
    z.literal(BRICKKEN_READ_REDACTIONS[1]),
    z.literal(BRICKKEN_READ_REDACTIONS[2]),
    z.literal(BRICKKEN_READ_REDACTIONS[3]),
    z.literal(BRICKKEN_READ_REDACTIONS[4]),
    z.literal(BRICKKEN_READ_REDACTIONS[5]),
    z.literal(BRICKKEN_READ_REDACTIONS[6]),
    z.literal(BRICKKEN_READ_REDACTIONS[7]),
    z.literal(BRICKKEN_READ_REDACTIONS[8]),
    z.literal(BRICKKEN_READ_REDACTIONS[9]),
    z.literal(BRICKKEN_READ_REDACTIONS[10]),
    z.literal(BRICKKEN_READ_REDACTIONS[11]),
  ]),
});

export type Phase8ActionEvidenceV1 = z.infer<typeof phase8ActionEvidenceV1Schema>;

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
  try {
    assertBoundedWalletValue(raw, {
      maxCodeUnits: WALLET_BOUNDARY_LIMITS.compatibilityEvidenceCodeUnits,
      maxArrayLength: 64,
      maxProperties: 64,
    });
    const parsed = phase8ActionEvidenceV1Schema.parse(raw);
    if (
      parsed.action !== target.action || parsed.runId !== target.runId ||
      parsed.operation !== target.operation || parsed.walletRequestHash !== target.walletRequestHash
    ) {
      throw new Error("PHASE8_EVIDENCE_INVALID");
    }
    const serialized = JSON.stringify(parsed);
    if (sensitiveValues.some((value) => value.length >= 8 && serialized.includes(value))) {
      throw new Error("PHASE8_EVIDENCE_INVALID");
    }
    return deepFreeze(parsed);
  } catch {
    throw new Error("PHASE8_EVIDENCE_INVALID");
  }
}
