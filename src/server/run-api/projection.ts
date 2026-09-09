import "server-only";

import { buildExecutionPlanV1, canonicalizeJson, validateAssetManifestV1 } from "@/core";
import { parsePublicPlanningRecord, type PublicPlanningRecord } from "@/shared/run";
import { PersistenceDataError, type ExecutionRun } from "../execution";

export async function projectPublicPlanningRecord(
  run: ExecutionRun,
): Promise<PublicPlanningRecord> {
  try {
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

    return parsePublicPlanningRecord({
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
        operations: [
          {
            id: run.operations[0].id,
            kind: run.operations[0].kind,
            stage: run.operations[0].stage,
            preparedTxId: run.operations[0].preparedTxId,
            blockchainTxHash: run.operations[0].blockchainTxHash,
            brickkenStatus: run.operations[0].brickkenStatus,
            timeout: run.operations[0].timeout,
          },
          {
            id: run.operations[1].id,
            kind: run.operations[1].kind,
            stage: run.operations[1].stage,
            preparedTxId: run.operations[1].preparedTxId,
            blockchainTxHash: run.operations[1].blockchainTxHash,
            brickkenStatus: run.operations[1].brickkenStatus,
            timeout: run.operations[1].timeout,
          },
          {
            id: run.operations[2].id,
            kind: run.operations[2].kind,
            stage: run.operations[2].stage,
            preparedTxId: run.operations[2].preparedTxId,
            blockchainTxHash: run.operations[2].blockchainTxHash,
            brickkenStatus: run.operations[2].brickkenStatus,
            timeout: run.operations[2].timeout,
          },
        ],
        receiptEligible: run.receiptEligible,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        revision: run.revision,
      },
      manifest,
      plan,
    });
  } catch {
    throw new PersistenceDataError();
  }
}
