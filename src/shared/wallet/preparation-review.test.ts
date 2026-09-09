import { describe, expect, it } from "vitest";
import { TOKENIZER_ADDRESS } from "@/core/test-fixtures";
import {
  createPreparedTransactionReviewV1,
  validatePreparedTransactionReviewV1,
} from "./preparation-review";

const input = {
  reviewVersion: "1.0" as const,
  runId: "11111111-1111-4111-8111-111111111111",
  runRevision: 4,
  manifestHash: `sha256:${"1".repeat(64)}` as const,
  planHash: `sha256:${"2".repeat(64)}` as const,
  approvalRevision: 1,
  environment: "sandbox" as const,
  chainId: "11155111" as const,
  operation: { id: "operation-1", kind: "TOKENIZE" as const, sequence: 1 as const },
  requiredSigner: TOKENIZER_ADDRESS,
  brickken: { method: "newTokenization" as const, executionMode: "client-broadcast" as const },
  preparedTransactionId: "prepared-1",
  walletRequestVersion: "1.0" as const,
  walletRequest: {
    from: TOKENIZER_ADDRESS,
    to: "0x3333333333333333333333333333333333333333",
    data: "0x1234",
    value: "0x0",
    gas: "0x5208",
    nonce: "0x1",
    type: "0x2" as const,
    maxFeePerGas: "0x10",
    maxPriorityFeePerGas: "0x1",
  },
  chainRequirement: { mode: "PROVIDER_PRECONDITION" as const, decimalChainId: "11155111" as const, rpcChainId: "0xaa36a7" as const },
  calldataSemantics: "OPAQUE_SERVER_PREPARED" as const,
  walletConfirmation: "NOT_REQUESTED" as const,
};

describe("prepared transaction review", () => {
  it("creates a deterministic immutable fingerprint over the exact review identity", async () => {
    const first = await createPreparedTransactionReviewV1(input);
    const second = await createPreparedTransactionReviewV1(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.integrity.preparedTransactionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.walletRequest)).toBe(true);
    await expect(validatePreparedTransactionReviewV1(first)).resolves.toEqual(first);
  });

  it("rejects tampering, unknown fields, malformed calldata, and signer changes", async () => {
    const review = await createPreparedTransactionReviewV1(input);
    await expect(validatePreparedTransactionReviewV1({ ...review, requiredSigner: "0x4444444444444444444444444444444444444444" }))
      .rejects.toThrow("PREPARED_TRANSACTION_FINGERPRINT_MISMATCH");
    await expect(validatePreparedTransactionReviewV1({ ...review, rawResponse: "forbidden" })).rejects.toThrow();
    await expect(validatePreparedTransactionReviewV1({ ...review, walletRequest: { ...review.walletRequest, data: "0x123" } })).rejects.toThrow();
  });
});
