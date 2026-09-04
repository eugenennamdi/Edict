import { describe, expect, it } from "vitest";
import { decodeExecutionRunV1, encodeExecutionRunV1 } from "../persistence/codec";
import { createExecutionRunFixture } from "../persistence/test-fixtures";
import { IllegalStateTransitionError } from "./errors";
import {
  compareWalletRequestToRpcTransaction,
  createTransactionReceiptEvidence,
} from "./onchain-evidence";
import { applyRunEvent } from "./transitions";
import type { ExecutionRun, ExecutionRunEvent } from "./types";

const HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"cd".repeat(32)}`;
const BLOCK_HASH = `0x${"12".repeat(32)}`;
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x4444444444444444444444444444444444444444";
const AT = "2026-09-04T12:01:00.000Z";

const walletRequest = {
  from: FROM,
  to: TO,
  data: "0xabcdef",
  value: "0x0",
  nonce: "0x1",
  type: "0x2",
  gas: "0x5208",
  maxFeePerGas: "0x64",
  maxPriorityFeePerGas: "0x2",
};

function rpcTransaction(hash = HASH) {
  return {
    hash,
    chainId: "0xaa36a7",
    from: FROM,
    to: TO,
    input: "0xabcdef",
    value: "0x0",
    nonce: "0x1",
    type: "0x2",
    gas: "0x5208",
    gasPrice: "0x3",
    maxFeePerGas: "0x64",
    maxPriorityFeePerGas: "0x2",
    accessList: [],
    blockHash: BLOCK_HASH,
    blockNumber: "0x20",
    transactionIndex: "0x1",
  };
}

function receipt(hash = HASH) {
  return {
    transactionHash: hash,
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
  };
}

async function broadcastRun(): Promise<ExecutionRun> {
  const run = await createExecutionRunFixture();
  if (run.schemaVersion !== "2.0") throw new Error("Fixture must create V2.");
  return {
    ...run,
    phase: "TOKENIZATION",
    status: "BROADCAST_RECORDED",
    operations: [
      {
        ...run.operations[0],
        stage: "BROADCAST_HASH_PERSISTED",
        preparedTxId: "prepared-1",
        blockchainTxHash: HASH,
        broadcastAt: AT,
      },
      run.operations[1],
      run.operations[2],
    ],
  };
}

async function transactionEvidence(responseHash = HASH) {
  return compareWalletRequestToRpcTransaction({
    walletRequest,
    expectedChainId: "11155111",
    expectedHash: HASH,
    rpcTransaction: rpcTransaction(responseHash),
    observedAt: AT,
  });
}

function event<T extends ExecutionRunEvent>(value: T): T {
  return value;
}

describe("ExecutionRunV3 evidence transitions", () => {
  it("enters V3 only by recording validated transaction evidence", async () => {
    const original = await broadcastRun();
    const evidence = await transactionEvidence();
    const mutableEvidence = JSON.parse(JSON.stringify(evidence));
    const run = applyRunEvent(original, event({
      type: "RECORD_ONCHAIN_TRANSACTION_EVIDENCE",
      id: "evidence-1",
      at: AT,
      operationKind: "TOKENIZE",
      evidence: mutableEvidence,
    }));
    mutableEvidence.comparisonStatus = "MISMATCH";
    expect(original.schemaVersion).toBe("2.0");
    expect(run.schemaVersion).toBe("3.0");
    if (run.schemaVersion !== "3.0") throw new Error("Expected V3.");
    expect(run.operations[0].onchainTransactionEvidence?.comparisonStatus).toBe("MATCH");
    expect(Object.isFrozen(run.operations[0].onchainTransactionEvidence)).toBe(true);
    const decoded = decodeExecutionRunV1(encodeExecutionRunV1(run));
    expect(decoded.schemaVersion).toBe("3.0");
    expect(Object.isFrozen(decoded.operations[0])).toBe(true);
  });

  it("persists an unrelated returned hash as blocking reconciliation evidence", async () => {
    const original = await broadcastRun();
    const evidence = await transactionEvidence(OTHER_HASH);
    const run = applyRunEvent(original, event({
      type: "RECORD_ONCHAIN_TRANSACTION_EVIDENCE",
      id: "evidence-1",
      at: AT,
      operationKind: "TOKENIZE",
      evidence,
    }));
    expect(run.status).toBe("RECONCILIATION_REQUIRED");
    expect(() => applyRunEvent(run, event({
      type: "SUBMIT_CONFIRMATION",
      id: "confirm-1",
      at: "2026-09-04T12:01:01.000Z",
      operationKind: "TOKENIZE",
    }))).toThrow(IllegalStateTransitionError);
  });

  it("requires a successful matching finalized receipt before read-back", async () => {
    let run = applyRunEvent(await broadcastRun(), event({
      type: "RECORD_ONCHAIN_TRANSACTION_EVIDENCE",
      id: "evidence-1",
      at: AT,
      operationKind: "TOKENIZE",
      evidence: await transactionEvidence(),
    }));
    run = applyRunEvent(run, event({
      type: "SUBMIT_CONFIRMATION",
      id: "confirm-1",
      at: "2026-09-04T12:01:01.000Z",
      operationKind: "TOKENIZE",
    }));
    run = applyRunEvent(run, event({
      type: "RECORD_CONFIRMED",
      id: "confirmed-1",
      at: "2026-09-04T12:01:02.000Z",
      operationKind: "TOKENIZE",
    }));
    const transaction = run.schemaVersion === "3.0"
      ? run.operations[0].onchainTransactionEvidence
      : null;
    if (transaction === null) throw new Error("Expected transaction evidence.");
    const included = createTransactionReceiptEvidence({
      transaction,
      rpcReceipt: receipt(),
      observedAt: "2026-09-04T12:01:03.000Z",
    });
    run = applyRunEvent(run, event({
      type: "RECORD_TRANSACTION_RECEIPT_EVIDENCE",
      id: "receipt-1",
      at: included.observedAt,
      operationKind: "TOKENIZE",
      evidence: included,
    }));
    expect(() => applyRunEvent(run, event({
      type: "RECORD_READ_BACK_VERIFIED",
      id: "read-1",
      at: "2026-09-04T12:01:04.000Z",
      operationKind: "TOKENIZE",
      read: "verified",
    }))).toThrow(IllegalStateTransitionError);

    const finalized = createTransactionReceiptEvidence({
      transaction,
      rpcReceipt: receipt(),
      observedAt: "2026-09-04T12:01:05.000Z",
      finalizedBlock: { hash: `0x${"34".repeat(32)}`, number: "0x21" },
    });
    run = applyRunEvent(run, event({
      type: "RECORD_TRANSACTION_RECEIPT_EVIDENCE",
      id: "receipt-2",
      at: finalized.observedAt,
      operationKind: "TOKENIZE",
      evidence: finalized,
    }));
    run = applyRunEvent(run, event({
      type: "RECORD_READ_BACK_VERIFIED",
      id: "read-2",
      at: "2026-09-04T12:01:06.000Z",
      operationKind: "TOKENIZE",
      read: "verified",
    }));
    expect(run.operations[0].stage).toBe("READ_BACK_VERIFIED");
  });

  it("persists receipt/hash disagreement as reconciliation required", async () => {
    let run = applyRunEvent(await broadcastRun(), event({
      type: "RECORD_ONCHAIN_TRANSACTION_EVIDENCE",
      id: "evidence-1",
      at: AT,
      operationKind: "TOKENIZE",
      evidence: await transactionEvidence(),
    }));
    if (run.schemaVersion !== "3.0" || run.operations[0].onchainTransactionEvidence === null) {
      throw new Error("Expected V3 evidence.");
    }
    const receiptEvidence = createTransactionReceiptEvidence({
      transaction: run.operations[0].onchainTransactionEvidence,
      rpcReceipt: receipt(OTHER_HASH),
      observedAt: "2026-09-04T12:02:00.000Z",
    });
    run = applyRunEvent(run, event({
      type: "RECORD_TRANSACTION_RECEIPT_EVIDENCE",
      id: "receipt-1",
      at: receiptEvidence.observedAt,
      operationKind: "TOKENIZE",
      evidence: receiptEvidence,
    }));
    expect(run.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("rejects a cast-only V3 snapshot with no evidence and unknown V3 fields", async () => {
    const run = await createExecutionRunFixture();
    expect(() => encodeExecutionRunV1({
      ...run,
      schemaVersion: "3.0",
      operations: run.operations.map((operation) => ({
        ...operation,
        onchainTransactionEvidence: null,
        transactionReceiptEvidence: null,
      })),
    })).toThrow();
    const entered = applyRunEvent(await broadcastRun(), event({
      type: "RECORD_ONCHAIN_TRANSACTION_EVIDENCE",
      id: "evidence-1",
      at: AT,
      operationKind: "TOKENIZE",
      evidence: await transactionEvidence(),
    }));
    expect(() => encodeExecutionRunV1({ ...entered, unexpectedEvidence: true })).toThrow();
  });
});
