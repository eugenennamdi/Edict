import "server-only";
import { isExecutablePlan } from "../execution/capabilities";

import { buildExecutionPlanV1, canonicalizeJson, validateAssetManifestV1 } from "@/core";
import {
  parsePublicPlanningRecord,
  parsePublicRunMutationResponse,
  type PublicPlanningRecord,
  type PublicRunProjection,
} from "@/shared/run";
import { PersistenceDataError, type ExecutionRun } from "../execution";
import { deriveExecutionPreparationProjection } from "../orchestration";

async function validatedArtifacts(run: ExecutionRun) {
  const manifestResult = validateAssetManifestV1(run.manifest);
  if (
    !manifestResult.ok ||
    canonicalizeJson(run.manifest) !== canonicalizeJson(manifestResult.value)
  ) {
    throw new Error("PUBLIC_RUN_PROJECTION_INVALID");
  }
  const manifest = manifestResult.value;
  const plan = await buildExecutionPlanV1(manifest, run.plan.executionScope === "TOKENIZE_ONLY" ? "TOKENIZE_ONLY" : "LEGACY_FULL");
  if (plan.manifestHash !== run.manifestHash || plan.planHash !== run.planHash) {
    throw new Error("PUBLIC_RUN_PROJECTION_INVALID");
  }
  return { manifest, plan };
}

function operationProjection(operation: ExecutionRun["operations"][number]) {
  return {
    id: operation.id,
    kind: operation.kind,
    stage: operation.stage,
    preparedTxId: operation.preparedTxId,
    blockchainTxHash: operation.blockchainTxHash,
    brickkenStatus: operation.brickkenStatus,
    timeout: operation.timeout,
  };
}

function activeWriteOperation(run: ExecutionRun) {
  if (run.phase === "WHITELIST") return run.operations[1];
  if (run.phase === "MINT") return run.operations[2];
  return run.operations[0];
}

function staleReprepareEligible(op: ExecutionRun["operations"][number]): boolean {
  if (op.stage !== "PREPARED_STALE" || op.blockchainTxHash !== null) return false;
  if ("walletPromptAuthorization" in op && op.walletPromptAuthorization !== null) return false;
  if (!("preparationAttempts" in op) || !Array.isArray(op.preparationAttempts)) return false;
  return op.preparationAttempts.length < 2;
}

async function projectedRun(run: ExecutionRun): Promise<PublicRunProjection> {
  const execution = run.phase === "TOKENIZATION" ? await deriveExecutionPreparationProjection(run) : null;
  return parsePublicRunMutationResponse({
    ok: true,
    run: {
      executablePlan: isExecutablePlan(run.plan),
      executeEligible: (() => {
        if (!isExecutablePlan(run.plan) || run.approval === null || run.terminalOutcome !== null) return false;
        if (!["PREPARING", "AWAITING_WALLET"].includes(run.status)) return false;
        if (run.phase !== "TOKENIZATION" && run.phase !== "WHITELIST" && run.phase !== "MINT") return false;
        const op = activeWriteOperation(run);
        if (op.blockchainTxHash !== null) return false;
        const walletPromptAuthorization = "walletPromptAuthorization" in op ? op.walletPromptAuthorization : null;
        return ["NOT_STARTED", "PREPARED"].includes(op.stage) ||
          (op.stage === "PREPARED_STALE" && staleReprepareEligible(op)) ||
          (run.schemaVersion === "4.0" && op.stage === "WALLET_PROMPT_RECORDED" &&
            walletPromptAuthorization?.providerInvocation === "PROVEN_NOT_INVOKED");
      })(),
      trackingRemaining: (() => {
        if (run.phase !== "TOKENIZATION" && run.phase !== "WHITELIST" && run.phase !== "MINT") return 0;
        return Math.max(0, 30 - run.events.filter((event) => event.type === "TRACK_EXECUTION_RESERVED").length);
      })(),
      tokenizationResult: run.schemaVersion === "4.0" && run.tokenIdentity !== null ? {
        tokenAddress: run.tokenIdentity.tokenAddress,
        escrowAddress: run.tokenIdentity.escrowAddress ?? null,
        tokenizationId: run.tokenIdentity.tokenizationId ?? null,
        transactionHash: run.tokenIdentity.tokenizationTxHash,
        verifiedAt: run.tokenIdentity.verifiedAt, verificationStatus: "VERIFIED",
      } : null,
      id: run.id,
      schemaVersion: run.schemaVersion,
      manifestHash: run.manifestHash,
      planHash: run.planHash,
      environment: run.environment,
      chainId: run.chainId,
      requiredSigner: run.requiredSigner,
      phase: run.phase,
      status: run.status,
      terminalOutcome: run.terminalOutcome,
      approved: run.approval !== null,
      execution,
      operations: [
        operationProjection(run.operations[0]),
        operationProjection(run.operations[1]),
        operationProjection(run.operations[2]),
      ],
      receiptEligible: run.receiptEligible,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      revision: run.revision,
    },
  });
}

export async function projectPublicRun(run: ExecutionRun): Promise<PublicRunProjection> {
  try {
    await validatedArtifacts(run);
    return await projectedRun(run);
  } catch {
    throw new PersistenceDataError();
  }
}

export async function projectPublicPlanningRecord(
  run: ExecutionRun,
): Promise<PublicPlanningRecord> {
  try {
    const { manifest, plan } = await validatedArtifacts(run);
    const projected = await projectedRun(run);
    return parsePublicPlanningRecord({ run: projected, manifest, plan });
  } catch {
    throw new PersistenceDataError();
  }
}
