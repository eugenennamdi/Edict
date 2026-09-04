import { describe, expect, it } from "vitest";
import encodingA from "./test-vectors/prepare/newTokenization.response.json";
import encodingBTx from "./test-vectors/prepare/unsigned-transaction.encoding-b.json";
import { parsePreparedOperation } from "./prepared-transaction";

describe("prepared transaction parsing", () => {
  it("accepts encoding A string fee fields and preserves the raw payload", () => {
    const result = parsePreparedOperation(encodingA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.txId).toBe(encodingA.txId);
    expect(result.value.transaction.value).toBe("0x00");
    expect(result.value.transaction.maxFeePerGas).toBe("1156037");
    expect(result.value.transaction.gasLimit).toBe("0xccef");
    expect(result.value.transaction.normalizedChainId).toBe("11155111");
    expect(result.value.transaction.rawUnsigned).toEqual(encodingA.transactions[0]);
    expect(result.value.transaction.rawUnsigned).not.toBe(encodingA.transactions[0]);
  });

  it("accepts encoding B BigNumber fields without rewriting them", () => {
    const result = parsePreparedOperation({
      txId: "0x46adea7bdf49c576a760102e0d6bc9ecd650b3998588cd3d7f576a7973426aad",
      transactions: [encodingBTx],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction.value).toEqual({ type: "BigNumber", hex: "0x00" });
    expect(result.value.transaction.gasLimit).toEqual({ type: "BigNumber", hex: "0x01e848" });
    expect(result.value.transaction.rawUnsigned).toEqual(encodingBTx);
  });

  it("accepts documented Sepolia chain-id equivalents", () => {
    for (const chainId of [11155111, "11155111", "0xaa36a7"]) {
      const result = parsePreparedOperation({
        ...encodingA,
        transactions: [{ ...encodingA.transactions[0], chainId }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.transaction.normalizedChainId).toBe("11155111");
    }
  });

  it("rejects empty and multi-transaction batches", () => {
    expect(parsePreparedOperation({ txId: "0x1", transactions: [] }).ok).toBe(false);
    expect(
      parsePreparedOperation({
        txId: ["0x1", "0x2"],
        transactions: [encodingA.transactions[0], encodingA.transactions[0]],
      }).ok,
    ).toBe(false);
    const empty = parsePreparedOperation({ txId: "0x1", transactions: [] });
    if (!empty.ok) expect(empty.error.code).toBe("UNSUPPORTED_TRANSACTION_BATCH");
  });

  it("rejects a non-Sepolia chain", () => {
    const result = parsePreparedOperation({
      ...encodingA,
      transactions: [{ ...encodingA.transactions[0], chainId: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_CHAIN");
  });

  it("does not invent a missing value field", () => {
    const incomplete = { ...encodingA.transactions[0] } as Record<string, unknown>;
    delete incomplete.value;
    const result = parsePreparedOperation({
      txId: encodingA.txId,
      transactions: [incomplete],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PREPARED_TRANSACTION_INCOMPLETE");
  });
});
