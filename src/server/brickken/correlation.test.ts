import { describe, expect, it } from "vitest";
import {
  canonicalizeTxHash,
  brickkenCorrelationRequestSchema,
  brickkenCorrelationSuccessWireSchema,
  classifyCorrelationResponse,
  classifyCorrelationTransportError,
  evaluateCorrelationRetry,
  BRICKKEN_NONCE_MISMATCH_STRING,
  BRICKKEN_TEMPORARY_NOT_FOUND_STRING,
} from "./correlation";
import {
  buildTransactionStatusPath,
  parseTransactionStatusResponse,
  buildStatusDurableEvidence,
  brickkenStatusDurableEvidenceSchema,
  type BrickkenTransactionLocator,
} from "./status";
import {
  executeBrickkenDirectRequest,
} from "./transport";
import { createBrickkenServerAdapter } from "./adapter";
import { BrickkenAdapterError } from "./errors";

const TEST_KEY = "sk_sandbox_secret_key_12345";
const VALID_TX_ID = "brickken_tx_uuid_9999";
const VALID_TX_HASH =
  "0x9f2c1f4b6e8a3d5c7b0e1a2d4f6c8b0a3e5d7c9f1b3a5c7e9d1f3b5a7c9e1d3f";
const OTHER_TX_HASH =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain",
      ...headers,
    },
  });
}

describe("Brickken Client-Broadcast Correlation & Status Contracts", () => {
  describe("1. Hash Canonicalization and Correlation Request Schema", () => {
    it("golden test: mixed-case 32-byte hash normalizes to lowercase 0x and preserves exact bytes", () => {
      const mixedCase = "0xAbCdEf1234567890ABCDEF1234567890abcdef1234567890ABCDEF1234567890";
      const canonical = canonicalizeTxHash(mixedCase);

      // 1. Exactly 66 chars: 0x prefix + 64 hex characters
      expect(canonical).toMatch(/^0x[0-9a-f]{64}$/);
      expect(canonical).toBe("0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");

      // 2. Round-trip byte identity
      const inputBytes = Buffer.from(mixedCase.slice(2), "hex");
      const outputBytes = Buffer.from(canonical.slice(2), "hex");
      expect(inputBytes.length).toBe(32);
      expect(outputBytes.length).toBe(32);
      expect(Buffer.compare(inputBytes, outputBytes)).toBe(0);
    });

    it("canonicalizes 32-byte EVM transaction hashes to lowercase", () => {
      const mixedCase = "0x9F2C1F4B6E8A3D5C7B0E1A2D4F6C8B0A3E5D7C9F1B3A5C7E9D1F3B5A7C9E1D3F";
      const canonical = canonicalizeTxHash(mixedCase);
      expect(canonical).toBe(VALID_TX_HASH.toLowerCase());
      expect(canonicalizeTxHash(VALID_TX_HASH.toLowerCase())).toBe(VALID_TX_HASH.toLowerCase());
    });

    it("canonicalizeTxHash throws on malformed or non-32-byte hash", () => {
      expect(() => canonicalizeTxHash("0x123")).toThrow(/Invalid 32-byte EVM transaction hash/);
      expect(() => canonicalizeTxHash("not-a-hash")).toThrow(/Invalid 32-byte EVM transaction hash/);
      expect(() => canonicalizeTxHash("0x" + "g".repeat(64))).toThrow(/Invalid 32-byte EVM transaction hash/);
    });

    it("accepts valid txId and canonicalizes 32-byte txHash to lowercase", () => {
      const mixedCase = "0x9F2C1F4B6E8A3D5C7B0E1A2D4F6C8B0A3E5D7C9F1B3A5C7E9D1F3B5A7C9E1D3F";
      const parsed = brickkenCorrelationRequestSchema.safeParse({
        txId: VALID_TX_ID,
        txHash: mixedCase,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.txHash).toBe(VALID_TX_HASH.toLowerCase());
      }
    });

    it("rejects empty txId", () => {
      const parsed = brickkenCorrelationRequestSchema.safeParse({
        txId: "",
        txHash: VALID_TX_HASH,
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects malformed txHash (not 32-byte hex)", () => {
      expect(
        brickkenCorrelationRequestSchema.safeParse({
          txId: VALID_TX_ID,
          txHash: "0x123",
        }).success,
      ).toBe(false);

      expect(
        brickkenCorrelationRequestSchema.safeParse({
          txId: VALID_TX_ID,
          txHash: "not-a-hash",
        }).success,
      ).toBe(false);
    });

    it("rejects extraneous properties", () => {
      const parsed = brickkenCorrelationRequestSchema.safeParse({
        txId: VALID_TX_ID,
        txHash: VALID_TX_HASH,
        walletSendAuthority: true,
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("2. Correlation Success Contract (HTTP 202)", () => {
    it("parses valid HTTP 202 nested results[0].result response", () => {
      const wire = {
        results: [
          {
            result: {
              transactionHash: VALID_TX_HASH,
              status: "pending",
              executionMode: "client-broadcast",
            },
          },
        ],
      };

      const parsedWire = brickkenCorrelationSuccessWireSchema.safeParse(wire);
      expect(parsedWire.success).toBe(true);

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATED_PENDING");
      expect(classified.retryable).toBe(false);
      expect(classified.reconciliationRequired).toBe(false);
      if (classified.outcome === "CORRELATED_PENDING") {
        expect(classified.evidence).toEqual({
          evidenceVersion: "1.0",
          correlatedAt: "2026-09-12T00:00:00.000Z",
          txId: VALID_TX_ID,
          txHash: VALID_TX_HASH.toLowerCase(),
          status: "pending",
          executionMode: "client-broadcast",
        });
      }
    });

    it("accepts valid Brickken HTTP 202 response without preparedTxId", () => {
      const wire = {
        results: [
          {
            result: {
              transactionHash: VALID_TX_HASH,
              status: "pending",
              executionMode: "client-broadcast",
            },
          },
        ],
      };

      const parsed = brickkenCorrelationSuccessWireSchema.safeParse(wire);
      expect(parsed.success).toBe(true);

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATED_PENDING");
      expect(classified.retryable).toBe(false);
      expect(classified.reconciliationRequired).toBe(false);
    });

    it("safely strips and ignores undocumented additional response fields in HTTP 202", () => {
      const wireWithExtras = {
        timestamp: "2026-09-12T00:00:00.000Z",
        extraTopLevelField: "ignore-me",
        results: [
          {
            preparedTxId: "prep_12345",
            extraResultLevelField: true,
            result: {
              transactionHash: VALID_TX_HASH,
              status: "pending",
              executionMode: "client-broadcast",
              extraInnerField: "also-ignored",
            },
          },
        ],
      };

      const parsed = brickkenCorrelationSuccessWireSchema.safeParse(wireWithExtras);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({
          results: [
            {
              result: {
                transactionHash: VALID_TX_HASH.toLowerCase(),
                status: "pending",
                executionMode: "client-broadcast",
              },
            },
          ],
        });
        expect(parsed.data).not.toHaveProperty("extraTopLevelField");
        expect(parsed.data.results[0]).not.toHaveProperty("preparedTxId");
      }

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wireWithExtras),
        json: wireWithExtras,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATED_PENDING");
    });

    it("handles case-insensitive hash matching on 202", () => {
      const wire = {
        results: [
          {
            result: {
              transactionHash: VALID_TX_HASH.toUpperCase(),
              status: "pending",
              executionMode: "client-broadcast",
            },
          },
        ],
      };

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH.toLowerCase(),
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATED_PENDING");
    });
  });

  describe("3. Strict Failures on 202 Response", () => {
    it("fails on empty results array (zero correlation results rejected)", () => {
      const wire = { results: [] };
      expect(brickkenCorrelationSuccessWireSchema.safeParse(wire).success).toBe(false);

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
      expect(classified.retryable).toBe(true);
    });

    it("fails on multiple correlation results (exact-one contract rejected if > 1)", () => {
      const wire = {
        results: [
          {
            result: {
              transactionHash: VALID_TX_HASH,
              status: "pending",
              executionMode: "client-broadcast",
            },
          },
          {
            result: {
              transactionHash: OTHER_TX_HASH,
              status: "pending",
              executionMode: "client-broadcast",
            },
          },
        ],
      };
      expect(brickkenCorrelationSuccessWireSchema.safeParse(wire).success).toBe(false);

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
      expect(classified.retryable).toBe(true);
    });

    it("fails on missing or malformed result object", () => {
      const wire = { results: [{ wrongField: true }] };
      expect(brickkenCorrelationSuccessWireSchema.safeParse(wire).success).toBe(false);

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
    });

    it("fails on malformed transactionHash in result", () => {
      const wire = {
        results: [
          {
            result: {
              transactionHash: "0x123",
              status: "pending",
              executionMode: "client-broadcast",
            },
          },
        ],
      };
      expect(brickkenCorrelationSuccessWireSchema.safeParse(wire).success).toBe(false);

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
    });

    it("classifies wrong returned txHash as CORRELATION_CONTRADICTION requiring reconciliation", () => {
      const wire = {
        results: [
          {
            result: {
              transactionHash: OTHER_TX_HASH,
              status: "pending",
              executionMode: "client-broadcast",
            },
          },
        ],
      };

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_CONTRADICTION");
      expect(classified.retryable).toBe(false);
      expect(classified.reconciliationRequired).toBe(true);
      if (classified.outcome === "CORRELATION_CONTRADICTION") {
        expect(classified.returnedHash).toBe(OTHER_TX_HASH.toLowerCase());
        expect(classified.requestedHash).toBe(VALID_TX_HASH.toLowerCase());
      }
    });

    it("fails if status is not 'pending'", () => {
      const wire = {
        results: [
          {
            result: {
              transactionHash: VALID_TX_HASH,
              status: "success",
              executionMode: "client-broadcast",
            },
          },
        ],
      };
      expect(brickkenCorrelationSuccessWireSchema.safeParse(wire).success).toBe(false);

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
    });

    it("fails if executionMode is not 'client-broadcast'", () => {
      const wire = {
        results: [
          {
            result: {
              transactionHash: VALID_TX_HASH,
              status: "pending",
              executionMode: "brickken-relayed",
            },
          },
        ],
      };
      expect(brickkenCorrelationSuccessWireSchema.safeParse(wire).success).toBe(false);

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
    });

    it("fails on malformed JSON for 202", () => {
      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 202,
        bodyText: "not-json",
        json: null,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
      expect(classified.retryable).toBe(true);
    });

    it("treats unexpected 200 OK as CORRELATION_UNCONFIRMED", () => {
      const wire = { results: [] };
      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 200,
        bodyText: JSON.stringify(wire),
        json: wire,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
      expect(classified.retryable).toBe(true);
    });
  });

  describe("4. Classification of Error Conditions", () => {
    it("classifies confirmed temporary 'not found' condition as TEMPORARILY_NOT_FOUND", () => {
      const errorPayload = {
        message: BRICKKEN_TEMPORARY_NOT_FOUND_STRING,
      };

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 400,
        bodyText: JSON.stringify(errorPayload),
        json: errorPayload,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("TEMPORARILY_NOT_FOUND");
      expect(classified.retryable).toBe(true);
      expect(classified.reconciliationRequired).toBe(false);
      if (classified.outcome === "TEMPORARILY_NOT_FOUND") {
        expect(classified.reason).toBe(BRICKKEN_TEMPORARY_NOT_FOUND_STRING);
      }
    });

    it("classifies confirmed nonce mismatch as PREPARED_TRANSACTION_MISMATCH requiring reconciliation", () => {
      const errorPayload = {
        message: BRICKKEN_NONCE_MISMATCH_STRING,
      };

      const classified = classifyCorrelationResponse({
        requestedTxHash: VALID_TX_HASH,
        txId: VALID_TX_ID,
        status: 400,
        bodyText: JSON.stringify(errorPayload),
        json: errorPayload,
        correlatedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(classified.outcome).toBe("PREPARED_TRANSACTION_MISMATCH");
      expect(classified.retryable).toBe(false);
      expect(classified.reconciliationRequired).toBe(true);
      if (classified.outcome === "PREPARED_TRANSACTION_MISMATCH") {
        expect(classified.reason).toBe(BRICKKEN_NONCE_MISMATCH_STRING);
      }
    });

    it("classifies definite 4xx client errors post-broadcast as CORRELATION_REFUSED requiring reconciliation", () => {
      for (const status of [400, 401, 402, 403, 404, 422]) {
        const errorPayload = { message: `Rejection with code ${status}` };
        const classified = classifyCorrelationResponse({
          requestedTxHash: VALID_TX_HASH,
          txId: VALID_TX_ID,
          status,
          bodyText: JSON.stringify(errorPayload),
          json: errorPayload,
          correlatedAt: "2026-09-12T00:00:00.000Z",
        });

        expect(classified.outcome).toBe("CORRELATION_REFUSED");
        expect(classified.retryable).toBe(false);
        expect(classified.reconciliationRequired).toBe(true);
      }
    });

    it("classifies 5xx server errors as CORRELATION_UNCONFIRMED", () => {
      for (const status of [500, 502, 503, 504]) {
        const classified = classifyCorrelationResponse({
          requestedTxHash: VALID_TX_HASH,
          txId: VALID_TX_ID,
          status,
          bodyText: "Internal Server Error",
          json: null,
          correlatedAt: "2026-09-12T00:00:00.000Z",
        });

        expect(classified.outcome).toBe("CORRELATION_UNCONFIRMED");
        expect(classified.retryable).toBe(true);
        expect(classified.reconciliationRequired).toBe(false);
      }
    });

    it("classifies transport errors as CORRELATION_UNCONFIRMED", () => {
      const timeoutError = new Error("Request timed out after 10000ms");
      const classifiedTimeout = classifyCorrelationTransportError(timeoutError);
      expect(classifiedTimeout.outcome).toBe("CORRELATION_UNCONFIRMED");
      expect(classifiedTimeout.retryable).toBe(true);

      const netError = new Error("ECONNREFUSED");
      const classifiedNet = classifyCorrelationTransportError(netError);
      expect(classifiedNet.outcome).toBe("CORRELATION_UNCONFIRMED");
      expect(classifiedNet.retryable).toBe(true);
    });
  });

  describe("5. Pure Offline Retry Authorization", () => {
    const pair = { txId: VALID_TX_ID, txHash: VALID_TX_HASH };

    it("authorizes retry 1 (attemptCount: 1 -> nextAttempt: 2)", () => {
      const decision = evaluateCorrelationRetry({
        currentPair: pair,
        requestedPair: pair,
        attemptCount: 1,
        lastOutcome: "TEMPORARILY_NOT_FOUND",
      });

      expect(decision.authorized).toBe(true);
      if (decision.authorized) {
        expect(decision.nextAttempt).toBe(2);
        expect(decision.pair.txId).toBe(pair.txId);
        expect(decision.pair.txHash).toBe(pair.txHash.toLowerCase());
      }
    });

    it("authorizes retry 2 (attemptCount: 2 -> nextAttempt: 3)", () => {
      const decision = evaluateCorrelationRetry({
        currentPair: pair,
        requestedPair: pair,
        attemptCount: 2,
        lastOutcome: "CORRELATION_UNCONFIRMED",
      });

      expect(decision.authorized).toBe(true);
      if (decision.authorized) {
        expect(decision.nextAttempt).toBe(3);
      }
    });

    it("enforces budget cap of 3 attempts (attemptCount: 3 -> BUDGET_EXHAUSTED)", () => {
      const decision = evaluateCorrelationRetry({
        currentPair: pair,
        requestedPair: pair,
        attemptCount: 3,
        lastOutcome: "TEMPORARILY_NOT_FOUND",
      });

      expect(decision.authorized).toBe(false);
      if (!decision.authorized) {
        expect(decision.reason).toBe("BUDGET_EXHAUSTED");
      }
    });

    it("rejects changed txId", () => {
      const decision = evaluateCorrelationRetry({
        currentPair: pair,
        requestedPair: { txId: "different_tx_id", txHash: VALID_TX_HASH },
        attemptCount: 1,
        lastOutcome: "TEMPORARILY_NOT_FOUND",
      });

      expect(decision.authorized).toBe(false);
      if (!decision.authorized) {
        expect(decision.reason).toBe("PAIR_MISMATCH_TX_ID");
      }
    });

    it("rejects changed txHash", () => {
      const decision = evaluateCorrelationRetry({
        currentPair: pair,
        requestedPair: { txId: VALID_TX_ID, txHash: OTHER_TX_HASH },
        attemptCount: 1,
        lastOutcome: "TEMPORARILY_NOT_FOUND",
      });

      expect(decision.authorized).toBe(false);
      if (!decision.authorized) {
        expect(decision.reason).toBe("PAIR_MISMATCH_TX_HASH");
      }
    });

    it("accepts mixed-case matching txHash via canonicalization", () => {
      const decision = evaluateCorrelationRetry({
        currentPair: { txId: VALID_TX_ID, txHash: VALID_TX_HASH.toUpperCase() },
        requestedPair: { txId: VALID_TX_ID, txHash: VALID_TX_HASH.toLowerCase() },
        attemptCount: 1,
        lastOutcome: "TEMPORARILY_NOT_FOUND",
      });

      expect(decision.authorized).toBe(true);
      if (decision.authorized) {
        expect(decision.pair.txHash).toBe(VALID_TX_HASH.toLowerCase());
      }
    });

    it("rejects non-retryable outcomes", () => {
      const outcomes = [
        "CORRELATION_REFUSED",
        "CORRELATION_CONTRADICTION",
        "PREPARED_TRANSACTION_MISMATCH",
        "CORRELATED_PENDING",
      ] as const;

      for (const outcome of outcomes) {
        const decision = evaluateCorrelationRetry({
          currentPair: pair,
          requestedPair: pair,
          attemptCount: 1,
          lastOutcome: outcome,
        });

        expect(decision.authorized).toBe(false);
        if (!decision.authorized) {
          expect(decision.reason).toBe("OUTCOME_NOT_RETRYABLE");
        }
      }
    });

    it("confirms zero wallet send authority is coupled to retry policy", () => {
      const decision = evaluateCorrelationRetry({
        currentPair: pair,
        requestedPair: pair,
        attemptCount: 1,
        lastOutcome: "TEMPORARILY_NOT_FOUND",
      });

      expect(decision).not.toHaveProperty("walletSendAuthority");
      expect(decision).not.toHaveProperty("broadcast");
      expect(decision).not.toHaveProperty("eth_sendTransaction");
    });
  });

  describe("6. Transaction Status Wire Contract", () => {
    it("builds strict path with txId locator", () => {
      const path = buildTransactionStatusPath({ txId: "tx-abc-123" });
      expect(path).toBe("/transaction-status?txId=tx-abc-123");
    });

    it("builds strict path with hash locator", () => {
      const path = buildTransactionStatusPath({ hash: VALID_TX_HASH });
      expect(path).toBe(`/transaction-status?hash=${encodeURIComponent(VALID_TX_HASH)}`);
    });

    it("escapes special characters in txId locator", () => {
      const path = buildTransactionStatusPath({ txId: "id with spaces&symbols" });
      expect(path).toBe("/transaction-status?txId=id%20with%20spaces%26symbols");
    });

    it("refuses if both txId and hash are supplied", () => {
      expect(() =>
        buildTransactionStatusPath({
          txId: "tx-abc",
          hash: VALID_TX_HASH,
        } as unknown as BrickkenTransactionLocator),
      ).toThrow();
    });

    it("refuses if neither locator is supplied", () => {
      expect(() =>
        buildTransactionStatusPath({} as unknown as BrickkenTransactionLocator),
      ).toThrow();
    });

    it("parses valid status response variants structurally without inferred enum", () => {
      const pendingRes = parseTransactionStatusResponse(
        { status: "pending" },
        { txId: "tx-123" },
      );
      expect(pendingRes.rawStatusText).toBe("pending");
      expect(pendingRes.transactionHash).toBeNull();
      expect(pendingRes.error).toBeNull();

      const successRes = parseTransactionStatusResponse(
        { status: "success", transactionHash: VALID_TX_HASH },
        { txId: "tx-123" },
      );
      expect(successRes.rawStatusText).toBe("success");
      expect(successRes.transactionHash).toBe(VALID_TX_HASH.toLowerCase());

      const rejectedRes = parseTransactionStatusResponse(
        { status: "rejected", error: "Execution reverted" },
        { txId: "tx-123" },
      );
      expect(rejectedRes.rawStatusText).toBe("rejected");
      expect(rejectedRes.error).toBe("Execution reverted");
    });

    it("preserves unproven status strings without failing schema validation", () => {
      const confirmedRes = parseTransactionStatusResponse(
        { status: "confirmed", transactionHash: VALID_TX_HASH },
        { txId: "tx-123" },
      );
      expect(confirmedRes.rawStatusText).toBe("confirmed");
      expect(confirmedRes.transactionHash).toBe(VALID_TX_HASH.toLowerCase());

      const completedRes = parseTransactionStatusResponse(
        { status: "completed" },
        { txId: "tx-123" },
      );
      expect(completedRes.rawStatusText).toBe("completed");
    });

    it("validates returned hash matches queried locator hash case-insensitively", () => {
      const matched = parseTransactionStatusResponse(
        { status: "success", transactionHash: VALID_TX_HASH.toUpperCase() },
        { hash: VALID_TX_HASH.toLowerCase() },
      );
      expect(matched.transactionHash).toBe(VALID_TX_HASH.toLowerCase());

      expect(() =>
        parseTransactionStatusResponse(
          { status: "success", transactionHash: OTHER_TX_HASH },
          { hash: VALID_TX_HASH },
        ),
      ).toThrow(/does not match/);
    });

    it("txId lookup + matching returned hash succeeds when expectedTxHash matches", () => {
      const matched = parseTransactionStatusResponse({
        json: { status: "success", transactionHash: VALID_TX_HASH },
        locator: { txId: "tx-123" },
        expectedTxHash: VALID_TX_HASH,
      });
      expect(matched.transactionHash).toBe(VALID_TX_HASH.toLowerCase());
    });

    it("txId lookup + different returned hash fails closed as STATUS_CONTRADICTION", () => {
      let caught: unknown = null;
      try {
        parseTransactionStatusResponse({
          json: { status: "success", transactionHash: OTHER_TX_HASH },
          locator: { txId: "tx-123" },
          expectedTxHash: VALID_TX_HASH,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BrickkenAdapterError);
      expect((caught as BrickkenAdapterError).code).toBe("STATUS_CONTRADICTION");
      expect((caught as BrickkenAdapterError).message).toContain("contradicts expected durable hash");
    });

    it("response containing transactionHash + hash equal succeeds", () => {
      const dualEqual = parseTransactionStatusResponse(
        {
          status: "pending",
          transactionHash: VALID_TX_HASH.toUpperCase(),
          hash: VALID_TX_HASH.toLowerCase(),
        },
        { txId: "tx-123" },
      );
      expect(dualEqual.transactionHash).toBe(VALID_TX_HASH.toLowerCase());
    });

    it("response containing transactionHash + hash different is rejected as contradictory evidence", () => {
      let caught: unknown = null;
      try {
        parseTransactionStatusResponse(
          {
            status: "pending",
            transactionHash: VALID_TX_HASH,
            hash: OTHER_TX_HASH,
          },
          { txId: "tx-123" },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BrickkenAdapterError);
      expect((caught as BrickkenAdapterError).code).toBe("STATUS_CONTRADICTION");
      expect((caught as BrickkenAdapterError).message).toContain("Contradictory transaction hash fields");
    });

    it("response containing neither hash remains structurally parseable if otherwise valid", () => {
      const neitherHash = parseTransactionStatusResponse(
        { status: "pending" },
        { txId: "tx-123" },
        VALID_TX_HASH,
      );
      expect(neitherHash.transactionHash).toBeNull();
      expect(neitherHash.rawStatusText).toBe("pending");
    });

    it("unknown extra top-level fields are discarded, not persisted", () => {
      const res = parseTransactionStatusResponse(
        {
          status: "confirmed",
          transactionHash: VALID_TX_HASH,
          arbitraryUpstreamField: "extra-data-should-not-be-in-evidence",
          nestedUndocumentedObject: { foo: "bar" },
        },
        { txId: "tx-123" },
      );

      expect(res).not.toHaveProperty("arbitraryUpstreamField");
      expect(res).not.toHaveProperty("nestedUndocumentedObject");
      expect(res).not.toHaveProperty("rawResponseSanitized");
      expect(res).toEqual({
        httpStatus: 200,
        responseByteCount: 0,
        contentType: null,
        transactionHash: VALID_TX_HASH.toLowerCase(),
        rawStatusText: "confirmed",
        diagnosticError: null,
        error: null,
      });
    });

    it("rejects invalid hash format in status response", () => {
      expect(() =>
        parseTransactionStatusResponse(
          { status: "success", transactionHash: "not-a-valid-hash" },
          { txId: "tx-123" },
        ),
      ).toThrow(/structural validation/);
    });

    it("raw upstream error prose is excluded from durable status evidence", () => {
      const diagnostic = parseTransactionStatusResponse(
        { status: "rejected", error: "Proprietary internal upstream error text" },
        { txId: "tx-123" },
      );
      expect(diagnostic.diagnosticError).toBe("Proprietary internal upstream error text");
      expect(diagnostic.error).toBe("Proprietary internal upstream error text");

      const durableEvidence = buildStatusDurableEvidence({
        diagnostic,
        locator: { txId: "tx-123" },
        observedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(durableEvidence).not.toHaveProperty("error");
      expect(durableEvidence).not.toHaveProperty("diagnosticError");
      expect(durableEvidence).toEqual({
        evidenceVersion: "1.0",
        observedAt: "2026-09-12T00:00:00.000Z",
        locator: { txId: "tx-123" },
        confirmedTxHash: null,
        rawStatusText: "rejected",
        structuralClassification: "STRUCTURAL_ONLY",
        httpStatus: 200,
        responseByteCount: 0,
        contentType: null,
      });
      expect(brickkenStatusDurableEvidenceSchema.safeParse(durableEvidence).success).toBe(true);
    });

    it('rawStatusText "success" does NOT create durable success semantics', () => {
      // Case A: status is "success" but no hash is present -> STRUCTURAL_ONLY
      const diagnosticNoHash = parseTransactionStatusResponse(
        { status: "success" },
        { txId: "tx-123" },
      );
      const evidenceNoHash = buildStatusDurableEvidence({
        diagnostic: diagnosticNoHash,
        locator: { txId: "tx-123" },
        observedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(evidenceNoHash.rawStatusText).toBe("success");
      expect(evidenceNoHash.confirmedTxHash).toBeNull();
      expect(evidenceNoHash.structuralClassification).toBe("STRUCTURAL_ONLY");
      expect(evidenceNoHash).not.toHaveProperty("statusClassification");
      expect(evidenceNoHash).not.toHaveProperty("success");
      expect(evidenceNoHash).not.toHaveProperty("isSuccess");

      // Case B: status is "success" and hash is present -> HASH_CONFIRMED
      const diagnosticWithHash = parseTransactionStatusResponse(
        { status: "success", transactionHash: VALID_TX_HASH },
        { txId: "tx-123" },
        VALID_TX_HASH,
      );
      const evidenceWithHash = buildStatusDurableEvidence({
        diagnostic: diagnosticWithHash,
        locator: { txId: "tx-123" },
        observedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(evidenceWithHash.rawStatusText).toBe("success");
      expect(evidenceWithHash.confirmedTxHash).toBe(VALID_TX_HASH.toLowerCase());
      expect(evidenceWithHash.structuralClassification).toBe("HASH_CONFIRMED");
      expect(evidenceWithHash).not.toHaveProperty("lifecycleStatus");
      expect(evidenceWithHash).not.toHaveProperty("statusClassification");
      expect(evidenceWithHash).not.toHaveProperty("nextOperationAuthority");
      expect(evidenceWithHash).not.toHaveProperty("walletSendAuthority");
    });

    it('rawStatusText "rejected" does NOT create durable failure semantics', () => {
      const diagnostic = parseTransactionStatusResponse(
        { status: "rejected" },
        { txId: "tx-123" },
      );
      const evidence = buildStatusDurableEvidence({
        diagnostic,
        locator: { txId: "tx-123" },
        observedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(evidence.rawStatusText).toBe("rejected");
      expect(evidence.confirmedTxHash).toBeNull();
      expect(evidence.structuralClassification).toBe("STRUCTURAL_ONLY");
      expect(evidence).not.toHaveProperty("statusClassification");
      expect(evidence).not.toHaveProperty("executionFailed");
      expect(evidence).not.toHaveProperty("failure");
    });

    it("durable status evidence is strictly structural without lifecycle authority", () => {
      const diagnostic = parseTransactionStatusResponse(
        { status: "arbitrary_value_123", transactionHash: VALID_TX_HASH },
        { txId: "tx-123" },
        VALID_TX_HASH,
      );
      const evidence = buildStatusDurableEvidence({
        diagnostic,
        locator: { txId: "tx-123" },
        observedAt: "2026-09-12T00:00:00.000Z",
      });

      expect(evidence.structuralClassification).toBe("HASH_CONFIRMED");
      expect(evidence.rawStatusText).toBe("arbitrary_value_123");
      expect(evidence.confirmedTxHash).toBe(VALID_TX_HASH.toLowerCase());

      const parsed = brickkenStatusDurableEvidenceSchema.safeParse(evidence);
      expect(parsed.success).toBe(true);

      // Speculative lifecycle classifications must fail validation
      expect(
        brickkenStatusDurableEvidenceSchema.safeParse({
          ...evidence,
          structuralClassification: "SUCCESS",
        }).success,
      ).toBe(false);

      expect(
        brickkenStatusDurableEvidenceSchema.safeParse({
          ...evidence,
          structuralClassification: "PENDING",
        }).success,
      ).toBe(false);

      expect(
        brickkenStatusDurableEvidenceSchema.safeParse({
          ...evidence,
          structuralClassification: "REJECTED",
        }).success,
      ).toBe(false);
    });

    it("confirms zero wallet send authority or next-operation authority across all status parsing paths", () => {
      const res = parseTransactionStatusResponse(
        { status: "success", transactionHash: VALID_TX_HASH },
        { txId: "tx-123" },
        VALID_TX_HASH,
      );
      expect(res).not.toHaveProperty("walletSendAuthority");
      expect(res).not.toHaveProperty("nextOperationAuthority");
      expect(res).not.toHaveProperty("broadcast");
      expect(res).not.toHaveProperty("eth_sendTransaction");

      const durableEvidence = buildStatusDurableEvidence({
        diagnostic: res,
        locator: { txId: "tx-123" },
        observedAt: "2026-09-12T00:00:00.000Z",
      });
      expect(durableEvidence).not.toHaveProperty("walletSendAuthority");
      expect(durableEvidence).not.toHaveProperty("nextOperationAuthority");
      expect(durableEvidence).not.toHaveProperty("broadcast");
      expect(durableEvidence).not.toHaveProperty("eth_sendTransaction");
    });
  });

  describe("7. Transport Hardening Boundary", () => {
    it("refuses redirects explicitly", async () => {
      await expect(
        executeBrickkenDirectRequest({
          path: "/transaction-status?txId=test",
          method: "GET",
          fetch: async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://api.sandbox.brickken.com/other" },
            }),
          runtimeConfig: {
            apiKey: TEST_KEY,
            baseUrl: "https://api.sandbox.brickken.com",
            chainId: "11155111",
          },
        }),
      ).rejects.toThrow(/redirect/i);
    });

    it("refuses oversized responses exceeding body limit", async () => {
      const bigText = "A".repeat(100);
      await expect(
        executeBrickkenDirectRequest({
          path: "/transaction-status?txId=test",
          method: "GET",
          maxResponseSizeBytes: 50,
          fetch: async () => textResponse(bigText, 200),
          runtimeConfig: {
            apiKey: TEST_KEY,
            baseUrl: "https://api.sandbox.brickken.com",
            chainId: "11155111",
          },
        }),
      ).rejects.toThrow(/limit/i);
    });

    it("refuses responses whose Content-Length header exceeds limit before streaming", async () => {
      await expect(
        executeBrickkenDirectRequest({
          path: "/transaction-status?txId=test",
          method: "GET",
          maxResponseSizeBytes: 50,
          fetch: async () =>
            textResponse("tiny", 200, { "content-length": "10000000" }),
          runtimeConfig: {
            apiKey: TEST_KEY,
            baseUrl: "https://api.sandbox.brickken.com",
            chainId: "11155111",
          },
        }),
      ).rejects.toThrow(/limit/i);
    });

    it("refuses response containing API key in body text", async () => {
      await expect(
        executeBrickkenDirectRequest({
          path: "/transaction-status?txId=test",
          method: "GET",
          fetch: async () => textResponse(`leaked key: ${TEST_KEY}`, 200),
          runtimeConfig: {
            apiKey: TEST_KEY,
            baseUrl: "https://api.sandbox.brickken.com",
            chainId: "11155111",
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses response with Content-Type application/json but malformed JSON", async () => {
      await expect(
        executeBrickkenDirectRequest({
          path: "/transaction-status?txId=test",
          method: "GET",
          fetch: async () => textResponse("invalid-json{", 200, { "content-type": "application/json" }),
          runtimeConfig: {
            apiKey: TEST_KEY,
            baseUrl: "https://api.sandbox.brickken.com",
            chainId: "11155111",
          },
        }),
      ).rejects.toThrow(/JSON/i);
    });

    it("refuses non-sandbox base URL", async () => {
      let caught: unknown = null;
      try {
        await executeBrickkenDirectRequest({
          path: "/transaction-status?txId=test",
          method: "GET",
          fetch: async () => jsonResponse({}),
          runtimeConfig: {
            apiKey: TEST_KEY,
            baseUrl: "https://api.brickken.com", // production URL forbidden
            chainId: "11155111",
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BrickkenAdapterError);
      expect((caught as BrickkenAdapterError).code).toBe("CONFIGURATION_MISSING");
      expect((caught as BrickkenAdapterError).message).toContain("not allowlisted");
    });
  });

  describe("8. Adapter Integration (correlateClientBroadcast & getTransactionStatus)", () => {
    it("executes correlateClientBroadcast successfully via fake transport", async () => {
      const adapter = createBrickkenServerAdapter({
        runtimeConfig: {
          apiKey: TEST_KEY,
          baseUrl: "https://api.sandbox.brickken.com",
          chainId: "11155111",
        },
        fetch: async (input, init) => {
          const url = String(input);
          expect(url).toBe("https://api.sandbox.brickken.com/send-transactions");
          expect(init?.method).toBe("POST");
          const reqBody = JSON.parse(String(init?.body));
          expect(reqBody).toEqual({ txId: VALID_TX_ID, txHash: VALID_TX_HASH });

          return jsonResponse(
            {
              results: [
                {
                  result: {
                    transactionHash: VALID_TX_HASH,
                    status: "pending",
                    executionMode: "client-broadcast",
                  },
                },
              ],
            },
            202,
          );
        },
      });

      const result = await adapter.correlateClientBroadcast({
        txId: VALID_TX_ID,
        txHash: VALID_TX_HASH,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe("CORRELATED_PENDING");
        expect(result.value.retryable).toBe(false);
      }
    });

    it("handles correlateClientBroadcast 400 temporary not found", async () => {
      const adapter = createBrickkenServerAdapter({
        runtimeConfig: {
          apiKey: TEST_KEY,
          baseUrl: "https://api.sandbox.brickken.com",
          chainId: "11155111",
        },
        fetch: async () =>
          jsonResponse({ message: BRICKKEN_TEMPORARY_NOT_FOUND_STRING }, 400),
      });

      const result = await adapter.correlateClientBroadcast({
        txId: VALID_TX_ID,
        txHash: VALID_TX_HASH,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe("TEMPORARILY_NOT_FOUND");
        expect(result.value.retryable).toBe(true);
      }
    });

    it("queries getTransactionStatus using direct /transaction-status path", async () => {
      let requestedUrl = "";
      const adapter = createBrickkenServerAdapter({
        runtimeConfig: {
          apiKey: TEST_KEY,
          baseUrl: "https://api.sandbox.brickken.com",
          chainId: "11155111",
        },
        fetch: async (input) => {
          requestedUrl = String(input);
          return jsonResponse({
            status: "success",
            transactionHash: VALID_TX_HASH,
          });
        },
      });

      const res = await adapter.getTransactionStatus({ txId: "tx-uuid-1" });
      expect(res.ok).toBe(true);
      expect(requestedUrl).toBe("https://api.sandbox.brickken.com/transaction-status?txId=tx-uuid-1");
      expect(requestedUrl).not.toContain("/get-transaction-status");
      if (res.ok) {
        expect(res.value.status).toBe("success");
        expect(res.value.transactionHash).toBe(VALID_TX_HASH.toLowerCase());
      }
    });

    it("refuses getTransactionStatus with invalid / conflicting query", async () => {
      const adapter = createBrickkenServerAdapter({
        runtimeConfig: {
          apiKey: TEST_KEY,
          baseUrl: "https://api.sandbox.brickken.com",
          chainId: "11155111",
        },
        fetch: async () => jsonResponse({ status: "pending" }),
      });

      const neither = await adapter.getTransactionStatus({});
      expect(neither.ok).toBe(false);

      const both = await adapter.getTransactionStatus({
        txId: "abc",
        hash: VALID_TX_HASH,
      });
      expect(both.ok).toBe(false);
    });

    it("validates expectedTxHash through adapter and fails closed on STATUS_CONTRADICTION", async () => {
      const adapter = createBrickkenServerAdapter({
        runtimeConfig: {
          apiKey: TEST_KEY,
          baseUrl: "https://api.sandbox.brickken.com",
          chainId: "11155111",
        },
        fetch: async () =>
          jsonResponse({
            status: "success",
            transactionHash: OTHER_TX_HASH,
          }),
      });

      const res = await adapter.getTransactionStatus({
        txId: "tx-uuid-1",
        expectedTxHash: VALID_TX_HASH,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("STATUS_CONTRADICTION");
        expect(res.error.message).toContain("contradicts expected durable hash");
      }
    });

    it("succeeds through adapter when expectedTxHash matches returned transactionHash", async () => {
      const adapter = createBrickkenServerAdapter({
        runtimeConfig: {
          apiKey: TEST_KEY,
          baseUrl: "https://api.sandbox.brickken.com",
          chainId: "11155111",
        },
        fetch: async () =>
          jsonResponse({
            status: "success",
            transactionHash: VALID_TX_HASH,
          }),
      });

      const res = await adapter.getTransactionStatus({
        txId: "tx-uuid-1",
        expectedTxHash: VALID_TX_HASH,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.transactionHash).toBe(VALID_TX_HASH.toLowerCase());
        expect(res.value.status).toBe("success");
      }
    });
  });
});
