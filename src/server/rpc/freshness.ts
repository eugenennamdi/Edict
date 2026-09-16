import "server-only";

import { decodeFunctionData, parseAbi } from "viem";
import type { ExecutionRun, ExecutionRunV4, IsoUtcTimestamp, OperationKind } from "../execution/types";
import { markPreparedStaleV4, type V4PreparationFoundationInput } from "../execution/v4-transitions";
import { nonceFreshnessEvidenceV1Schema } from "../execution/v4-contracts";
import {
  REVIEWED_TOKENIZE_FUNCTION_SIGNATURE,
  REVIEWED_TOKENIZE_SELECTOR,
} from "../orchestration/tokenize-receipt-binding";
import { SEPOLIA_DECIMAL_CHAIN_ID, type FreshnessEvaluation, type TrustedSepoliaRpcClient } from "./types";

const TOKENIZE_ABI = parseAbi([
  `function ${REVIEWED_TOKENIZE_FUNCTION_SIGNATURE} external`,
]);
const MAX_UINT256 = (1n << 256n) - 1n;

export const DEFAULT_PRICE_REPORT_SAFETY_BUFFER_SECONDS = 300;

export function getPriceReportSafetyBufferSeconds(): number {
  const raw = process.env.EDICT_PRICE_REPORT_SAFETY_BUFFER_SECONDS;
  if (!raw) return DEFAULT_PRICE_REPORT_SAFETY_BUFFER_SECONDS;
  const parsed = parseInt(raw, 10);
  if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 86400) {
    return parsed;
  }
  return DEFAULT_PRICE_REPORT_SAFETY_BUFFER_SECONDS;
}

/**
 * Decodes the exact prepared newTokenization calldata using the independently reviewed canonical ABI
 * and extracts only the offchainReport.deadline (uint256) timestamp in seconds.
 * Returns null if calldata is malformed, selector doesn't match, or deadline cannot be extracted.
 */
export function extractPriceReportDeadlineFromTokenizeCalldata(
  calldata: string,
): bigint | null {
  if (
    typeof calldata !== "string" ||
    !calldata.toLowerCase().startsWith(REVIEWED_TOKENIZE_SELECTOR) ||
    calldata.length < 10
  ) {
    return null;
  }
  try {
    const decoded = decodeFunctionData({
      abi: TOKENIZE_ABI,
      data: calldata as `0x${string}`,
    });
    if (!decoded || !decoded.args || decoded.args.length < 2) return null;
    const offchainReport = decoded.args[1];
    let deadline: unknown = null;
    if (Array.isArray(offchainReport) && offchainReport.length >= 5) {
      deadline = offchainReport[4];
    } else if (
      typeof offchainReport === "object" &&
      offchainReport !== null &&
      "deadline" in offchainReport
    ) {
      deadline = (offchainReport as { deadline: unknown }).deadline;
    }
    if (typeof deadline !== "bigint" || deadline <= 0n || deadline > MAX_UINT256) {
      return null;
    }
    return deadline;
  } catch {
    return null;
  }
}

export interface EvaluatePreparedFreshnessInput {
  readonly client: TrustedSepoliaRpcClient;
  readonly run: ExecutionRun;
  readonly kind: OperationKind;
  readonly policyVersion: string;
  readonly observedAt: IsoUtcTimestamp;
  readonly safetyBufferSeconds?: number;
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
 * 1. Price report deadline for TOKENIZE operations against trusted Sepolia block timestamp
 *    plus safety buffer (default 300s).
 * 2. Trusted pending nonce via Sepolia RPC against the prepared nonce.
 * 3. Native ETH balance sufficiency derived strictly from the authorization contract:
 *    requiredBalance = immutableIdentity.value + feeAuthorization.authorizedCaps.maximumNetworkFeeWei.
 *    (Does not recompute authority from prepared defaults as gas * prepared maxFeePerGas).
 * 4. EIP-1559 base fee freshness: baseFeePerGas <= feeAuthorization.authorizedCaps.maxFeePerGas.
 *    (Note: baseFeePerGas > authorizedCaps.maxFeePerGas is an Edict fee non-authorization condition,
 *     not proof that the Brickken preparation itself is invalid.)
 *
 * If RPC is unavailable or uncertain, fails closed without marking the run stale.
 */
export async function evaluatePreparedFreshness(
  input: EvaluatePreparedFreshnessInput,
): Promise<FreshnessEvaluation> {
  const operation = input.run.operations[operationIndex(input.kind)];
  if (operation.stage !== "PREPARED" && operation.stage !== "WALLET_PROMPT_RECORDED") {
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
  let preparedCalldata: string | null = null;
  let authorizedMaxFeePerGas: string | null = null;
  let authorizedMaximumNetworkFeeWei: string | null = null;

  if ("preparationAttempts" in operation && Array.isArray(operation.preparationAttempts)) {
    const active = operation.preparationAttempts.find(
      (a) => a.attemptId === operation.activePreparationAttemptId,
    );
    if (active?.immutableIdentity && active.feeAuthorization) {
      preparedNonce = active.immutableIdentity.nonce;
      preparedValue = active.immutableIdentity.value;
      preparedCalldata = active.immutableIdentity.data;
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

  let blockTimestamp: bigint | null = null;
  let blockTimestampSeconds: number | null = null;

  try {
    const [nonceResult, balanceResult, blockResult] = await Promise.all([
      input.client.getPendingNonce(requiredSigner),
      input.client.getBalance(requiredSigner, "pending"),
      input.client.getLatestBlock(),
    ]);
    observedPendingNonce = nonceResult;
    observedBalanceWei = balanceResult;
    observedBaseFeeWei = blockResult.baseFeePerGas;
    if (blockResult.timestamp !== null && blockResult.timestamp !== undefined) {
      blockTimestamp = BigInt(blockResult.timestamp);
      blockTimestampSeconds = Number(blockTimestamp);
    }
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

  if (blockTimestamp === null || blockTimestampSeconds === null || observedBaseFeeWei === null) {
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

  let priceReportStatus: "FRESH" | "EXPIRED" | "TOO_CLOSE_TO_EXPIRY" | "MALFORMED" | "NOT_APPLICABLE" = "NOT_APPLICABLE";
  let priceReportDeadlineSeconds: number | null = null;
  let remainingLifetimeSeconds: number | null = null;

  if (input.kind === "TOKENIZE") {
    if (preparedCalldata === null) {
      return Object.freeze({
        outcome: "INVALID_ATTEMPT",
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

    const deadline = extractPriceReportDeadlineFromTokenizeCalldata(preparedCalldata);
    if (deadline === null) {
      return Object.freeze({
        outcome: "MALFORMED_PRICE_REPORT_CALLDATA",
        eligible: false,
        nonceStatus: "UNAVAILABLE",
        nonceEvidence: null,
        balanceStatus: "UNAVAILABLE",
        observedBalanceWei,
        requiredBalanceWei,
        feeFreshnessStatus: "UNAVAILABLE",
        observedBaseFeeWei,
        authorizedMaxFeeWei: authorizedMaxFeePerGas,
        priceReportStatus: "MALFORMED",
        priceReportDeadlineSeconds: null,
        latestBlockTimestampSeconds: blockTimestampSeconds,
        remainingLifetimeSeconds: null,
      });
    }

    priceReportDeadlineSeconds = Number(deadline);
    remainingLifetimeSeconds = priceReportDeadlineSeconds - blockTimestampSeconds;
    const safetyBuffer = BigInt(input.safetyBufferSeconds ?? getPriceReportSafetyBufferSeconds());

    if (blockTimestamp >= deadline) {
      priceReportStatus = "EXPIRED";
      return Object.freeze({
        outcome: "PRICE_REPORT_EXPIRED",
        eligible: false,
        nonceStatus: nonceMatches ? "FRESH" : "STALE",
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
        priceReportStatus,
        priceReportDeadlineSeconds,
        latestBlockTimestampSeconds: blockTimestampSeconds,
        remainingLifetimeSeconds,
      });
    }

    if (blockTimestamp + safetyBuffer >= deadline) {
      priceReportStatus = "TOO_CLOSE_TO_EXPIRY";
      return Object.freeze({
        outcome: "PRICE_REPORT_TOO_CLOSE_TO_EXPIRY",
        eligible: false,
        nonceStatus: nonceMatches ? "FRESH" : "STALE",
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
        priceReportStatus,
        priceReportDeadlineSeconds,
        latestBlockTimestampSeconds: blockTimestampSeconds,
        remainingLifetimeSeconds,
      });
    }

    priceReportStatus = "FRESH";
  }

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
      priceReportStatus,
      priceReportDeadlineSeconds,
      latestBlockTimestampSeconds: blockTimestampSeconds,
      remainingLifetimeSeconds,
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
      priceReportStatus,
      priceReportDeadlineSeconds,
      latestBlockTimestampSeconds: blockTimestampSeconds,
      remainingLifetimeSeconds,
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
      priceReportStatus,
      priceReportDeadlineSeconds,
      latestBlockTimestampSeconds: blockTimestampSeconds,
      remainingLifetimeSeconds,
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
    priceReportStatus,
    priceReportDeadlineSeconds,
    latestBlockTimestampSeconds: blockTimestampSeconds,
    remainingLifetimeSeconds,
  });
}

/**
 * Convenience orchestrator helper to transition a PREPARED run to PREPARED_STALE
 * if the freshness evaluation produced a STALE_NONCE or PRICE_REPORT_EXPIRED outcome.
 */
export async function applyPreparedStaleTransition(input: {
  readonly run: ExecutionRun;
  readonly kind: OperationKind;
  readonly foundation: V4PreparationFoundationInput;
  readonly freshness: FreshnessEvaluation;
  readonly id: string;
  readonly at: IsoUtcTimestamp;
}): Promise<ExecutionRunV4> {
  const outcome = input.freshness.outcome;
  if (
    (outcome !== "STALE_NONCE" &&
      outcome !== "PRICE_REPORT_EXPIRED" &&
      outcome !== "PRICE_REPORT_TOO_CLOSE_TO_EXPIRY") ||
    input.freshness.nonceEvidence === null
  ) {
    throw new Error("Cannot apply PREPARED_STALE transition without valid freshness evidence.");
  }
  const staleReason =
    outcome === "STALE_NONCE" ? "NONCE_MISMATCH" : "PRICE_REPORT_EXPIRED";
  return markPreparedStaleV4({
    run: input.run,
    kind: input.kind,
    foundation: input.foundation,
    nonceEvidence: input.freshness.nonceEvidence,
    staleReason,
    id: input.id,
    at: input.at,
  });
}
