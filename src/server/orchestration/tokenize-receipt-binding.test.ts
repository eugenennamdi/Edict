import { describe, expect, it } from "vitest";
import type { NormalizedRpcLog, NormalizedRpcReceipt } from "../rpc";
import {
  deriveTokenizationEventEvidence,
  NEW_TOKENIZATION_EVENT_TOPIC,
  REVIEWED_SEPOLIA_FACTORY,
  REVIEWED_SEPOLIA_IMPLEMENTATION,
  TokenizeReceiptBindingError,
} from "./tokenize-receipt-binding";

const TX_HASH = `0x${"11".repeat(32)}`;
const OTHER_TX_HASH = `0x${"22".repeat(32)}`;
const BLOCK_HASH = `0x${"33".repeat(32)}`;
const TOKEN = "0x4444444444444444444444444444444444444444";
const ESCROW = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function indexed(value: string): string {
  return `0x${"0".repeat(24)}${value.slice(2).toLowerCase()}`;
}

function eventLog(patch: Partial<NormalizedRpcLog> = {}): NormalizedRpcLog {
  return {
    address: REVIEWED_SEPOLIA_FACTORY,
    topics: [
      NEW_TOKENIZATION_EVENT_TOPIC,
      `0x${"0".repeat(63)}1`,
      indexed(TOKEN),
      indexed(ESCROW),
    ],
    data: "0x",
    blockNumber: "0x10",
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    blockHash: BLOCK_HASH,
    logIndex: "0x4",
    removed: false,
    ...patch,
  };
}

function receipt(logs: readonly NormalizedRpcLog[] = [eventLog()]): NormalizedRpcReceipt {
  return {
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    blockHash: BLOCK_HASH,
    blockNumber: "0x10",
    from: OTHER,
    to: REVIEWED_SEPOLIA_FACTORY,
    cumulativeGasUsed: "0x100",
    gasUsed: "0x80",
    effectiveGasPrice: "0x10",
    contractAddress: null,
    logs,
    type: "0x2",
    status: "0x1",
  };
}

function derive(value = receipt(), expectedTransactionHash = TX_HASH) {
  return deriveTokenizationEventEvidence({
    receipt: value,
    expectedTransactionHash,
    implementationAddress: REVIEWED_SEPOLIA_IMPLEMENTATION,
  });
}

describe("finalized TOKENIZE receipt event binding", () => {
  it("derives the exact token and STO id from one factory NewTokenization log", () => {
    expect(derive()).toMatchObject({
      transactionHash: TX_HASH,
      factoryAddress: REVIEWED_SEPOLIA_FACTORY,
      implementationAddress: REVIEWED_SEPOLIA_IMPLEMENTATION,
      eventTopic: NEW_TOKENIZATION_EVENT_TOPIC,
      tokenizationId: "1",
      tokenAddress: TOKEN,
      escrowAddress: ESCROW,
    });
  });

  it("rejects a receipt from another transaction", () => {
    expect(() => derive(receipt(), OTHER_TX_HASH)).toThrow(TokenizeReceiptBindingError);
  });

  it("rejects same-signature logs emitted by another contract", () => {
    expect(() => derive(receipt([eventLog({ address: OTHER })]))).toThrow(
      TokenizeReceiptBindingError,
    );
  });

  it("ignores a same-signature decoy when the exact factory event is present", () => {
    const decoy = eventLog({ address: OTHER, logIndex: "0x3" });
    expect(derive(receipt([decoy, eventLog()])).tokenAddress).toBe(TOKEN);
  });

  it("rejects the wrong event topic", () => {
    expect(() => derive(receipt([eventLog({ topics: [TRANSFER_TOPIC] })]))).toThrow(
      TokenizeReceiptBindingError,
    );
  });

  it("rejects duplicate factory NewTokenization logs", () => {
    expect(() => derive(receipt([
      eventLog(),
      eventLog({ logIndex: "0x5" }),
    ]))).toThrow(TokenizeReceiptBindingError);
  });

  it("rejects malformed event data", () => {
    expect(() => derive(receipt([eventLog({ data: "0x00" })]))).toThrow(
      TokenizeReceiptBindingError,
    );
  });

  it("rejects a zero token address", () => {
    expect(() => derive(receipt([eventLog({
      topics: [
        NEW_TOKENIZATION_EVENT_TOPIC,
        `0x${"0".repeat(63)}1`,
        `0x${"0".repeat(64)}`,
        indexed(ESCROW),
      ],
    })]))).toThrow(TokenizeReceiptBindingError);
  });

  it("ignores an unrelated ERC20 Transfer in the same receipt", () => {
    const transfer = eventLog({
      address: TOKEN,
      topics: [TRANSFER_TOPIC, indexed(OTHER), indexed(TOKEN)],
      data: `0x${"0".repeat(63)}1`,
      logIndex: "0x3",
    });
    expect(derive(receipt([transfer, eventLog()])).tokenAddress).toBe(TOKEN);
  });

  it("rejects a different implementation at the exact receipt block", () => {
    expect(() => deriveTokenizationEventEvidence({
      receipt: receipt(),
      expectedTransactionHash: TX_HASH,
      implementationAddress: OTHER,
    })).toThrow(TokenizeReceiptBindingError);
  });
});
