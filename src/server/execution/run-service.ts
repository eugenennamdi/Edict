import {
  buildExecutionPlanV1,
  hashAssetManifestV1,
  type NormalizedAssetManifestV1,
} from "@/core";
import { InvalidRunSnapshotError } from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import { jsonClone } from "./infrastructure";
import type { ExecutionRunRepository } from "./repository";
import { applyRunEvent, persistedConfirmationPair } from "./transitions";
import type {
  ExecutionManifestSnapshot,
  ExecutionPlanSnapshot,
  ExecutionRunEvent,
  ExecutionRunV1,
  IsoUtcTimestamp,
  OperationKind,
  WriteOperation,
} from "./types";

export interface ExecutionRunServiceDeps {
  readonly repository: ExecutionRunRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function snapshotManifest(manifest: NormalizedAssetManifestV1): ExecutionManifestSnapshot {
  return jsonClone({
    schemaVersion: manifest.schemaVersion,
    environment: manifest.environment,
    chainId: manifest.chainId,
    tokenizer: {
      email: manifest.tokenizer.email,
      walletAddress: manifest.tokenizer.walletAddress,
    },
    asset: {
      name: manifest.asset.name,
      symbol: manifest.asset.symbol,
      tokenType: manifest.asset.tokenType,
      supplyCap: manifest.asset.supplyCap,
      documentationUrl: manifest.asset.documentationUrl,
    },
    investor: {
      email: manifest.investor.email,
      walletAddress: manifest.investor.walletAddress,
      mintAmount: manifest.investor.mintAmount,
    },
  });
}

function snapshotPlan(plan: {
  planVersion: "1.0";
  manifestHash: string;
  environment: "sandbox";
  chainId: "11155111";
  requiredSigner: { role: "tokenizer"; walletAddress: string };
  planHash: string;
}): ExecutionPlanSnapshot {
  return jsonClone({
    planVersion: plan.planVersion,
    manifestHash: plan.manifestHash,
    environment: plan.environment,
    chainId: plan.chainId,
    requiredSigner: {
      role: plan.requiredSigner.role,
      walletAddress: plan.requiredSigner.walletAddress,
    },
    planHash: plan.planHash,
  });
}

function emptyOperation(id: string, kind: OperationKind): WriteOperation {
  return {
    id,
    kind,
    stage: "NOT_STARTED",
    preparedTxId: null,
    unsignedTransaction: null,
    blockchainTxHash: null,
    brickkenStatus: null,
    brickkenError: null,
    timeout: false,
    prepareIntentAt: null,
    preparedAt: null,
    walletPromptAt: null,
    broadcastAt: null,
    confirmedAt: null,
    verifiedAt: null,
  };
}

export class ExecutionRunService {
  readonly #repository: ExecutionRunRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(deps: ExecutionRunServiceDeps) {
    this.#repository = deps.repository;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
  }

  async createRun(manifest: NormalizedAssetManifestV1): Promise<ExecutionRunV1> {
    const { hash: manifestHash } = await hashAssetManifestV1(manifest);
    const plan = await buildExecutionPlanV1(manifest);
    const createdAt = this.#clock.nowIso();
    const run: ExecutionRunV1 = {
      schemaVersion: "1.0",
      id: this.#ids.runId(),
      manifest: snapshotManifest(manifest),
      manifestHash,
      plan: snapshotPlan(plan),
      planHash: plan.planHash,
      environment: "sandbox",
      chainId: "11155111",
      requiredSigner: {
        role: "tokenizer",
        walletAddress: plan.requiredSigner.walletAddress,
      },
      phase: "PLAN",
      status: "AWAITING_APPROVAL",
      terminalOutcome: null,
      approval: null,
      operations: [
        emptyOperation(this.#ids.operationId(), "TOKENIZE"),
        emptyOperation(this.#ids.operationId(), "WHITELIST"),
        emptyOperation(this.#ids.operationId(), "MINT"),
      ],
      observations: [],
      events: [],
      receiptEligible: false,
      createdAt,
      updatedAt: createdAt,
      revision: 1,
    };
    return this.#repository.create(run);
  }

  async getRun(id: string): Promise<ExecutionRunV1> {
    return this.#repository.getById(id);
  }

  async approvePlan(
    runId: string,
    input: { planHash: string; approvedByWallet: string },
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "APPROVE_PLAN",
      id,
      at,
      planHash: input.planHash,
      approvedByWallet: input.approvedByWallet,
    }));
  }

  async cancelRun(runId: string): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({ type: "CANCEL_RUN", id, at }));
  }

  async beginPrepare(runId: string, operationKind: OperationKind): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "BEGIN_PREPARE",
      id,
      at,
      operationKind,
    }));
  }

  async recordPrepared(
    runId: string,
    operationKind: OperationKind,
    input: { txId: string; unsignedTransaction: Record<string, unknown> },
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_PREPARED",
      id,
      at,
      operationKind,
      txId: input.txId,
      unsignedTransaction: input.unsignedTransaction,
    }));
  }

  async recordPrepareUnknown(runId: string, operationKind: OperationKind): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_PREPARE_UNKNOWN",
      id,
      at,
      operationKind,
    }));
  }

  async recordPrepareFailure(runId: string, operationKind: OperationKind): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_PREPARE_FAILURE",
      id,
      at,
      operationKind,
    }));
  }

  async recordWalletPrompt(runId: string, operationKind: OperationKind): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_WALLET_PROMPT",
      id,
      at,
      operationKind,
    }));
  }

  async recordWalletRejection(
    runId: string,
    operationKind: OperationKind,
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_WALLET_REJECTION",
      id,
      at,
      operationKind,
    }));
  }

  async recordBroadcastHash(
    runId: string,
    operationKind: OperationKind,
    txHash: string,
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_BROADCAST_HASH",
      id,
      at,
      operationKind,
      txHash,
    }));
  }

  async recordBroadcastUnknown(
    runId: string,
    operationKind: OperationKind,
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_BROADCAST_UNKNOWN",
      id,
      at,
      operationKind,
    }));
  }

  async submitConfirmation(
    runId: string,
    operationKind: OperationKind,
  ): Promise<{ run: ExecutionRunV1; txId: string; txHash: string }> {
    const run = await this.#apply(runId, (at, id) => ({
      type: "SUBMIT_CONFIRMATION",
      id,
      at,
      operationKind,
    }));
    const pair = persistedConfirmationPair(run, operationKind);
    if (pair === null) {
      throw new InvalidRunSnapshotError();
    }
    return { run, ...pair };
  }

  async recordPending(runId: string, operationKind: OperationKind): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_PENDING",
      id,
      at,
      operationKind,
    }));
  }

  async recordConfirmTransportFailure(
    runId: string,
    operationKind: OperationKind,
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_CONFIRM_TRANSPORT_FAILURE",
      id,
      at,
      operationKind,
    }));
  }

  async recordConfirmed(runId: string, operationKind: OperationKind): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_CONFIRMED",
      id,
      at,
      operationKind,
    }));
  }

  async recordRejected(
    runId: string,
    operationKind: OperationKind,
    error: string,
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_REJECTED",
      id,
      at,
      operationKind,
      error,
    }));
  }

  async recordPollTimeout(runId: string, operationKind: OperationKind): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_POLL_TIMEOUT",
      id,
      at,
      operationKind,
    }));
  }

  async recordReadBackVerified(
    runId: string,
    operationKind: OperationKind,
    read: string,
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_READ_BACK_VERIFIED",
      id,
      at,
      operationKind,
      read,
    }));
  }

  async recordReadBackMismatch(
    runId: string,
    operationKind: OperationKind,
  ): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_READ_BACK_MISMATCH",
      id,
      at,
      operationKind,
    }));
  }

  async recordFinalVerification(runId: string): Promise<ExecutionRunV1> {
    return this.#apply(runId, (at, id) => ({
      type: "RECORD_FINAL_VERIFICATION",
      id,
      at,
    }));
  }

  async #apply(
    runId: string,
    event: (at: IsoUtcTimestamp, id: string) => ExecutionRunEvent,
  ): Promise<ExecutionRunV1> {
    const current = await this.#repository.getById(runId);
    const next = applyRunEvent(current, event(this.#clock.nowIso(), this.#ids.eventId()));
    return this.#repository.update(runId, current.revision, next);
  }
}
