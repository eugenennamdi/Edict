import "server-only";
import { isExecutablePlan } from "../execution/capabilities";

import {
  createPreparedTransactionReviewV1,
  projectPreparedTransactionV1,
  type PreparedTransactionReviewV1,
} from "@/shared/wallet";
import type { PublicExecutionPreparation } from "@/shared/run";
import type { ExecutionRun, WriteOperation } from "../execution/types";
import type { PreparationFailureCode } from "../execution/types";
import { OrchestrationError } from "./errors";

function exactApprovedTokenization(run: ExecutionRun): WriteOperation | null {
  const operation = run.operations[0];
  if (
    run.approval === null ||
    run.approval.planHash !== run.planHash ||
    run.approval.approvedByWallet !== run.requiredSigner.walletAddress ||
    run.environment !== "sandbox" ||
    run.chainId !== "11155111" ||
    run.phase !== "TOKENIZATION" ||
    operation.kind !== "TOKENIZE"
  ) return null;
  return operation;
}

export function nextPreparationOperation(run: ExecutionRun): WriteOperation {
  const operation = exactApprovedTokenization(run);
  if (
    !isExecutablePlan(run.plan) ||
    operation === null ||
    run.terminalOutcome !== null ||
    run.status !== "PREPARING" ||
    operation.stage !== "NOT_STARTED" ||
    operation.preparedTxId !== null ||
    operation.unsignedTransaction !== null ||
    operation.blockchainTxHash !== null
  ) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  return operation;
}

async function preparedReview(
  run: ExecutionRun,
  operation: WriteOperation,
): Promise<PreparedTransactionReviewV1> {
  if (
    run.approval === null ||
    operation.preparedTxId === null ||
    operation.unsignedTransaction === null
  ) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  let projected: ReturnType<typeof projectPreparedTransactionV1>;
  try {
    projected = projectPreparedTransactionV1(operation.unsignedTransaction);
  } catch {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  if (
    projected.chainId !== "0xaa36a7" ||
    projected.walletRequest.from !== run.requiredSigner.walletAddress ||
    projected.walletRequest.to === undefined ||
    projected.walletRequest.data === undefined
  ) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  return createPreparedTransactionReviewV1({
    reviewVersion: "1.0",
    runId: run.id,
    runRevision: run.revision,
    manifestHash: run.manifestHash as `sha256:${string}`,
    planHash: run.planHash as `sha256:${string}`,
    approvalRevision: run.approval.approvalRevision,
    environment: run.environment,
    chainId: run.chainId,
    operation: Object.freeze({ id: operation.id, kind: "TOKENIZE", sequence: 1 }),
    requiredSigner: run.requiredSigner.walletAddress,
    brickken: Object.freeze({
      method: "newTokenization",
      executionMode: "client-broadcast",
    }),
    preparedTransactionId: operation.preparedTxId,
    walletRequestVersion: "1.0",
    walletRequest: projected.walletRequest,
    chainRequirement: Object.freeze({
      mode: "PROVIDER_PRECONDITION",
      decimalChainId: "11155111",
      rpcChainId: "0xaa36a7",
    }),
    calldataSemantics: "OPAQUE_SERVER_PREPARED",
    walletConfirmation: "NOT_REQUESTED",
  });
}

export async function deriveExecutionPreparationProjection(
  run: ExecutionRun,
): Promise<PublicExecutionPreparation | null> {
  const operation = exactApprovedTokenization(run);
  if (operation === null) return null;

  let preparationStatus: PublicExecutionPreparation["preparationStatus"];
  let preparationFailureCode: PreparationFailureCode | null = null;
  let transactionReview: PreparedTransactionReviewV1 | null = null;
  let staleReason: "NONCE_MISMATCH" | "PRICE_REPORT_EXPIRED" | null = null;
  let reprepareEligible: boolean | null = null;

  if (run.status === "PREPARING" && operation.stage === "NOT_STARTED") {
    preparationStatus = "READY_FOR_PREPARATION";
  } else if (
    run.status === "PREPARING" &&
    (operation.stage === "PREPARE_INTENT" || operation.stage === "REPREPARE_INTENT")
  ) {
    preparationStatus = "PREPARATION_PENDING";
  } else if (run.status === "AWAITING_WALLET" && ["PREPARED", "WALLET_PROMPT_RECORDED"].includes(operation.stage)) {
    preparationStatus = "PREPARED_FOR_REVIEW";
    transactionReview = await preparedReview(run, operation);
  } else if (run.status === "AWAITING_WALLET" && operation.stage === "PREPARED_STALE") {
    preparationStatus = "PREPARED_STALE";
    if ("preparationAttempts" in operation && Array.isArray((operation as { preparationAttempts?: unknown[] }).preparationAttempts)) {
      const activeId = (operation as { activePreparationAttemptId?: string }).activePreparationAttemptId;
      const attempts = (operation as { preparationAttempts: Array<{ attemptId: string; staleReason?: "NONCE_MISMATCH" | "PRICE_REPORT_EXPIRED" | null }> }).preparationAttempts;
      const active = attempts.find((a) => a.attemptId === activeId);
      if (active?.staleReason) {
        staleReason = active.staleReason;
      }
    }
    const hasAuth = "walletPromptAuthorization" in operation &&
      (operation as { walletPromptAuthorization?: unknown }).walletPromptAuthorization !== null;
    const hasHash = operation.blockchainTxHash !== null;
    reprepareEligible = !hasAuth && !hasHash && "preparationAttempts" in operation &&
      Array.isArray(operation.preparationAttempts) && operation.preparationAttempts.length < 2;
  } else if (
    run.status === "RECONCILIATION_REQUIRED" &&
    operation.stage === "PREPARE_UNKNOWN"
  ) {
    preparationStatus = "PREPARATION_UNCONFIRMED";
    preparationFailureCode = safePreparationFailureCode(operation.brickkenError) ??
      "PREPARATION_UNCONFIRMED";
  } else if (
    run.status === "FAILED" &&
    run.terminalOutcome === "FAILED" &&
    (operation.stage === "REJECTED" || operation.stage === "PREPARE_UNKNOWN") &&
    operation.preparedTxId === null &&
    operation.unsignedTransaction === null
  ) {
    // PREPARE_UNKNOWN supports immutable V1–V3 records written before
    // definite preparation refusals were represented by REJECTED.
    preparationStatus = "PREPARATION_FAILED";
    preparationFailureCode = safePreparationFailureCode(operation.brickkenError) ??
      "PREPARATION_REFUSED";
  } else {
    return null;
  }

  return Object.freeze({
    projectionVersion: "1.0",
    nextOperation: Object.freeze({
      id: operation.id,
      kind: "TOKENIZE",
      sequence: 1,
      name: "Create tokenization",
    }),
    preparationStatus,
    preparationFailureCode,
    staleReason,
    reprepareEligible,
    transactionReview,
  });
}

const PREPARATION_FAILURE_CODES = new Set<PreparationFailureCode>([
  "AUTHENTICATION_REJECTED",
  "ENTITLEMENT_REJECTED",
  "CREDITS_EXHAUSTED",
  "INVALID_REQUEST",
  "SIGNER_NOT_APPROVED",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_SERVER_ERROR",
  "PREPARATION_REFUSED",
  "PREPARATION_UNCONFIRMED",
]);

function safePreparationFailureCode(value: string | null): PreparationFailureCode | null {
  return value !== null && PREPARATION_FAILURE_CODES.has(value as PreparationFailureCode)
    ? value as PreparationFailureCode
    : null;
}
