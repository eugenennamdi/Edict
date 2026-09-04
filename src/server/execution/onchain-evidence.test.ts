import { describe, expect, it } from "vitest";
import {
  compareWalletRequestToRpcTransaction,
  createTransactionReceiptEvidence,
  rpcTransactionReceiptV1Schema,
  rpcTransactionV1Schema,
} from "./onchain-evidence";

const HASH = `0x${"11".repeat(32)}`;
const BLOCK_HASH = `0x${"22".repeat(32)}`;
const FINALIZED_HASH = `0x${"33".repeat(32)}`;
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const ACCESS_ADDRESS = "0x3333333333333333333333333333333333333333";
const STORAGE_KEY = `0x${"44".repeat(32)}`;
const OBSERVED_AT = "2026-09-04T12:00:00.000Z";

const walletRequest = {
  from: FROM,
  to: TO,
  data: "0xabcdef",
  value: "0x0",
  nonce: "0x7",
  type: "0x2",
  gas: "0x5208",
  maxFeePerGas: "0x64",
  maxPriorityFeePerGas: "0x2",
  accessList: [{ address: ACCESS_ADDRESS, storageKeys: [STORAGE_KEY] }],
} as const;

const rpcTransaction = {
  hash: HASH,
  chainId: "0xaa36a7",
  from: FROM,
  to: TO,
  input: "0xabcdef",
  value: "0x0",
  nonce: "0x7",
  type: "0x2",
  gas: "0x5208",
  gasPrice: "0x3",
  maxFeePerGas: "0x64",
  maxPriorityFeePerGas: "0x2",
  accessList: [{ address: ACCESS_ADDRESS, storageKeys: [STORAGE_KEY] }],
  blockHash: BLOCK_HASH,
  blockNumber: "0x20",
  transactionIndex: "0x1",
  v: "0x1",
  r: `0x${"55".repeat(32)}`,
  s: `0x${"66".repeat(32)}`,
  yParity: "0x1",
} as const;

const rpcReceipt = {
  transactionHash: HASH,
  transactionIndex: "0x1",
  blockHash: BLOCK_HASH,
  blockNumber: "0x20",
  from: FROM,
  to: TO,
  cumulativeGasUsed: "0x5100",
  gasUsed: "0x5000",
  effectiveGasPrice: "0x3",
  contractAddress: null,
  logs: [],
  logsBloom: "0x",
  type: "0x2",
  status: "0x1",
} as const;

async function compare(
  transaction: Record<string, unknown> = rpcTransaction,
  request: Record<string, unknown> = walletRequest,
) {
  return compareWalletRequestToRpcTransaction({
    walletRequest: request,
    expectedChainId: "11155111",
    expectedHash: HASH,
    rpcTransaction: transaction,
    observedAt: OBSERVED_AT,
  });
}

describe("strict wallet-request and onchain-transaction evidence", () => {
  it("records exact and semantic matches while classifying type-2 gasPrice as derived", async () => {
    const evidence = await compare();
    expect(evidence.comparisonStatus).toBe("MATCH");
    expect(evidence.reconciliationStatus).toBe("CLEAR");
    expect(evidence.fields.input).toBe("EXACT_MATCH");
    expect(evidence.fields.gas).toBe("SEMANTIC_MATCH");
    expect(evidence.fields.gasPrice).toBe("DERIVED_RESPONSE_FIELD");
    expect(evidence.inputBytes).toBe(3);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.fields)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("abcdef");
  });

  it.each([
    ["hash", { hash: `0x${"99".repeat(32)}` }],
    ["chainId", { chainId: "0x1" }],
    ["from", { from: "0x4444444444444444444444444444444444444444" }],
    ["to", { to: "0x4444444444444444444444444444444444444444" }],
    ["input", { input: "0xabcd00" }],
    ["value", { value: "0x1" }],
    ["nonce", { nonce: "0x8" }],
    ["type", { type: "0x1" }],
    ["gas", { gas: "0x5209" }],
    ["maxFeePerGas", { maxFeePerGas: "0x65" }],
    ["maxPriorityFeePerGas", { maxPriorityFeePerGas: "0x3" }],
    ["accessList", { accessList: [] }],
  ])("fails closed on a %s mismatch", async (field, patch) => {
    const evidence = await compare({ ...rpcTransaction, ...patch });
    expect(evidence.comparisonStatus).toBe("MISMATCH");
    expect(evidence.reconciliationStatus).toBe("REQUIRED");
    expect(evidence.fields[field as keyof typeof evidence.fields]).toBe("MISMATCH");
  });

  it("requires an exact legacy gasPrice without applying type-2 fee rules", async () => {
    const { maxFeePerGas: _requestMaxFee, maxPriorityFeePerGas: _requestPriorityFee, ...requestBase } = walletRequest;
    const { maxFeePerGas: _responseMaxFee, maxPriorityFeePerGas: _responsePriorityFee, ...responseBase } = rpcTransaction;
    const legacyRequest = {
      ...requestBase,
      type: "0x0",
      gasPrice: "0x3",
    };
    const legacyResponse = {
      ...responseBase,
      type: "0x0",
      gasPrice: "0x4",
    };
    const evidence = await compare(legacyResponse, legacyRequest);
    expect(evidence.fields.gasPrice).toBe("MISMATCH");
    expect(evidence.fields.maxFeePerGas).toBe("NOT_APPLICABLE");
  });

  it("rejects unknown genuinely signed fields and request-only aliases in RPC data", async () => {
    await expect(compare({ ...rpcTransaction, authorizationList: [] })).rejects.toThrow();
    expect(() => rpcTransactionV1Schema.parse({ ...rpcTransaction, data: "0xabcdef" })).toThrow();
  });

  it("rejects unsigned 256-bit overflow before comparison", async () => {
    await expect(compare({ ...rpcTransaction, value: `0x1${"0".repeat(64)}` })).rejects.toThrow();
  });
});

describe("transaction receipt evidence", () => {
  it("separates observed gas use/effective price and records finality", async () => {
    const transaction = await compare();
    const evidence = createTransactionReceiptEvidence({
      transaction,
      rpcReceipt,
      observedAt: OBSERVED_AT,
      finalizedBlock: { hash: FINALIZED_HASH, number: "0x21" },
    });
    expect(evidence.executionStatus).toBe("SUCCESS");
    expect(evidence.identityStatus).toBe("MATCH");
    expect(evidence.finalityStatus).toBe("FINALIZED");
    expect(evidence.effectiveGasPrice).toBe("0x3");
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it.each([
    ["transaction hash", { transactionHash: `0x${"99".repeat(32)}` }],
    ["block hash", { blockHash: `0x${"99".repeat(32)}` }],
    ["block number", { blockNumber: "0x21" }],
    ["transaction index", { transactionIndex: "0x2" }],
    ["sender", { from: "0x4444444444444444444444444444444444444444" }],
    ["destination", { to: "0x4444444444444444444444444444444444444444" }],
    ["gas use above limit", { gasUsed: "0x5209" }],
  ])("requires reconciliation on %s disagreement", async (_field, patch) => {
    const transaction = await compare();
    const evidence = createTransactionReceiptEvidence({
      transaction,
      rpcReceipt: { ...rpcReceipt, ...patch },
      observedAt: OBSERVED_AT,
    });
    expect(evidence.identityStatus).toBe("MISMATCH");
    expect(evidence.reconciliationStatus).toBe("REQUIRED");
  });

  it("records a reverted receipt without treating it as successful", async () => {
    const transaction = await compare();
    const evidence = createTransactionReceiptEvidence({
      transaction,
      rpcReceipt: { ...rpcReceipt, status: "0x0" },
      observedAt: OBSERVED_AT,
    });
    expect(evidence.executionStatus).toBe("REVERTED");
  });

  it("keeps strict receipt response fields", () => {
    expect(() => rpcTransactionReceiptV1Schema.parse({ ...rpcReceipt, rawReceipt: "unsafe" })).toThrow();
  });
});
