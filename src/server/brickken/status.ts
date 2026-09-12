import "server-only";

import { z } from "zod";

import { canonicalizeTxHash } from "./correlation";
import { BrickkenAdapterError } from "./errors";

/**
 * Strict locator schema enforcing exactly one locator: txId XOR hash.
 */
export const brickkenTransactionLocatorSchema = z
  .union([
    z.strictObject({
      txId: z.string().min(1).max(256),
      hash: z.undefined().optional(),
    }),
    z.strictObject({
      hash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/i, {
          message: "Expected 32-byte EVM transaction hash.",
        })
        .transform(canonicalizeTxHash),
      txId: z.undefined().optional(),
    }),
  ])
  .refine(
    (val) =>
      (val.txId !== undefined && val.hash === undefined) ||
      (val.hash !== undefined && val.txId === undefined),
    { message: "Must provide exactly one locator: txId XOR hash." },
  );

export type BrickkenTransactionLocator = z.infer<
  typeof brickkenTransactionLocatorSchema
>;

export type BrickkenTransactionLocatorInput =
  | BrickkenTransactionLocator
  | { readonly txId?: string; readonly hash?: string };

/**
 * Constructs a strict URL path with query string for GET /transaction-status.
 * Disallows arbitrary query parameters and strictly escapes the single locator.
 */
export function buildTransactionStatusPath(
  locator: BrickkenTransactionLocatorInput,
): string {
  const parsed = brickkenTransactionLocatorSchema.safeParse(locator);
  if (!parsed.success) {
    throw new Error(`Invalid transaction status locator: ${parsed.error.message}`);
  }

  if (parsed.data.txId !== undefined) {
    return `/transaction-status?txId=${encodeURIComponent(parsed.data.txId)}`;
  }
  return `/transaction-status?hash=${encodeURIComponent(parsed.data.hash!)}`;
}

/**
 * Bounded structural validation for GET /transaction-status responses:
 * - Confirms the response is a top-level JSON object
 * - Safely extracts optional fields: transactionHash, hash, status, error
 * - Strips and discards unknown extra fields (does not reject undocumented fields)
 * - Retains NO arbitrary upstream payload
 */
export const brickkenTransactionStatusStructuralSchema = z
  .object({
    status: z.string().min(1).max(64).optional(),
    transactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/i)
      .transform(canonicalizeTxHash)
      .optional(),
    hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/i)
      .transform(canonicalizeTxHash)
      .optional(),
    error: z.string().max(1024).nullable().optional(),
  })
  .strip();

export const brickkenTransactionStatusResponseSchema =
  brickkenTransactionStatusStructuralSchema;

export type BrickkenTransactionStatusWire = z.infer<
  typeof brickkenTransactionStatusStructuralSchema
>;

/**
 * Transient diagnostic output from the Brickken transaction status endpoint.
 * Notice: `diagnosticError` (and legacy `error`) is transient adapter diagnostic prose only;
 * it must NEVER be persisted or publicly projected as authoritative execution evidence.
 */
export interface BrickkenTransactionStatusResult {
  readonly httpStatus: number;
  readonly responseByteCount: number;
  readonly contentType: string | null;
  readonly transactionHash: string | null;
  readonly rawStatusText: string | null;
  readonly diagnosticError: string | null;
  /** @deprecated Transient diagnostic only. Never persist or publicly project raw upstream error prose as durable evidence. */
  readonly error: string | null;
}

export interface ParseTransactionStatusInput {
  readonly json: unknown;
  readonly locator: BrickkenTransactionLocatorInput;
  readonly expectedTxHash?: string;
  readonly httpStatus?: number;
  readonly responseByteCount?: number;
  readonly contentType?: string | null;
}

/**
 * Normalizes and validates the response from GET /transaction-status against:
 * 1. Dual hash consistency (transactionHash vs hash if both present)
 * 2. Expected durable hash binding (when expectedTxHash is supplied)
 * 3. Queried locator consistency
 */
export function parseTransactionStatusResponse(
  jsonOrInput: unknown | ParseTransactionStatusInput,
  locatorParam?: BrickkenTransactionLocatorInput,
  expectedTxHashParam?: string,
): BrickkenTransactionStatusResult {
  let rawJson: unknown;
  let locatorInput: BrickkenTransactionLocatorInput;
  let expectedTxHash: string | undefined;
  let httpStatus = 200;
  let responseByteCount = 0;
  let contentType: string | null = null;

  if (
    jsonOrInput &&
    typeof jsonOrInput === "object" &&
    "locator" in jsonOrInput &&
    "json" in jsonOrInput
  ) {
    const input = jsonOrInput as ParseTransactionStatusInput;
    rawJson = input.json;
    locatorInput = input.locator;
    expectedTxHash = input.expectedTxHash ?? expectedTxHashParam;
    httpStatus = input.httpStatus ?? 200;
    responseByteCount = input.responseByteCount ?? 0;
    contentType = input.contentType ?? null;
  } else {
    rawJson = jsonOrInput;
    if (!locatorParam) {
      throw new Error("Locator is required to parse transaction status response.");
    }
    locatorInput = locatorParam;
    expectedTxHash = expectedTxHashParam;
  }

  const parsedLocator = brickkenTransactionLocatorSchema.safeParse(locatorInput);
  if (!parsedLocator.success) {
    throw new Error(`Invalid transaction status locator: ${parsedLocator.error.message}`);
  }
  const locator: BrickkenTransactionLocator = parsedLocator.data;

  const parsed = brickkenTransactionStatusStructuralSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(
      `Transaction status response failed structural validation: ${parsed.error.message}`,
    );
  }

  const data = parsed.data;
  let effectiveHash: string | null = null;

  // Dual Hash Field Contradiction Rule:
  // If both transactionHash and hash are present, canonicalize both and require them to be identical.
  if (data.transactionHash !== undefined && data.hash !== undefined) {
    if (data.transactionHash !== data.hash) {
      throw new BrickkenAdapterError(
        "STATUS_CONTRADICTION",
        `Contradictory transaction hash fields in status response: transactionHash (${data.transactionHash}) vs hash (${data.hash}).`,
      );
    }
    effectiveHash = data.transactionHash;
  } else if (data.transactionHash !== undefined) {
    effectiveHash = data.transactionHash;
  } else if (data.hash !== undefined) {
    effectiveHash = data.hash;
  }

  // Status Hash Binding Rule:
  // 1. If expectedTxHash is provided (from server orchestration's durable record), validate against it.
  if (expectedTxHash !== undefined) {
    const canonicalExpected = canonicalizeTxHash(expectedTxHash);
    if (effectiveHash !== null && effectiveHash !== canonicalExpected) {
      throw new BrickkenAdapterError(
        "STATUS_CONTRADICTION",
        `Returned transaction hash (${effectiveHash}) contradicts expected durable hash (${canonicalExpected}).`,
      );
    }
  }

  // 2. If queried by hash locator, validate returned hash and ensure consistency with expectedTxHash if present.
  if (locator.hash !== undefined) {
    const canonicalLocator = canonicalizeTxHash(locator.hash);
    if (effectiveHash !== null && effectiveHash !== canonicalLocator) {
      throw new BrickkenAdapterError(
        "STATUS_CONTRADICTION",
        `Returned transaction hash (${effectiveHash}) does not match queried locator hash (${canonicalLocator}).`,
      );
    }
    if (expectedTxHash !== undefined) {
      const canonicalExpected = canonicalizeTxHash(expectedTxHash);
      if (canonicalLocator !== canonicalExpected) {
        throw new BrickkenAdapterError(
          "STATUS_CONTRADICTION",
          `Queried locator hash (${canonicalLocator}) contradicts expected durable hash (${canonicalExpected}).`,
        );
      }
    }
  }

  return Object.freeze({
    httpStatus,
    responseByteCount,
    contentType,
    transactionHash: effectiveHash,
    rawStatusText: data.status ?? null,
    diagnosticError: data.error ?? null,
    error: data.error ?? null,
  });
}

/**
 * Edict-owned structural evidence classification for GET /transaction-status evidence.
 *
 * Notice: This classification is purely structural and evidence-based.
 * It intentionally carries ZERO transaction lifecycle authority (e.g. no "success",
 * "failure", or "mined" semantics) because Brickken has not proven closed lifecycle
 * semantics for GET /transaction-status.
 *
 * - HASH_CONFIRMED: The endpoint returned a valid transaction hash matching expectedTxHash / locator.
 * - STRUCTURAL_ONLY: The endpoint returned a valid structural JSON object, but no transaction hash was present.
 * - STATUS_CONTRADICTION: Returned data contradicted expected durable evidence (e.g. hash mismatch).
 */
export const brickkenStatusEvidenceClassificationSchema = z.enum([
  "STRUCTURAL_ONLY",
  "HASH_CONFIRMED",
  "STATUS_CONTRADICTION",
]);

export type BrickkenStatusEvidenceClassification = z.infer<
  typeof brickkenStatusEvidenceClassificationSchema
>;

/**
 * Bounded raw status text: opaque upstream string up to 128 characters, trimmed.
 * It must NEVER be treated as lifecycle authority or automatically authorize execution advancement.
 */
export const rawStatusTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .nullable();

/**
 * Durable status evidence schema for Edict runs (Pass 3 / V4+).
 *
 * Requirements:
 * - Contains ONLY established facts:
 *   - evidenceVersion: "1.0"
 *   - observedAt: ISO datetime string
 *   - locator: strict locator (txId XOR hash)
 *   - confirmedTxHash: canonical 32-byte lowercase 0x hex hash, or null
 *   - rawStatusText: opaque bounded string (max 128 chars) or null
 *   - structuralClassification: Edict-owned structural classification (STRUCTURAL_ONLY | HASH_CONFIRMED | STATUS_CONTRADICTION)
 *   - httpStatus: transport HTTP status code (100-599)
 *   - responseByteCount: non-negative integer
 *   - contentType: string or null
 * - Upstream raw error prose is strictly excluded.
 * - Opaque upstream text like "success" or "rejected" is stored ONLY as rawStatusText and carries ZERO lifecycle authority.
 */
export const brickkenStatusDurableEvidenceSchema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  observedAt: z.string().datetime(),
  locator: brickkenTransactionLocatorSchema,
  confirmedTxHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/i)
    .transform(canonicalizeTxHash)
    .nullable(),
  rawStatusText: rawStatusTextSchema,
  structuralClassification: brickkenStatusEvidenceClassificationSchema,
  httpStatus: z.number().int().min(100).max(599),
  responseByteCount: z.number().int().nonnegative(),
  contentType: z.string().nullable(),
});

export type BrickkenStatusDurableEvidenceV1 = z.infer<
  typeof brickkenStatusDurableEvidenceSchema
>;

export interface BuildStatusDurableEvidenceInput {
  readonly diagnostic: BrickkenTransactionStatusResult;
  readonly locator: BrickkenTransactionLocatorInput;
  readonly observedAt?: string;
  readonly verifiedAt?: string;
}

/**
 * Pure builder creating durable status evidence from adapter diagnostic output.
 *
 * Rules:
 * - Upstream raw error prose is never carried forward into durable execution evidence.
 * - Upstream status text (e.g. "success", "rejected") is treated purely as opaque text (rawStatusText)
 *   and does NOT produce lifecycle success/failure semantics.
 * - When a transaction hash is present and confirmed: classification is "HASH_CONFIRMED".
 * - When no transaction hash is present: classification is "STRUCTURAL_ONLY".
 */
export function buildStatusDurableEvidence(
  input: BuildStatusDurableEvidenceInput,
): BrickkenStatusDurableEvidenceV1 {
  const observedAt = input.observedAt ?? input.verifiedAt ?? new Date().toISOString();
  let structuralClassification: BrickkenStatusEvidenceClassification;

  if (input.diagnostic.transactionHash !== null) {
    structuralClassification = "HASH_CONFIRMED";
  } else {
    structuralClassification = "STRUCTURAL_ONLY";
  }

  const parsedLocator = brickkenTransactionLocatorSchema.safeParse(input.locator);
  if (!parsedLocator.success) {
    throw new Error(`Invalid transaction status locator: ${parsedLocator.error.message}`);
  }

  const confirmedTxHash: `0x${string}` | null = input.diagnostic.transactionHash
    ? canonicalizeTxHash(input.diagnostic.transactionHash)
    : null;

  return Object.freeze({
    evidenceVersion: "1.0",
    observedAt,
    locator: parsedLocator.data,
    confirmedTxHash,
    rawStatusText: input.diagnostic.rawStatusText,
    structuralClassification,
    httpStatus: input.diagnostic.httpStatus,
    responseByteCount: input.diagnostic.responseByteCount,
    contentType: input.diagnostic.contentType,
  });
}
