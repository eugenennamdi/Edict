import "server-only";

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
  const plan = await buildExecutionPlanV1(manifest);
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

async function projectedRun(run: ExecutionRun): Promise<PublicRunProjection> {
  const execution = await deriveExecutionPreparationProjection(run);
  return parsePublicRunMutationResponse({
    ok: true,
    run: {
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
