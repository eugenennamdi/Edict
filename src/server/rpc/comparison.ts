import "server-only";

import {
  evaluateFeeAuthorizationV1,
  type FeeAuthorizationV1,
  type ImmutableExecutionIdentityV1,
} from "@/shared/wallet/execution-authorization";
import { rpcTransactionAuthorizationEvidenceV1Schema } from "../execution/v4-contracts";
import type {
  FeePolicyViolationCode,
  NormalizedRpcTransaction,
  TransactionComparisonEvaluation,
  TrustedSepoliaRpcClient,
} from "./types";

export interface CompareOnchainTransactionInput {
  readonly client: TrustedSepoliaRpcClient;
  readonly txHash: string;
  readonly expectedImmutableIdentity: ImmutableExecutionIdentityV1;
  readonly expectedFeeAuthorization: FeeAuthorizationV1;
  readonly observedAt: string;
}

function sameQuantity(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseQuantityOrNull(val: string | null | undefined): string | null {
  if (typeof val === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(val)) {
    return val;
  }
  return null;
}

/**
 * Normalizes and compares an on-chain transaction observed via trusted RPC
 * against expected immutable identity and authorized fee envelope.
 *
 * Brickken's immutable client-broadcast identity is EXACTLY six fields:
 * - chainId
 * - from
 * - to
 * - data (calldata / input)
 * - value
 * - nonce
 *
 * `gas` / `gasLimit` is NOT an immutable identity field.
 * `maxFeePerGas` is NOT an immutable identity field.
 * `maxPriorityFeePerGas` is NOT an immutable identity field.
 * Those belong exclusively to Edict FeeAuthorizationV1.
 *
 * A gasLimit difference by itself NEVER becomes IMMUTABLE_MISMATCH.
 *
 * Distinct presence states:
 * - NOT_FOUND: tx not yet observed on chain
 * - UNMINED: tx observed with null block identifiers
 * - MINED: tx observed with canonical block identifiers
 *
 * Produces exactly three semantic comparison outcomes:
 * 1. IMMUTABLE_MATCH + FEE_COMPLIANT:
 *    All six immutable fields match and gas/fee fields satisfy FeeAuthorizationV1.
 * 2. IMMUTABLE_MATCH + POLICY_VIOLATION_ONCHAIN:
 *    All six immutable fields match but gas/fee fields violate FeeAuthorizationV1.
 * 3. IMMUTABLE_MISMATCH:
 *    Any of the six immutable fields differ.
 */
export async function compareOnchainTransaction(
  input: CompareOnchainTransactionInput,
): Promise<TransactionComparisonEvaluation> {
  const transaction = await input.client.getTransaction(input.txHash);
  if (transaction === null) {
    return Object.freeze({
      presence: "NOT_FOUND",
      outcome: "TRANSACTION_NOT_FOUND",
      immutableIdentityStatus: "NOT_EVALUATED",
      feeAuthorizationStatus: "NOT_EVALUATED",
      feePolicyViolationCode: null,
      observedTransaction: null,
      evidence: null,
      reconciliationRequired: false,
    });
  }

  let baseFeePerGas: string | null = null;
  if (transaction.type === "0x0") {
    try {
      if (transaction.blockHash !== null) {
        const block = await input.client.getBlockByHash(transaction.blockHash);
        if (block?.baseFeePerGas) baseFeePerGas = block.baseFeePerGas;
      } else {
        const block = await input.client.getLatestBlock();
        if (block?.baseFeePerGas) baseFeePerGas = block.baseFeePerGas;
      }
    } catch {
      // Non-fatal if transport lacks block handler
    }
  }

  return compareNormalizedTransaction({
    transaction,
    expectedImmutableIdentity: input.expectedImmutableIdentity,
    expectedFeeAuthorization: input.expectedFeeAuthorization,
    observedAt: input.observedAt,
    baseFeePerGas,
  });
}

export function compareNormalizedTransaction(input: {
  readonly transaction: NormalizedRpcTransaction;
  readonly expectedImmutableIdentity: ImmutableExecutionIdentityV1;
  readonly expectedFeeAuthorization: FeeAuthorizationV1;
  readonly observedAt: string;
  readonly baseFeePerGas?: string | null;
}): TransactionComparisonEvaluation {
  const tx = input.transaction;
  const expected = input.expectedImmutableIdentity;

  const chainIdMatches = tx.chainId === expected.chainId;
  const fromMatches = sameAddress(tx.from, expected.from);
  const toMatches = tx.to !== null && sameAddress(tx.to, expected.to);
  const dataMatches = tx.input.toLowerCase() === expected.data.toLowerCase();
  const valueMatches = sameQuantity(tx.value, expected.value);
  const nonceMatches = sameQuantity(tx.nonce, expected.nonce);

  const immutableIdentityMatches =
    chainIdMatches && fromMatches && toMatches && dataMatches && valueMatches && nonceMatches;

  const observedImmutableIdentity = Object.freeze({
    identityVersion: "1.0" as const,
    chainId: tx.chainId,
    from: tx.from,
    to: tx.to ?? "0x0000000000000000000000000000000000000000",
    data: tx.input,
    value: tx.value,
    nonce: tx.nonce,
  });

  const observedTxType = tx.type;
  let observedPriorityFee: string | null = null;
  if (tx.type === "0x2" && tx.maxPriorityFeePerGas) {
    observedPriorityFee = parseQuantityOrNull(tx.maxPriorityFeePerGas);
  } else if (tx.type === "0x0" && tx.gasPrice) {
    const rawGasPrice = parseQuantityOrNull(tx.gasPrice);
    if (rawGasPrice) {
      const gasPrice = BigInt(rawGasPrice);
      const rawBaseFee = parseQuantityOrNull(input.baseFeePerGas);
      const baseFee = rawBaseFee ? BigInt(rawBaseFee) : null;
      if (baseFee !== null) {
        const effPriority = gasPrice > baseFee ? gasPrice - baseFee : 0n;
        observedPriorityFee = `0x${effPriority.toString(16)}`;
      }
    }
  }
  const observedGasLimit = parseQuantityOrNull(tx.gas);
  const observedMaxFee = parseQuantityOrNull(tx.type === "0x2" ? tx.maxFeePerGas : tx.gasPrice);

  if (!immutableIdentityMatches) {
    const evidence = rpcTransactionAuthorizationEvidenceV1Schema.parse({
      evidenceVersion: "1.0",
      observedAt: input.observedAt,
      transactionHash: tx.hash,
      immutableIdentity: observedImmutableIdentity,
      immutableIdentityStatus: "MISMATCH",
      feeAuthorizationStatus: "NOT_EVALUATED",
      feePolicyViolationCode: null,
      observedMaximumNetworkFeeWei: null,
      observedPriorityFeePerGas: observedPriorityFee,
      observedGasLimit,
      observedMaxFeePerGas: observedMaxFee,
      observedTransactionType: observedTxType,
    });

    return Object.freeze({
      presence: tx.presence,
      outcome: "IMMUTABLE_MISMATCH",
      immutableIdentityStatus: "MISMATCH",
      feeAuthorizationStatus: "NOT_EVALUATED",
      feePolicyViolationCode: null,
      observedTransaction: tx,
      evidence,
      reconciliationRequired: true,
    });
  }

  // Immutable identity matched -> evaluate fees
  const actualFeeFields = {
    transactionType: tx.type,
    gasLimit: tx.gas,
    maxFeePerGas: tx.maxFeePerGas ?? null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
    gasPrice: tx.gasPrice,
    accessList: tx.accessList,
    baseFeePerGas: input.baseFeePerGas ?? null,
  };

  let feeDecision:
    | ReturnType<typeof evaluateFeeAuthorizationV1>
    | Readonly<{ accepted: false; code: "INVALID_FEE_EVIDENCE" }>;
  try {
    feeDecision = evaluateFeeAuthorizationV1(input.expectedFeeAuthorization, actualFeeFields);
  } catch {
    feeDecision = Object.freeze({ accepted: false, code: "INVALID_FEE_EVIDENCE" as const });
  }

  if (!feeDecision.accepted) {
    const violationCode = (feeDecision.code ?? "INVALID_FEE_EVIDENCE") as FeePolicyViolationCode;
    const evidence = rpcTransactionAuthorizationEvidenceV1Schema.parse({
      evidenceVersion: "1.0",
      observedAt: input.observedAt,
      transactionHash: tx.hash,
      immutableIdentity: observedImmutableIdentity,
      immutableIdentityStatus: "MATCH",
      feeAuthorizationStatus: "POLICY_VIOLATION",
      feePolicyViolationCode: violationCode,
      observedMaximumNetworkFeeWei: null,
      observedPriorityFeePerGas: observedPriorityFee,
      observedGasLimit,
      observedMaxFeePerGas: observedMaxFee,
      observedTransactionType: observedTxType,
    });

    return Object.freeze({
      presence: tx.presence,
      outcome: "IMMUTABLE_MATCH + POLICY_VIOLATION_ONCHAIN",
      immutableIdentityStatus: "MATCH",
      feeAuthorizationStatus: "POLICY_VIOLATION",
      feePolicyViolationCode: violationCode,
      observedTransaction: tx,
      evidence,
      reconciliationRequired: true,
    });
  }

  const evidence = rpcTransactionAuthorizationEvidenceV1Schema.parse({
    evidenceVersion: "1.0",
    observedAt: input.observedAt,
    transactionHash: tx.hash,
    immutableIdentity: observedImmutableIdentity,
    immutableIdentityStatus: "MATCH",
    feeAuthorizationStatus: "WITHIN_ENVELOPE",
    feePolicyViolationCode: null,
    observedMaximumNetworkFeeWei: feeDecision.maximumNetworkFeeWei,
    observedPriorityFeePerGas: observedPriorityFee,
    observedGasLimit,
    observedMaxFeePerGas: observedMaxFee,
    observedTransactionType: observedTxType,
  });

  return Object.freeze({
    presence: tx.presence,
    outcome: "IMMUTABLE_MATCH + FEE_COMPLIANT",
    immutableIdentityStatus: "MATCH",
    feeAuthorizationStatus: "WITHIN_ENVELOPE",
    feePolicyViolationCode: null,
    observedTransaction: tx,
    evidence,
    reconciliationRequired: false,
  });
}
