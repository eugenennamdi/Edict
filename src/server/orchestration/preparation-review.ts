import "server-only";

import {
  createPreparedTransactionReviewV1,
  projectPreparedTransactionV1,
  type PreparedTransactionReviewV1,
} from "@/shared/wallet";
import type { PublicExecutionPreparation } from "@/shared/run";
import type { ExecutionRun, WriteOperation } from "../execution/types";
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
    run.terminalOutcome !== null ||
    operation.kind !== "TOKENIZE"
  ) return null;
  return operation;
}

export function nextPreparationOperation(run: ExecutionRun): WriteOperation {
  const operation = exactApprovedTokenization(run);
  if (
    operation === null ||
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
  let transactionReview: PreparedTransactionReviewV1 | null = null;
  if (run.status === "PREPARING" && operation.stage === "NOT_STARTED") {
    preparationStatus = "READY_FOR_PREPARATION";
  } else if (run.status === "PREPARING" && operation.stage === "PREPARE_INTENT") {
    preparationStatus = "PREPARATION_PENDING";
  } else if (run.status === "AWAITING_WALLET" && operation.stage === "PREPARED") {
    preparationStatus = "PREPARED_FOR_REVIEW";
    transactionReview = await preparedReview(run, operation);
  } else if (
    run.status === "RECONCILIATION_REQUIRED" &&
    operation.stage === "PREPARE_UNKNOWN"
  ) {
    preparationStatus = "PREPARATION_UNCONFIRMED";
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
    transactionReview,
  });
}
