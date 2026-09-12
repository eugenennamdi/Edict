import "server-only";

import type { ExecutionRun, ExecutionRunV4, IsoUtcTimestamp, OperationKind } from "../execution/types";
import { markPreparedStaleV4, type V4PreparationFoundationInput } from "../execution/v4-transitions";
import { nonceFreshnessEvidenceV1Schema } from "../execution/v4-contracts";
import { SEPOLIA_DECIMAL_CHAIN_ID, type FreshnessEvaluation, type TrustedSepoliaRpcClient } from "./types";

export interface EvaluatePreparedFreshnessInput {
  readonly client: TrustedSepoliaRpcClient;
  readonly run: ExecutionRun;
  readonly kind: OperationKind;
  readonly policyVersion: string;
  readonly observedAt: IsoUtcTimestamp;
}

function operationIndex(kind: OperationKind): 0 | 1 | 2 {
  if (kind === "TOKENIZE") return 0;
  if (kind === "WHITELIST") return 1;
  return 2;
}

/**
 * Pure server orchestration for evaluating the freshness of an existing PREPARED run.
 *
 * Evaluates:
 * 1. Trusted pending nonce via Sepolia RPC against the prepared nonce.
 * 2. Native ETH balance sufficiency derived strictly from the authorization contract:
 *    requiredBalance = immutableIdentity.value + feeAuthorization.authorizedCaps.maximumNetworkFeeWei.
 *    (Does not recompute authority from prepared defaults as gas * prepared maxFeePerGas).
 * 3. EIP-1559 base fee freshness: baseFeePerGas <= feeAuthorization.authorizedCaps.maxFeePerGas.
 *    (Note: baseFeePerGas > authorizedCaps.maxFeePerGas is an Edict fee non-authorization condition,
 *     not proof that the Brickken preparation itself is invalid.)
 *
 * If RPC is unavailable or uncertain, fails closed without marking the run stale.
 */
export async function evaluatePreparedFreshness(
  input: EvaluatePreparedFreshnessInput,
): Promise<FreshnessEvaluation> {
  const operation = input.run.operations[operationIndex(input.kind)];
  if (operation.stage !== "PREPARED") {
    return Object.freeze({
      outcome: "INVALID_ATTEMPT",
      eligible: false,
      nonceStatus: "UNAVAILABLE",
      nonceEvidence: null,
      balanceStatus: "UNAVAILABLE",
      observedBalanceWei: null,
      requiredBalanceWei: null,
      feeFreshnessStatus: "UNAVAILABLE",
      observedBaseFeeWei: null,
      authorizedMaxFeeWei: null,
    });
  }

  // Active attempt provides the verified immutable identity and authorized fee envelope
  let preparedNonce: string | null = null;
  let preparedValue: string | null = null;
  let authorizedMaxFeePerGas: string | null = null;
  let authorizedMaximumNetworkFeeWei: string | null = null;

  if ("preparationAttempts" in operation && Array.isArray(operation.preparationAttempts)) {
    const active = operation.preparationAttempts.find(
      (a) => a.attemptId === operation.activePreparationAttemptId,
    );
    if (active?.immutableIdentity && active.feeAuthorization) {
      preparedNonce = active.immutableIdentity.nonce;
      preparedValue = active.immutableIdentity.value;
      // Derived strictly from the authorization contract caps, NOT recomputed from prepared defaults
      authorizedMaxFeePerGas = active.feeAuthorization.authorizedCaps.maxFeePerGas;
      authorizedMaximumNetworkFeeWei = active.feeAuthorization.authorizedCaps.maximumNetworkFeeWei;
    }
  }

  if (
    preparedNonce === null ||
    preparedValue === null ||
    authorizedMaxFeePerGas === null ||
    authorizedMaximumNetworkFeeWei === null
  ) {
    return Object.freeze({
      outcome: "INVALID_ATTEMPT",
      eligible: false,
      nonceStatus: "UNAVAILABLE",
      nonceEvidence: null,
      balanceStatus: "UNAVAILABLE",
      observedBalanceWei: null,
      requiredBalanceWei: null,
      feeFreshnessStatus: "UNAVAILABLE",
      observedBaseFeeWei: null,
      authorizedMaxFeeWei: null,
    });
  }

  const requiredSigner = input.run.requiredSigner.walletAddress;
  // requiredBalance = immutableIdentity.value + feeAuthorization.authorizedCaps.maximumNetworkFeeWei
  const requiredBalance = BigInt(preparedValue) + BigInt(authorizedMaximumNetworkFeeWei);
  const requiredBalanceWei = `0x${requiredBalance.toString(16)}`;

  let observedPendingNonce: string;
  let observedBalanceWei: string;
  let observedBaseFeeWei: string | null = null;

  try {
    const [nonceResult, balanceResult, blockResult] = await Promise.all([
      input.client.getPendingNonce(requiredSigner),
      input.client.getBalance(requiredSigner, "pending"),
      input.client.getLatestBlock(),
    ]);
    observedPendingNonce = nonceResult;
    observedBalanceWei = balanceResult;
    observedBaseFeeWei = blockResult.baseFeePerGas;
  } catch {
    // If RPC is unavailable or uncertain, do NOT mark stale; return non-authorized unavailable result
    return Object.freeze({
      outcome: "RPC_UNAVAILABLE",
      eligible: false,
      nonceStatus: "UNAVAILABLE",
      nonceEvidence: null,
      balanceStatus: "UNAVAILABLE",
      observedBalanceWei: null,
      requiredBalanceWei,
      feeFreshnessStatus: "UNAVAILABLE",
      observedBaseFeeWei: null,
      authorizedMaxFeeWei: authorizedMaxFeePerGas,
    });
  }

  const nonceMatches = BigInt(observedPendingNonce) === BigInt(preparedNonce);
  const nonceEvidence = nonceFreshnessEvidenceV1Schema.parse({
    evidenceVersion: "1.0",
    policyVersion: input.policyVersion,
    authority: "TRUSTED_SERVER_RPC",
    rpcMethod: "eth_getTransactionCount",
    blockTag: "pending",
    chainId: SEPOLIA_DECIMAL_CHAIN_ID,
    requiredSigner,
    preparedNonce,
    observedPendingNonce,
    status: nonceMatches ? "FRESH" : "STALE",
    observedAt: input.observedAt,
  });

  if (!nonceMatches) {
    return Object.freeze({
      outcome: "STALE_NONCE",
      eligible: false,
      nonceStatus: "STALE",
      nonceEvidence,
      balanceStatus: BigInt(observedBalanceWei) >= requiredBalance ? "SUFFICIENT" : "INSUFFICIENT",
      observedBalanceWei,
      requiredBalanceWei,
      feeFreshnessStatus:
        observedBaseFeeWei !== null && BigInt(observedBaseFeeWei) > BigInt(authorizedMaxFeePerGas)
          ? "FEE_CAP_EXCEEDED_BY_BASE_FEE"
          : "FRESH",
      observedBaseFeeWei,
      authorizedMaxFeeWei: authorizedMaxFeePerGas,
    });
  }

  const balanceSufficient = BigInt(observedBalanceWei) >= requiredBalance;
  if (!balanceSufficient) {
    return Object.freeze({
      outcome: "INSUFFICIENT_BALANCE",
      eligible: false,
      nonceStatus: "FRESH",
      nonceEvidence,
      balanceStatus: "INSUFFICIENT",
      observedBalanceWei,
      requiredBalanceWei,
      feeFreshnessStatus:
        observedBaseFeeWei !== null && BigInt(observedBaseFeeWei) > BigInt(authorizedMaxFeePerGas)
          ? "FEE_CAP_EXCEEDED_BY_BASE_FEE"
          : "FRESH",
      observedBaseFeeWei,
      authorizedMaxFeeWei: authorizedMaxFeePerGas,
    });
  }

  const feeExceeded =
    observedBaseFeeWei !== null && BigInt(observedBaseFeeWei) > BigInt(authorizedMaxFeePerGas);
  if (feeExceeded) {
    return Object.freeze({
      outcome: "FEE_CAP_EXCEEDED_BY_BASE_FEE",
      eligible: false,
      nonceStatus: "FRESH",
      nonceEvidence,
      balanceStatus: "SUFFICIENT",
      observedBalanceWei,
      requiredBalanceWei,
      feeFreshnessStatus: "FEE_CAP_EXCEEDED_BY_BASE_FEE",
      observedBaseFeeWei,
      authorizedMaxFeeWei: authorizedMaxFeePerGas,
    });
  }

  return Object.freeze({
    outcome: "ELIGIBLE",
    eligible: true,
    nonceStatus: "FRESH",
    nonceEvidence,
    balanceStatus: "SUFFICIENT",
    observedBalanceWei,
    requiredBalanceWei,
    feeFreshnessStatus: "FRESH",
    observedBaseFeeWei,
    authorizedMaxFeeWei: authorizedMaxFeePerGas,
  });
}

/**
 * Convenience orchestrator helper to transition a PREPARED run to PREPARED_STALE
 * if the freshness evaluation produced a STALE_NONCE outcome.
 */
export async function applyPreparedStaleTransition(input: {
  readonly run: ExecutionRun;
  readonly kind: OperationKind;
  readonly foundation: V4PreparationFoundationInput;
  readonly freshness: FreshnessEvaluation;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): Promise<ExecutionRunV4> {
  if (
    input.freshness.outcome !== "STALE_NONCE" ||
    input.freshness.nonceEvidence === null ||
    input.freshness.nonceEvidence.status !== "STALE"
  ) {
    throw new Error("Cannot apply PREPARED_STALE transition without valid STALE nonce evidence.");
  }
  return markPreparedStaleV4({
    run: input.run,
    kind: input.kind,
    foundation: input.foundation,
    nonceEvidence: input.freshness.nonceEvidence,
    id: input.id,
    at: input.at,
  });
}
