import "server-only";

import { z } from "zod";

/**
 * Canonicalizes a 32-byte EVM transaction hash to lowercase hexadecimal with 0x prefix.
 *
 * Rules:
 * 1. Require exactly 32-byte hex: ^0x[0-9a-fA-F]{64}$
 * 2. Normalize prefix to 0x
 * 3. Lowercase only the hex characters
 * 4. Preserve the exact 32 bytes (no viem toHex() or UTF-8 re-encoding)
 */
export function canonicalizeTxHash(hash: string): `0x${string}` {
  const match = hash.trim().match(/^0x([0-9a-fA-F]{64})$/i);
  if (!match) {
    throw new Error(`Invalid 32-byte EVM transaction hash: ${hash}`);
  }
  return `0x${match[1].toLowerCase()}`;
}

/**
 * Strict canonical correlation request input.
 */
export const brickkenCorrelationRequestSchema = z.strictObject({
  txId: z.string().min(1).max(256),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/i, {
      message: "Expected 32-byte EVM transaction hash.",
    })
    .transform(canonicalizeTxHash),
});

export type BrickkenCorrelationInput = z.infer<typeof brickkenCorrelationRequestSchema>;

/**
 * Schema for HTTP 202 client-broadcast correlation.
 *
 * Brickken Support confirmed only that results[0].result contains:
 * - transactionHash (32-byte hex)
 * - status == "pending"
 * - executionMode == "client-broadcast"
 *
 * It does NOT require preparedTxId or any equivalent outer field.
 * Undocumented extra fields are safely stripped and discarded.
 */
export const brickkenCorrelationResultItemSchema = z
  .object({
    transactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/i, {
        message: "Expected 32-byte EVM transaction hash in result.",
      })
      .transform(canonicalizeTxHash),
    status: z.literal("pending"),
    executionMode: z.literal("client-broadcast"),
  })
  .strip();

export const brickkenCorrelationSuccessWireSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            result: brickkenCorrelationResultItemSchema,
          })
          .strip(),
      )
      .length(1, { message: "Expected exactly one correlation result entry." }),
  })
  .strip();

export type BrickkenCorrelationSuccessWire = z.infer<
  typeof brickkenCorrelationSuccessWireSchema
>;

/**
 * Result taxonomy for Brickken client-broadcast correlation.
 */
export type BrickkenCorrelationOutcome =
  | "CORRELATED_PENDING"
  | "TEMPORARILY_NOT_FOUND"
  | "CORRELATION_CONTRADICTION"
  | "PREPARED_TRANSACTION_MISMATCH"
  | "CORRELATION_REFUSED"
  | "CORRELATION_UNCONFIRMED";

export interface BrickkenCorrelationEvidenceV1 {
  readonly evidenceVersion: "1.0";
  readonly correlatedAt: string;
  readonly txId: string;
  readonly txHash: string;
  readonly status: "pending";
  readonly executionMode: "client-broadcast";
}

export type BrickkenCorrelationResult =
  | {
      readonly outcome: "CORRELATED_PENDING";
      readonly retryable: false;
      readonly reconciliationRequired: false;
      readonly evidence: BrickkenCorrelationEvidenceV1;
    }
  | {
      readonly outcome: "TEMPORARILY_NOT_FOUND";
      readonly retryable: true;
      readonly reconciliationRequired: false;
      readonly reason: string;
      readonly httpStatus?: number;
    }
  | {
      readonly outcome: "CORRELATION_CONTRADICTION";
      readonly retryable: false;
      readonly reconciliationRequired: true;
      readonly reason: string;
      readonly httpStatus?: number;
      readonly returnedHash: string;
      readonly requestedHash: string;
    }
  | {
      readonly outcome: "PREPARED_TRANSACTION_MISMATCH";
      readonly retryable: false;
      readonly reconciliationRequired: true;
      readonly reason: string;
      readonly httpStatus?: number;
    }
  | {
      readonly outcome: "CORRELATION_REFUSED";
      readonly retryable: false;
      readonly reconciliationRequired: true;
      readonly reason: string;
      readonly httpStatus?: number;
    }
  | {
      readonly outcome: "CORRELATION_UNCONFIRMED";
      readonly retryable: true;
      readonly reconciliationRequired: false;
      readonly reason: string;
      readonly httpStatus?: number;
    };

export const BRICKKEN_TEMPORARY_NOT_FOUND_STRING =
  "Broadcast transaction was not found on the prepared chain" as const;

export const BRICKKEN_NONCE_MISMATCH_STRING =
  "Submitted transaction nonce does not match the prepared transaction" as const;

function extractReasonText(json: unknown, bodyText: string, status: number): string {
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object") {
      const errObj = record.error as Record<string, unknown>;
      if (typeof errObj.message === "string") return errObj.message;
    }
    if (record.errors && typeof record.errors === "object") {
      const errsObj = record.errors as Record<string, unknown>;
      if (typeof errsObj.messages === "string") return errsObj.messages;
      if (Array.isArray(errsObj.messages)) return errsObj.messages.join("; ");
    }
  }
  if (bodyText.trim().length > 0) {
    return bodyText.slice(0, 256);
  }
  return `HTTP ${status} response from Brickken.`;
}

/**
 * Classifies an HTTP response from POST /send-transactions according to the confirmed taxonomy.
 */
export function classifyCorrelationResponse(input: {
  readonly requestedTxHash: string;
  readonly txId: string;
  readonly status: number;
  readonly bodyText: string;
  readonly json: unknown;
  readonly correlatedAt: string;
}): BrickkenCorrelationResult {
  const canonicalRequestedHash = canonicalizeTxHash(input.requestedTxHash);

  // 1. Exact HTTP 202 success path
  if (input.status === 202) {
    const parsed = brickkenCorrelationSuccessWireSchema.safeParse(input.json);
    if (!parsed.success) {
      return Object.freeze({
        outcome: "CORRELATION_UNCONFIRMED",
        retryable: true,
        reconciliationRequired: false,
        reason: "HTTP 202 response body failed strict correlation schema validation.",
        httpStatus: 202,
      });
    }

    const firstResult = parsed.data.results[0].result;
    const returnedHash = canonicalizeTxHash(firstResult.transactionHash);

    // Verify returned hash matches requested durable hash exactly
    if (returnedHash !== canonicalRequestedHash) {
      return Object.freeze({
        outcome: "CORRELATION_CONTRADICTION",
        retryable: false,
        reconciliationRequired: true,
        reason: `Returned transactionHash (${returnedHash}) contradicts requested durable hash (${canonicalRequestedHash}).`,
        httpStatus: 202,
        returnedHash,
        requestedHash: canonicalRequestedHash,
      });
    }

    return Object.freeze({
      outcome: "CORRELATED_PENDING",
      retryable: false,
      reconciliationRequired: false,
      evidence: Object.freeze({
        evidenceVersion: "1.0",
        correlatedAt: input.correlatedAt,
        txId: input.txId,
        txHash: canonicalRequestedHash,
        status: "pending",
        executionMode: "client-broadcast",
      }),
    });
  }

  // 2. Non-202: inspect body text for confirmed exact strings
  if (input.bodyText.includes(BRICKKEN_TEMPORARY_NOT_FOUND_STRING)) {
    return Object.freeze({
      outcome: "TEMPORARILY_NOT_FOUND",
      retryable: true,
      reconciliationRequired: false,
      reason: BRICKKEN_TEMPORARY_NOT_FOUND_STRING,
      httpStatus: input.status,
    });
  }

  if (input.bodyText.includes(BRICKKEN_NONCE_MISMATCH_STRING)) {
    return Object.freeze({
      outcome: "PREPARED_TRANSACTION_MISMATCH",
      retryable: false,
      reconciliationRequired: true,
      reason: BRICKKEN_NONCE_MISMATCH_STRING,
      httpStatus: input.status,
    });
  }

  // 3. HTTP Server errors (5xx)
  if (input.status >= 500) {
    return Object.freeze({
      outcome: "CORRELATION_UNCONFIRMED",
      retryable: true,
      reconciliationRequired: false,
      reason: extractReasonText(input.json, input.bodyText, input.status),
      httpStatus: input.status,
    });
  }

  // 4. Definite client/account/license/validation rejections (4xx) post-broadcast
  // Since the transaction was already broadcast to the blockchain, refusal requires reconciliation
  if (
    input.status === 400 ||
    input.status === 401 ||
    input.status === 402 ||
    input.status === 403 ||
    input.status === 404 ||
    input.status === 422
  ) {
    return Object.freeze({
      outcome: "CORRELATION_REFUSED",
      retryable: false,
      reconciliationRequired: true,
      reason: extractReasonText(input.json, input.bodyText, input.status),
      httpStatus: input.status,
    });
  }

  // 5. Unexpected status codes (e.g. 200/201 instead of 202, or other status)
  return Object.freeze({
    outcome: "CORRELATION_UNCONFIRMED",
    retryable: true,
    reconciliationRequired: false,
    reason: `Unexpected HTTP status ${input.status} for correlation endpoint.`,
    httpStatus: input.status,
  });
}

/**
 * Classifies transport failures (network loss, timeout, abort) into the taxonomy.
 */
export function classifyCorrelationTransportError(error: unknown): BrickkenCorrelationResult {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    outcome: "CORRELATION_UNCONFIRMED",
    retryable: true,
    reconciliationRequired: false,
    reason,
  });
}

/**
 * Maximum permitted correlation attempts (1 initial attempt + at most 2 retries).
 */
export const MAX_CORRELATION_ATTEMPTS = 3;

export interface CorrelationPair {
  readonly txId: string;
  readonly txHash: string;
}

export interface CorrelationRetryEvaluationInput {
  readonly currentPair: CorrelationPair;
  readonly requestedPair: CorrelationPair;
  readonly attemptCount: number;
  readonly lastOutcome: BrickkenCorrelationOutcome;
}

export type CorrelationRetryAuthorization =
  | {
      readonly authorized: true;
      readonly nextAttempt: number;
      readonly pair: CorrelationPair;
      readonly reason: "RETRY_AUTHORIZED";
    }
  | {
      readonly authorized: false;
      readonly reason:
        | "PAIR_MISMATCH_TX_ID"
        | "PAIR_MISMATCH_TX_HASH"
        | "BUDGET_EXHAUSTED"
        | "OUTCOME_NOT_RETRYABLE"
        | "INVALID_ATTEMPT_COUNT";
    };

/**
 * Pure/offline correlation retry policy compatible with V4.
 *
 * Rules:
 * - initial attempt + at most 2 retries (max 3 attempts total)
 * - byte-identical logical pair: txId and canonical txHash must match exactly
 * - changed txId => reject (PAIR_MISMATCH_TX_ID)
 * - changed txHash => reject (PAIR_MISMATCH_TX_HASH)
 * - exhausted budget (attemptCount >= 3) => reject (BUDGET_EXHAUSTED)
 * - non-retryable outcomes (CORRELATION_REFUSED, CORRELATION_CONTRADICTION, PREPARED_TRANSACTION_MISMATCH, CORRELATED_PENDING) => reject (OUTCOME_NOT_RETRYABLE)
 * - NO call to eth_sendTransaction is EVER coupled to or permitted by this policy
 */
export function evaluateCorrelationRetry(
  input: CorrelationRetryEvaluationInput,
): CorrelationRetryAuthorization {
  if (input.currentPair.txId !== input.requestedPair.txId) {
    return Object.freeze({ authorized: false, reason: "PAIR_MISMATCH_TX_ID" });
  }

  const currentTxHash = canonicalizeTxHash(input.currentPair.txHash);
  const requestedTxHash = canonicalizeTxHash(input.requestedPair.txHash);
  if (currentTxHash !== requestedTxHash) {
    return Object.freeze({ authorized: false, reason: "PAIR_MISMATCH_TX_HASH" });
  }

  if (input.attemptCount < 1) {
    return Object.freeze({ authorized: false, reason: "INVALID_ATTEMPT_COUNT" });
  }

  if (input.attemptCount >= MAX_CORRELATION_ATTEMPTS) {
    return Object.freeze({ authorized: false, reason: "BUDGET_EXHAUSTED" });
  }

  if (
    input.lastOutcome !== "TEMPORARILY_NOT_FOUND" &&
    input.lastOutcome !== "CORRELATION_UNCONFIRMED"
  ) {
    return Object.freeze({ authorized: false, reason: "OUTCOME_NOT_RETRYABLE" });
  }

  return Object.freeze({
    authorized: true,
    nextAttempt: input.attemptCount + 1,
    pair: Object.freeze({
      txId: input.currentPair.txId,
      txHash: currentTxHash,
    }),
    reason: "RETRY_AUTHORIZED",
  });
}
