import "server-only";

import {
  transactionReceiptEvidenceV1Schema,
  type TransactionReceiptEvidenceV1,
} from "../execution/onchain-evidence";
import type {
  CanonicalityStatus,
  FinalityStatus,
  ReceiptFinalityEvaluation,
  ReceiptStatus,
  TrustedSepoliaRpcClient,
} from "./types";

export interface EvaluateReceiptAndFinalityInput {
  readonly client: TrustedSepoliaRpcClient;
  readonly txHash: string;
  readonly expectedFrom: string;
  readonly expectedTo: string;
  readonly expectedType?: "0x0" | "0x1" | "0x2";
  readonly gasLimit?: string;
  readonly observedAt: string;
}

function sameAddress(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Server-side evaluation of receipt, canonical inclusion, and Ethereum finalized head.
 *
 * Models receiptStatus, canonicality, and finality as three independent orthogonal axes:
 * - receiptStatus: NOT_FOUND | SUCCESS | REVERTED
 * - canonicality: NOT_EVALUATED | CANONICAL | CONTRADICTION
 * - finality: NOT_EVALUATED | INCLUDED | FINALIZED | UNAVAILABLE
 *
 * A status=0x1 receipt alone is NEVER sufficient to claim finality.
 * Finality is established only by Ethereum's finalized head, not by fixed confirmation counts.
 */
export async function evaluateReceiptAndFinality(
  input: EvaluateReceiptAndFinalityInput,
): Promise<ReceiptFinalityEvaluation> {
  const receipt = await input.client.getTransactionReceipt(input.txHash);
  if (receipt === null) {
    return Object.freeze({
      receiptStatus: "NOT_FOUND",
      canonicality: "NOT_EVALUATED",
      finality: "NOT_EVALUATED",
      receipt: null,
      canonicalBlock: null,
      finalizedBlock: null,
      evidence: null,
      reconciliationRequired: false,
    });
  }

  const receiptStatus: ReceiptStatus = receipt.status === "0x1" ? "SUCCESS" : "REVERTED";

  // Verify canonical inclusion block
  const canonicalBlock = await input.client.getBlockByNumber(receipt.blockNumber);
  const isCanonical =
    canonicalBlock !== null &&
    canonicalBlock.hash.toLowerCase() === receipt.blockHash.toLowerCase();

  const canonicality: CanonicalityStatus = isCanonical
    ? "CANONICAL"
    : "CONTRADICTION";

  if (canonicality === "CONTRADICTION") {
    // Reorg or block contradiction detected
    const evidence: TransactionReceiptEvidenceV1 = transactionReceiptEvidenceV1Schema.parse({
      evidenceVersion: "1.0",
      observedAt: input.observedAt,
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.transactionIndex,
      from: receipt.from,
      to: receipt.to,
      type: receipt.type,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      contractAddress: receipt.contractAddress,
      executionStatus: receiptStatus === "SUCCESS" ? "SUCCESS" : "REVERTED",
      identityStatus: "MISMATCH",
      finalityStatus: "INCLUDED",
      finalizedBlockHash: null,
      finalizedBlockNumber: null,
      reconciliationStatus: "REQUIRED",
    });

    return Object.freeze({
      receiptStatus,
      canonicality: "CONTRADICTION",
      finality: "NOT_EVALUATED",
      receipt,
      canonicalBlock,
      finalizedBlock: null,
      evidence,
      reconciliationRequired: true,
    });
  }

  // Canonical inclusion verified -> evaluate finalized head
  const finalizedBlock = await input.client.getFinalizedBlock();
  let finality: FinalityStatus = "UNAVAILABLE";

  if (finalizedBlock !== null) {
    const isFinalized = BigInt(finalizedBlock.number) >= BigInt(receipt.blockNumber);
    finality = isFinalized ? "FINALIZED" : "INCLUDED";
  }

  // Validate receipt identity matches expected execution parameters
  const fromMatches = sameAddress(receipt.from, input.expectedFrom);
  const toMatches = sameAddress(receipt.to, input.expectedTo);
  const typeMatches = receipt.type === (input.expectedType ?? "0x2");
  const gasLimitMatches =
    input.gasLimit === undefined || BigInt(receipt.gasUsed) <= BigInt(input.gasLimit);
  const noContractCreation = receipt.contractAddress === null;

  const identityMatches =
    fromMatches && toMatches && typeMatches && gasLimitMatches && noContractCreation;

  const reconciliationRequired = !identityMatches || canonicality !== "CANONICAL";

  const evidence: TransactionReceiptEvidenceV1 = transactionReceiptEvidenceV1Schema.parse({
    evidenceVersion: "1.0",
    observedAt: input.observedAt,
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    transactionIndex: receipt.transactionIndex,
    from: receipt.from,
    to: receipt.to,
    type: receipt.type,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    contractAddress: receipt.contractAddress,
    executionStatus: receiptStatus === "SUCCESS" ? "SUCCESS" : "REVERTED",
    identityStatus: identityMatches ? "MATCH" : "MISMATCH",
    finalityStatus: finality === "FINALIZED" ? "FINALIZED" : "INCLUDED",
    finalizedBlockHash: finality === "FINALIZED" && finalizedBlock ? finalizedBlock.hash : null,
    finalizedBlockNumber: finality === "FINALIZED" && finalizedBlock ? finalizedBlock.number : null,
    reconciliationStatus: reconciliationRequired ? "REQUIRED" : "CLEAR",
  });

  return Object.freeze({
    receiptStatus,
    canonicality,
    finality,
    receipt,
    canonicalBlock,
    finalizedBlock,
    evidence,
    reconciliationRequired,
  });
}
