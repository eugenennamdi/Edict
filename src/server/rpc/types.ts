import "server-only";

import type {
  FeeAuthorizationDecisionV1,
} from "@/shared/wallet/execution-authorization";
import type { WalletAccessListEntryV1 } from "@/shared/wallet/transaction";
import type { TransactionReceiptEvidenceV1 } from "../execution/onchain-evidence";
import type {
  NonceFreshnessEvidenceV1,
  RpcTransactionAuthorizationEvidenceV1,
} from "../execution/types";

export const SEPOLIA_DECIMAL_CHAIN_ID = "11155111" as const;
export const SEPOLIA_HEX_CHAIN_ID = "0xaa36a7" as const;

/**
 * Raw RPC transport interface.
 *
 * TRANSPORT SIZE-BOUNDARY CONTRACT:
 * - RpcTransport is REQUIRED to enforce `maxResponseSizeBytes` (defaulting to <= 1 MiB /
 *   1,048,576 bytes) before or during deserialization.
 * - Fake and in-memory test transports satisfy the test contract by operating on
 *   bounded synthetic fixtures.
 * - Pass 1 does NOT yet contain or prove a live production HTTP RPC transport.
 * - The future production transport must implement actual network byte/stream limiting.
 * - `TrustedSepoliaRpcClient` wraps an injected transport and does NOT claim or prove that
 *   an arbitrary injected transport is cryptographically or independently proven to honor
 *   this requirement.
 */
export interface RpcTransport {
  request(method: string, params?: readonly unknown[]): Promise<unknown>;
}

export type TransactionPresenceState = "NOT_FOUND" | "UNMINED" | "MINED";

export interface NormalizedRpcTransaction {
  readonly hash: string;
  readonly chainId: string;
  readonly rpcChainId: string;
  readonly from: string;
  readonly to: string | null;
  readonly input: string;
  readonly value: string;
  readonly nonce: string;
  readonly type: "0x0" | "0x1" | "0x2";
  readonly gas: string;
  readonly gasPrice: string | null;
  readonly maxFeePerGas: string | null;
  readonly maxPriorityFeePerGas: string | null;
  readonly accessList: readonly WalletAccessListEntryV1[];
  readonly blockHash: string | null;
  readonly blockNumber: string | null;
  readonly transactionIndex: string | null;
  readonly presence: "UNMINED" | "MINED";
}

export interface NormalizedRpcReceipt {
  readonly transactionHash: string;
  readonly transactionIndex: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly from: string;
  readonly to: string | null;
  readonly cumulativeGasUsed: string;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly contractAddress: string | null;
  readonly type: "0x0" | "0x1" | "0x2";
  readonly status: "0x0" | "0x1";
}

export interface NormalizedRpcBlock {
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
  readonly baseFeePerGas: string | null;
}

export type ReceiptStatus = "NOT_FOUND" | "SUCCESS" | "REVERTED";
export type CanonicalityStatus = "NOT_EVALUATED" | "CANONICAL" | "CONTRADICTION";
export type FinalityStatus = "NOT_EVALUATED" | "INCLUDED" | "FINALIZED" | "UNAVAILABLE";

export interface ReceiptFinalityEvaluation {
  readonly receiptStatus: ReceiptStatus;
  readonly canonicality: CanonicalityStatus;
  readonly finality: FinalityStatus;
  readonly receipt: NormalizedRpcReceipt | null;
  readonly canonicalBlock: NormalizedRpcBlock | null;
  readonly finalizedBlock: NormalizedRpcBlock | null;
  readonly evidence: TransactionReceiptEvidenceV1 | null;
  readonly reconciliationRequired: boolean;
}

export type SemanticComparisonOutcome =
  | "IMMUTABLE_MATCH + FEE_COMPLIANT"
  | "IMMUTABLE_MATCH + POLICY_VIOLATION_ONCHAIN"
  | "IMMUTABLE_MISMATCH";

export type FeePolicyViolationCode = NonNullable<
  Extract<FeeAuthorizationDecisionV1, { accepted: false }>["code"]
> | "INVALID_FEE_EVIDENCE";

export interface TransactionComparisonEvaluation {
  readonly presence: TransactionPresenceState;
  readonly outcome: SemanticComparisonOutcome | "TRANSACTION_NOT_FOUND";
  readonly immutableIdentityStatus: "MATCH" | "MISMATCH" | "NOT_EVALUATED";
  readonly feeAuthorizationStatus: "WITHIN_ENVELOPE" | "POLICY_VIOLATION" | "NOT_EVALUATED";
  readonly feePolicyViolationCode: FeePolicyViolationCode | null;
  readonly observedTransaction: NormalizedRpcTransaction | null;
  readonly evidence: RpcTransactionAuthorizationEvidenceV1 | null;
  readonly reconciliationRequired: boolean;
}

export type FreshnessOutcome =
  | "ELIGIBLE"
  | "STALE_NONCE"
  | "INSUFFICIENT_BALANCE"
  | "FEE_CAP_EXCEEDED_BY_BASE_FEE"
  | "RPC_UNAVAILABLE"
  | "INVALID_ATTEMPT";

export interface FreshnessEvaluation {
  readonly outcome: FreshnessOutcome;
  readonly eligible: boolean;
  readonly nonceStatus: "FRESH" | "STALE" | "UNAVAILABLE";
  readonly nonceEvidence: NonceFreshnessEvidenceV1 | null;
  readonly balanceStatus: "SUFFICIENT" | "INSUFFICIENT" | "UNAVAILABLE";
  readonly observedBalanceWei: string | null;
  readonly requiredBalanceWei: string | null;
  readonly feeFreshnessStatus: "FRESH" | "FEE_CAP_EXCEEDED_BY_BASE_FEE" | "UNAVAILABLE";
  readonly observedBaseFeeWei: string | null;
  readonly authorizedMaxFeeWei: string | null;
}

export interface TrustedSepoliaRpcClient {
  readonly chainId: typeof SEPOLIA_DECIMAL_CHAIN_ID;
  verifyChain(): Promise<void>;
  getPendingNonce(address: string): Promise<string>;
  getBalance(address: string, blockTag?: "pending" | "latest"): Promise<string>;
  getLatestBlock(): Promise<NormalizedRpcBlock>;
  getFinalizedBlock(): Promise<NormalizedRpcBlock | null>;
  getTransaction(txHash: string): Promise<NormalizedRpcTransaction | null>;
  getTransactionReceipt(txHash: string): Promise<NormalizedRpcReceipt | null>;
  getBlockByNumber(blockNumber: string): Promise<NormalizedRpcBlock | null>;
  getBlockByHash(blockHash: string): Promise<NormalizedRpcBlock | null>;
}
