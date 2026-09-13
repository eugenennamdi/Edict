import "server-only";

import { canonicalizeJson, hashCanonicalJson } from "@/core";
import {
  type SemanticAuthorizationV1,
  type WalletExecutionIntentHash,
  walletExecutionIntentHashSchema,
} from "@/shared/wallet/execution-authorization";
import {
  parseSendAuthorizedEnvelopeV1,
  type SendAuthorizedEnvelopeV1,
} from "@/shared/wallet/send-authorization";
export type { SendAuthorizedEnvelopeV1 } from "@/shared/wallet/send-authorization";
import { projectPreparedTransactionV1 } from "@/shared/wallet/transaction";
import {
  type BrickkenCorrelationOutcome,
  type BrickkenCorrelationResult,
  type BrickkenStatusDurableEvidenceV1,
  type BrickkenServerAdapter,
  type BrickkenTransactionLocator,
  type BrickkenTransactionStatusResult,
  BrickkenAdapterError,
  buildStatusDurableEvidence,
  classifyCorrelationResponse,
  classifyCorrelationTransportError,
  evaluateCorrelationRetry,
  parseTransactionStatusResponse,
} from "../brickken";
import {
  IllegalStateTransitionError,
  RepositoryRevisionConflictError,
} from "../execution/errors";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import type { ExecutionRunRepository } from "../execution/repository";
import type {
  ExecutionRun,
  ExecutionRunV4,
  IsoUtcTimestamp,
  OperationKind,
  PreparationAttemptV1,
  WriteOperationV4,
} from "../execution/types";
import {
  authorizeCorrelationRetryV4,
  authorizeProviderInvocationV4,
  beginBrickkenCorrelationV4,
  beginReprepareV4,
  markPreparedStaleV4,
  recordBrickkenCorrelatedV4,
  recordBrickkenStatusEvidenceV4,
  recordBroadcastHashV4,
  recordBroadcastUnknownV4,
  recordCorrelationUncertainV4,
  recordRepreparedV4,
  recordRpcReceiptEvidenceV4,
  recordRpcTransactionV4,
  recordTokenIdentityFromReadBackV4,
  recordWalletPromptAuthorizationV4,
  recordWalletRejectedV4,
  upgradePreparedRunToV4,
  type V4PreparationFoundationInput,
} from "../execution/v4-transitions";
import {
  compareOnchainTransaction,
  evaluatePreparedFreshness,
  evaluateReceiptAndFinality,
  rpcHash32Schema,
  type FreshnessEvaluation,
  type ReceiptFinalityEvaluation,
  type TransactionComparisonEvaluation,
  type TrustedSepoliaRpcClient,
} from "../rpc";
import { z } from "zod";
import { OrchestrationError } from "./errors";
import {
  deriveTokenizationEventEvidence,
  ERC1967_IMPLEMENTATION_SLOT,
  implementationAddressFromErc1967Slot,
  REVIEWED_SEPOLIA_FACTORY,
  REVIEWED_SEPOLIA_IMPLEMENTATION,
  TokenizeReceiptBindingError,
  type TokenizationEventEvidenceV1,
} from "./tokenize-receipt-binding";
export { OrchestrationError } from "./errors";

export type BroadcastUnknownReason =
  | "BROWSER_DISAPPEARED"
  | "CLIENT_CLAIMED_NOT_INVOKED"
  | "PROVIDER_4001"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "HASH_PERSISTENCE_UNCONFIRMED";

export interface SemanticAuthorizationEvaluator {
  readonly isProductionDenyAll?: boolean;
  evaluate(input: {
    readonly run: ExecutionRunV4;
    readonly kind: OperationKind;
    readonly attempt: PreparationAttemptV1;
  }): Promise<
    | Readonly<{ authorized: true; semanticAuthorization: SemanticAuthorizationV1 }>
    | Readonly<{ authorized: false; reason: string }>
  >;
}

export class DenyAllSemanticAuthorizationEvaluator
  implements SemanticAuthorizationEvaluator
{
  readonly isProductionDenyAll = true;

  constructor(readonly reason: string = "AUTHORIZATION_DENIED") {}

  async evaluate(): Promise<Readonly<{ authorized: false; reason: string }>> {
    return Object.freeze({
      authorized: false,
      reason: this.reason,
    });
  }
}

export interface BrickkenCorrelationSender {
  send(pair: { readonly txId: string; readonly txHash: string }): Promise<
    | BrickkenCorrelationResult
    | Readonly<{
        status: number;
        data?: unknown;
        error?: unknown;
        rawBody?: string;
        headers?: Headers;
      }>
    | Response
  >;
}

export class DisabledBrickkenCorrelationSender
  implements BrickkenCorrelationSender
{
  async send(): Promise<never> {
    throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
  }
}

export interface BrickkenStatusFetcher {
  fetch(locator: BrickkenTransactionLocator): Promise<
    | BrickkenTransactionStatusResult
    | Readonly<{
        status: number;
        data?: unknown;
        error?: unknown;
        rawBody?: string;
        headers?: Headers;
      }>
    | Response
  >;
}

export class DisabledBrickkenStatusFetcher implements BrickkenStatusFetcher {
  async fetch(): Promise<never> {
    throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
  }
}

export interface ExecutionV4OrchestratorDependencies {
  readonly repository: ExecutionRunRepository;
  readonly rpc: TrustedSepoliaRpcClient;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly semanticAuthorization?: SemanticAuthorizationEvaluator;
  readonly brickkenCorrelationSender?: BrickkenCorrelationSender;
  readonly brickkenStatusFetcher?: BrickkenStatusFetcher;
  readonly brickkenReadBack?: Pick<
    BrickkenServerAdapter,
    "getTokenInfo" | "getTokenizerInfo"
  >;
}

export type PreflightWalletAuthorizationResult =
  | Readonly<{
      authorized: true;
      semanticAuthorization: SemanticAuthorizationV1;
      freshness: FreshnessEvaluation;
    }>
  | Readonly<{
      authorized: false;
      reason: string;
      freshness?: FreshnessEvaluation;
      detail?: string;
    }>;

export type OrchestrationCorrelationResult =
  | BrickkenCorrelationResult
  | Readonly<{
      outcome: "RETRY_BUDGET_EXHAUSTED";
      retryable: false;
      reconciliationRequired: true;
      reason: string;
    }>;

export interface TrackExecutionResult {
  readonly run: ExecutionRunV4;
  readonly rpcEvaluation?: TransactionComparisonEvaluation;
  readonly receiptEvaluation?: ReceiptFinalityEvaluation;
  readonly correlationResult?: OrchestrationCorrelationResult;
  readonly statusResult?: BrickkenTransactionStatusResult;
}

export const ingestBroadcastHashInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    invocationAttemptId: z.string().min(1).max(1024),
    walletIntentHash: walletExecutionIntentHashSchema,
    txHash: rpcHash32Schema,
  })
  .strict();

export type IngestBroadcastHashInput = z.infer<typeof ingestBroadcastHashInputSchema>;

export const browserBroadcastUnknownInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  invocationAttemptId: z.string().min(1).max(1024),
  walletIntentHash: walletExecutionIntentHashSchema,
  reason: z.enum([
    "PROVIDER_4001",
    "PROVIDER_TIMEOUT",
    "PROVIDER_ERROR",
    "HASH_PERSISTENCE_UNCONFIRMED",
  ]),
});

export type BrowserBroadcastUnknownInput = z.infer<typeof browserBroadcastUnknownInputSchema>;

export interface ActiveOperationInfo<T extends ExecutionRun = ExecutionRun> {
  readonly kind: OperationKind;
  readonly index: 0 | 1 | 2;
  readonly operation: T["operations"][0 | 1 | 2];
}

export function deriveActiveOperation<T extends ExecutionRun>(
  run: T,
): ActiveOperationInfo<T> {
  if (run.phase === "TOKENIZATION") {
    return { kind: "TOKENIZE", index: 0, operation: run.operations[0] };
  }
  if (run.phase === "WHITELIST") {
    return { kind: "WHITELIST", index: 1, operation: run.operations[1] };
  }
  if (run.phase === "MINT") {
    return { kind: "MINT", index: 2, operation: run.operations[2] };
  }
  throw new IllegalStateTransitionError();
}


function assertRevision(run: ExecutionRun, expectedRevision: number): void {
  if (run.revision !== expectedRevision) {
    throw new RepositoryRevisionConflictError();
  }
}

export function assertV4(run: ExecutionRun): asserts run is ExecutionRunV4 {
  if (run.schemaVersion !== "4.0") {
    throw new IllegalStateTransitionError();
  }
}

function getActiveAttempt(operation: WriteOperationV4): PreparationAttemptV1 {
  const attempt = operation.preparationAttempts.find(
    (candidate) => candidate.attemptId === operation.activePreparationAttemptId,
  );
  if (!attempt) throw new IllegalStateTransitionError();
  return attempt;
}

export class ExecutionV4Orchestrator {
  readonly #deps: ExecutionV4OrchestratorDependencies;
  readonly #semanticAuth: SemanticAuthorizationEvaluator;
  readonly #correlationSender: BrickkenCorrelationSender;
  readonly #statusFetcher: BrickkenStatusFetcher;
  readonly #readBack: ExecutionV4OrchestratorDependencies["brickkenReadBack"];

  constructor(deps: ExecutionV4OrchestratorDependencies) {
    this.#deps = deps;
    this.#semanticAuth =
      deps.semanticAuthorization ?? new DenyAllSemanticAuthorizationEvaluator();
    this.#correlationSender =
      deps.brickkenCorrelationSender ?? new DisabledBrickkenCorrelationSender();
    this.#statusFetcher =
      deps.brickkenStatusFetcher ?? new DisabledBrickkenStatusFetcher();
    this.#readBack = deps.brickkenReadBack;
  }

  async promotePreparedRunToV4(
    runId: string,
    expectedRevision: number,
    foundation?: V4PreparationFoundationInput,
  ): Promise<ExecutionRunV4> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    if (
      current.status === "FAILED" ||
      current.status === "RECONCILIATION_REQUIRED" ||
      current.terminalOutcome !== null
    ) {
      throw new IllegalStateTransitionError();
    }
    if (current.approval === null || !("proof" in current.approval)) {
      throw new IllegalStateTransitionError();
    }
    const { kind, operation: op } = deriveActiveOperation(current);
    if (
      op.stage !== "PREPARED" ||
      op.preparedTxId === null ||
      op.unsignedTransaction === null
    ) {
      throw new IllegalStateTransitionError();
    }

    if (current.schemaVersion === "4.0") {
      return current;
    }

    const v4Foundation: V4PreparationFoundationInput = foundation ?? {
      attemptId: this.#deps.ids.operationId(),
      freshnessPolicyVersion: "edict-freshness-v1",
    };
    const v4Run = await upgradePreparedRunToV4(current, kind, v4Foundation);
    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      v4Run,
    )) as ExecutionRunV4;
  }

  async evaluateAndApplyPreparedFreshness(
    runId: string,
    expectedRevision: number,
  ): Promise<{ evaluation: FreshnessEvaluation; run: ExecutionRun }> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    // Promotion is an explicit, separately authorized mutation. Readiness must
    // never upgrade a V2 record as a side effect.
    assertV4(current);
    const { kind, operation: op } = deriveActiveOperation(current);
    const evaluation = await evaluatePreparedFreshness({
      client: this.#deps.rpc,
      run: current,
      kind,
      policyVersion: "edict-freshness-v1",
      observedAt: this.#deps.clock.nowIso(),
    });

    if (
      evaluation.outcome === "STALE_NONCE" &&
      evaluation.nonceEvidence !== null
    ) {
      let foundation: V4PreparationFoundationInput = {
        attemptId: this.#deps.ids.operationId(),
        freshnessPolicyVersion: "edict-freshness-v1",
      };
      if ("preparationAttempts" in op && Array.isArray(op.preparationAttempts)) {
        const active = op.preparationAttempts.find(
          (a) => a.attemptId === op.activePreparationAttemptId,
        );
        if (active) {
          foundation = {
            attemptId: active.attemptId,
            freshnessPolicyVersion: active.freshnessPolicyVersion,
          };
        }
      }
      const nextRun = await markPreparedStaleV4({
        run: current,
        kind,
        foundation,
        nonceEvidence: evaluation.nonceEvidence,
        id: this.#deps.ids.eventId(),
        at: evaluation.nonceEvidence.observedAt,
      });
      const updated = await this.#deps.repository.update(
        runId,
        expectedRevision,
        nextRun,
      );
      return { evaluation, run: updated };
    }

    return { evaluation, run: current };
  }

  async beginReprepare(
    runId: string,
    expectedRevision: number,
    newAttemptId?: string,
  ): Promise<ExecutionRunV4> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);
    const { kind } = deriveActiveOperation(current);
    const nextRun = beginReprepareV4({
      run: current,
      kind,
      attemptId: newAttemptId ?? this.#deps.ids.operationId(),
      id: this.#deps.ids.eventId(),
      at: this.#deps.clock.nowIso(),
    });
    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async recordReprepared(
    runId: string,
    expectedRevision: number,
    txId: string,
    unsignedTransaction: Record<string, unknown>,
  ): Promise<ExecutionRunV4> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);
    const { kind } = deriveActiveOperation(current);
    const nextRun = await recordRepreparedV4({
      run: current,
      kind,
      txId,
      unsignedTransaction,
      id: this.#deps.ids.eventId(),
      at: this.#deps.clock.nowIso(),
    });
    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async preflightWalletAuthorization(
    runId: string,
    expectedRevision: number,
  ): Promise<PreflightWalletAuthorizationResult> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    if (current.status !== "AWAITING_WALLET") {
      return Object.freeze({
        authorized: false,
        reason: "RUN_NOT_AWAITING_WALLET",
      });
    }

    const { kind, operation: op } = deriveActiveOperation(current);
    if (op.stage !== "PREPARED") {
      return Object.freeze({
        authorized: false,
        reason: "OPERATION_NOT_PREPARED",
      });
    }

    if (op.walletPromptAuthorization !== null) {
      return Object.freeze({
        authorized: false,
        reason: "WALLET_PROMPT_ALREADY_RECORDED",
      });
    }

    const active = getActiveAttempt(op);
    if (
      active.txId === null ||
      active.preparationFingerprint === null ||
      active.immutableIdentity === null ||
      active.feeAuthorization === null
    ) {
      return Object.freeze({
        authorized: false,
        reason: "INCOMPLETE_PREPARATION_ATTEMPT",
      });
    }

    const freshness = await evaluatePreparedFreshness({
      client: this.#deps.rpc,
      run: current,
      kind,
      policyVersion: "edict-freshness-v1",
      observedAt: this.#deps.clock.nowIso(),
    });

    if (!freshness.eligible) {
      return Object.freeze({
        authorized: false,
        reason: "FRESHNESS_CHECK_FAILED",
        freshness,
        detail: freshness.outcome,
      });
    }

    const semanticResult = await this.#semanticAuth.evaluate({
      run: current,
      kind,
      attempt: active,
    });

    if (!semanticResult.authorized) {
      return Object.freeze({
        authorized: false,
        reason: "AUTHORIZATION_DENIED",
        freshness,
        detail: semanticResult.reason,
      });
    }

    return Object.freeze({
      authorized: true,
      semanticAuthorization: semanticResult.semanticAuthorization,
      freshness,
    });
  }

  async recordWalletPrompt(
    runId: string,
    expectedRevision: number,
    options?: {
      readonly nonceEvidence?: unknown;
      readonly semanticAuthorization?: SemanticAuthorizationV1;
    },
  ): Promise<ExecutionRunV4> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);
    const { kind, operation: op } = deriveActiveOperation(current);
    const active = getActiveAttempt(op);

    let nonceEvidence = options?.nonceEvidence;
    let semantic = options?.semanticAuthorization;

    if (!nonceEvidence || !semantic) {
      const preflight = await this.preflightWalletAuthorization(
        runId,
        expectedRevision,
      );
      if (!preflight.authorized) {
        throw new OrchestrationError("AUTHORIZATION_DENIED");
      }
      nonceEvidence = preflight.freshness?.nonceEvidence;
      semantic = preflight.semanticAuthorization;
    }

    const foundation: V4PreparationFoundationInput = {
      attemptId: active.attemptId,
      freshnessPolicyVersion: active.freshnessPolicyVersion,
    };

    const nextRun = await recordWalletPromptAuthorizationV4({
      run: current,
      kind,
      foundation,
      nonceEvidence,
      semanticAuthorization: semantic,
      id: this.#deps.ids.eventId(),
      at: (nonceEvidence as { observedAt: IsoUtcTimestamp }).observedAt,
    });

    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async releaseSendAuthority(
    runId: string,
    expectedRevision: number,
  ): Promise<{ envelope: SendAuthorizedEnvelopeV1; run: ExecutionRunV4 }> {
    // In production, semantic authorization is strictly DENY-ALL. Refuse immediately.
    if (this.#semanticAuth.isProductionDenyAll) {
      throw new OrchestrationError("AUTHORIZATION_DENIED");
    }

    let current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    let currentRevision = expectedRevision;
    const activeOp = deriveActiveOperation(current);
    const { kind } = activeOp;
    let op = activeOp.operation;

    // Sequential CAS: if still in PREPARED, record prompt authorization (CAS 1)
    if (op.stage === "PREPARED") {
      const active = getActiveAttempt(op);
      const preflight = await this.preflightWalletAuthorization(
        runId,
        currentRevision,
      );
      if (!preflight.authorized) {
        throw new OrchestrationError("AUTHORIZATION_DENIED");
      }
      const foundation: V4PreparationFoundationInput = {
        attemptId: active.attemptId,
        freshnessPolicyVersion: active.freshnessPolicyVersion,
      };
      const promptRun = await recordWalletPromptAuthorizationV4({
        run: current,
        kind,
        foundation,
        nonceEvidence: preflight.freshness?.nonceEvidence,
        semanticAuthorization: preflight.semanticAuthorization,
        id: this.#deps.ids.eventId(),
        at: (preflight.freshness?.nonceEvidence as { observedAt: IsoUtcTimestamp }).observedAt,
      });
      current = (await this.#deps.repository.update(
        runId,
        currentRevision,
        promptRun,
      )) as ExecutionRunV4;
      currentRevision = current.revision;
      const derived = deriveActiveOperation(current);
      op = derived.operation;
    }

    const prompt = op.walletPromptAuthorization;
    if (
      op.stage !== "WALLET_PROMPT_RECORDED" ||
      prompt === null ||
      prompt.providerInvocation !== "PROVEN_NOT_INVOKED"
    ) {
      throw new IllegalStateTransitionError();
    }

    // SERVER-GENERATED unique bounded invocationAttemptId
    const invocationAttemptId =
      this.#deps.ids.invocationAttemptId?.() ?? `inv-${this.#deps.ids.eventId()}`;

    // MANDATORY CAS BEFORE ENVELOPE RELEASE:
    // Transition to INVOKED_OR_UNKNOWN, unique invocationAttemptId, authorityReleasedAt
    const nextRun = authorizeProviderInvocationV4({
      run: current as ExecutionRunV4,
      kind,
      invocationAttemptId,
      id: this.#deps.ids.eventId(),
      at: this.#deps.clock.nowIso(),
    });

    const updatedRun = (await this.#deps.repository.update(
      runId,
      currentRevision,
      nextRun,
    )) as ExecutionRunV4;

    const released = deriveActiveOperation(updatedRun).operation;
    const releasedPrompt = released.walletPromptAuthorization;
    const releasedAttempt = getActiveAttempt(released);
    if (
      releasedPrompt === null ||
      releasedPrompt.invocationAttemptId !== invocationAttemptId ||
      releasedAttempt.unsignedTransaction === null
    ) {
      throw new IllegalStateTransitionError();
    }
    const prepared = projectPreparedTransactionV1(releasedAttempt.unsignedTransaction);
    const request = prepared.walletRequest;
    const identity = releasedPrompt.walletIntent.immutableIdentity;
    const fees = releasedPrompt.walletIntent.feeAuthorization;
    if (
      prepared.chainId !== releasedPrompt.walletIntent.chainRequirement.rpcChainId ||
      request.from !== releasedPrompt.walletIntent.requiredSigner ||
      request.from !== identity.from ||
      request.to !== identity.to ||
      request.data !== identity.data ||
      request.value !== identity.value ||
      request.nonce !== identity.nonce ||
      request.gas !== fees.preparedDefaults.gasLimit ||
      request.type !== fees.transactionType ||
      request.maxFeePerGas !== fees.preparedDefaults.maxFeePerGas ||
      request.maxPriorityFeePerGas !== fees.preparedDefaults.maxPriorityFeePerGas ||
      request.gasPrice !== undefined ||
      canonicalizeJson(request.accessList ?? []) !== canonicalizeJson(fees.preparedAccessList)
    ) {
      throw new IllegalStateTransitionError();
    }
    const envelope = parseSendAuthorizedEnvelopeV1({
      domain: "edict.send-authorized-envelope.v1",
      expectedRevision: updatedRun.revision,
      invocationAttemptId,
      walletIntentHash: releasedPrompt.walletIntentHash as WalletExecutionIntentHash,
      requiredSigner: releasedPrompt.walletIntent.requiredSigner,
      chainRequirement: {
        decimalChainId: releasedPrompt.walletIntent.chainRequirement.decimalChainId,
        rpcChainId: releasedPrompt.walletIntent.chainRequirement.rpcChainId,
      },
      walletRequest: prepared.walletRequest,
    });

    return { envelope, run: updatedRun };
  }

  async recordBroadcastUnknown(
    runId: string,
    expectedRevision: number,
    reason: BroadcastUnknownReason,
  ): Promise<ExecutionRunV4> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);
    const { kind } = deriveActiveOperation(current);
    const nextRun = recordBroadcastUnknownV4({
      run: current,
      kind,
      reason,
      id: this.#deps.ids.eventId(),
      at: this.#deps.clock.nowIso(),
    });
    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async recordBrowserBroadcastUnknown(
    runId: string,
    rawInput: BrowserBroadcastUnknownInput,
  ): Promise<ExecutionRunV4> {
    const input = browserBroadcastUnknownInputSchema.parse(rawInput);
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, input.expectedRevision);
    assertV4(current);
    const { kind, operation } = deriveActiveOperation(current);
    const prompt = operation.walletPromptAuthorization;
    if (
      operation.stage !== "WALLET_PROMPT_RECORDED" ||
      prompt === null ||
      prompt.providerInvocation !== "INVOKED_OR_UNKNOWN" ||
      prompt.invocationAttemptId !== input.invocationAttemptId ||
      prompt.walletIntentHash !== input.walletIntentHash
    ) {
      throw new IllegalStateTransitionError();
    }
    const nextRun = recordBroadcastUnknownV4({
      run: current,
      kind,
      reason: input.reason,
      id: this.#deps.ids.eventId(),
      at: this.#deps.clock.nowIso(),
    });
    return (await this.#deps.repository.update(
      runId,
      input.expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async recordWalletRejected(
    runId: string,
    expectedRevision: number,
  ): Promise<ExecutionRunV4> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);
    const { kind } = deriveActiveOperation(current);
    const nextRun = recordWalletRejectedV4({
      run: current,
      kind,
      id: this.#deps.ids.eventId(),
      at: this.#deps.clock.nowIso(),
    });
    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async ingestBroadcastHash(
    runId: string,
    rawInput: IngestBroadcastHashInput,
  ): Promise<ExecutionRunV4> {
    const input = ingestBroadcastHashInputSchema.parse(rawInput);
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, input.expectedRevision);
    assertV4(current);

    const { kind, operation: op } = deriveActiveOperation(current);
    const prompt = op.walletPromptAuthorization;

    if (
      op.stage !== "WALLET_PROMPT_RECORDED" ||
      prompt === null ||
      prompt.providerInvocation !== "INVOKED_OR_UNKNOWN"
    ) {
      throw new IllegalStateTransitionError();
    }

    if (
      prompt.invocationAttemptId !== input.invocationAttemptId ||
      prompt.walletIntentHash !== input.walletIntentHash
    ) {
      throw new IllegalStateTransitionError();
    }

    const active = getActiveAttempt(op);
    if (
      active.txId === null ||
      active.immutableIdentity === null ||
      prompt.walletIntent.immutableIdentity.chainId !== current.chainId ||
      prompt.walletIntent.immutableIdentity.from.toLowerCase() !==
        current.requiredSigner.walletAddress.toLowerCase()
    ) {
      throw new IllegalStateTransitionError();
    }

    const nextRun = recordBroadcastHashV4({
      run: current,
      kind,
      txHash: input.txHash,
      id: this.#deps.ids.eventId(),
      at: this.#deps.clock.nowIso(),
    });

    return (await this.#deps.repository.update(
      runId,
      input.expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async verifyOnchainTransaction(
    runId: string,
    expectedRevision: number,
  ): Promise<{ evaluation: TransactionComparisonEvaluation; run: ExecutionRunV4 }> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    const { kind, operation: op } = deriveActiveOperation(current);
    if (op.blockchainTxHash === null) {
      throw new IllegalStateTransitionError();
    }
    const active = getActiveAttempt(op);
    if (active.immutableIdentity === null || active.feeAuthorization === null) {
      throw new IllegalStateTransitionError();
    }

    const evaluation = await compareOnchainTransaction({
      client: this.#deps.rpc,
      txHash: op.blockchainTxHash,
      expectedImmutableIdentity: active.immutableIdentity,
      expectedFeeAuthorization: active.feeAuthorization,
      observedAt: this.#deps.clock.nowIso(),
    });

    if (
      [
        "RPC_TRANSACTION_VERIFIED",
        "POLICY_VIOLATION_ONCHAIN",
        "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
        "BRICKKEN_CORRELATION_PENDING",
        "BRICKKEN_CORRELATED",
        "READ_BACK_VERIFIED",
      ].includes(op.stage)
    ) {
      return { evaluation, run: current };
    }

    if (op.stage !== "BROADCAST_HASH_PERSISTED") {
      throw new IllegalStateTransitionError();
    }

    if (
      evaluation.presence === "NOT_FOUND" ||
      evaluation.observedTransaction === null ||
      evaluation.evidence === null
    ) {
      return { evaluation, run: current };
    }

    const tx = evaluation.observedTransaction;
    const observedImmutableIdentity = {
      identityVersion: "1.0" as const,
      chainId: tx.chainId,
      from: tx.from,
      to: tx.to ?? "0x0000000000000000000000000000000000000000",
      data: tx.input,
      value: tx.value,
      nonce: tx.nonce,
    };

    const actualFeeFields = {
      transactionType: "0x2" as const,
      gasLimit: tx.gas,
      maxFeePerGas: tx.maxFeePerGas ?? "0x0",
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? "0x0",
      gasPrice: tx.gasPrice,
      accessList: tx.accessList,
    };

    const nextRun = recordRpcTransactionV4({
      run: current,
      kind,
      txHash: op.blockchainTxHash,
      immutableIdentity: observedImmutableIdentity,
      actualFeeFields,
      id: this.#deps.ids.eventId(),
      at: evaluation.evidence.observedAt,
    });

    const updatedRun = (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;

    return { evaluation, run: updatedRun };
  }

  async evaluateAndRecordReceiptFinality(
    runId: string,
    expectedRevision: number,
  ): Promise<{ evaluation: ReceiptFinalityEvaluation; run: ExecutionRunV4 }> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    const { kind, operation: op } = deriveActiveOperation(current);
    if (
      ![
        "RPC_TRANSACTION_VERIFIED",
        "POLICY_VIOLATION_ONCHAIN",
        "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
        "BRICKKEN_CORRELATION_PENDING",
        "BRICKKEN_CORRELATED",
      ].includes(op.stage) ||
      op.blockchainTxHash === null ||
      op.rpcTransactionEvidence === null
    ) {
      throw new IllegalStateTransitionError();
    }

    const active = getActiveAttempt(op);
    const evaluation = await evaluateReceiptAndFinality({
      client: this.#deps.rpc,
      txHash: op.blockchainTxHash,
      expectedFrom: op.rpcTransactionEvidence.immutableIdentity.from,
      expectedTo: op.rpcTransactionEvidence.immutableIdentity.to,
      expectedType: "0x2",
      gasLimit: active.feeAuthorization?.authorizedCaps.gasLimit,
      observedAt: this.#deps.clock.nowIso(),
    });

    if (
      evaluation.receiptStatus === "NOT_FOUND" ||
      evaluation.evidence === null
    ) {
      return { evaluation, run: current };
    }

    const prior = op.transactionReceiptEvidence;
    if (prior !== null) {
      if (prior.finalityStatus === "FINALIZED") {
        return { evaluation, run: current };
      }
      const sameInclusion =
        prior.transactionHash === evaluation.evidence.transactionHash &&
        prior.blockHash === evaluation.evidence.blockHash &&
        prior.blockNumber === evaluation.evidence.blockNumber &&
        prior.transactionIndex === evaluation.evidence.transactionIndex;
      if (sameInclusion && evaluation.evidence.finalityStatus !== "FINALIZED") {
        return { evaluation, run: current };
      }
    }

    const nextRun = recordRpcReceiptEvidenceV4({
      run: current,
      kind,
      evidence: evaluation.evidence,
      id: this.#deps.ids.eventId(),
    });

    const updatedRun = (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;

    return { evaluation, run: updatedRun };
  }

  async correlateWithBrickken(
    runId: string,
    expectedRevision: number,
  ): Promise<{ result: OrchestrationCorrelationResult; run: ExecutionRunV4 }> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    const { kind, operation: op } = deriveActiveOperation(current);
    const active = getActiveAttempt(op);

    if (active.txId === null || op.blockchainTxHash === null) {
      throw new IllegalStateTransitionError();
    }

    const rpcEvidence = op.rpcTransactionEvidence;
    if (rpcEvidence === null || rpcEvidence.immutableIdentityStatus !== "MATCH") {
      throw new IllegalStateTransitionError();
    }
    if (op.transactionReceiptEvidence?.executionStatus === "REVERTED") {
      throw new IllegalStateTransitionError();
    }

    if (current.events.some((e) => e.type === "RECORD_BRICKKEN_CORRELATION_REFUSED")) {
      return {
        result: {
          outcome: "CORRELATION_REFUSED",
          retryable: false,
          reconciliationRequired: true,
          reason: "Correlation was previously refused by Brickken.",
        },
        run: current,
      };
    }
    if (current.events.some((e) => e.type === "RECORD_BRICKKEN_CORRELATION_CONTRADICTION")) {
      return {
        result: {
          outcome: "CORRELATION_CONTRADICTION",
          retryable: false,
          reconciliationRequired: true,
          reason: "Correlation previously contradicted execution state.",
          returnedHash: op.blockchainTxHash,
          requestedHash: op.blockchainTxHash,
        },
        run: current,
      };
    }
    if (current.events.some((e) => e.type === "RECORD_BRICKKEN_CORRELATION_PREPARED_TRANSACTION_MISMATCH")) {
      return {
        result: {
          outcome: "PREPARED_TRANSACTION_MISMATCH",
          retryable: false,
          reconciliationRequired: true,
          reason: "Prepared transaction mismatched during correlation.",
        },
        run: current,
      };
    }
    if (current.events.some((e) => e.type === "RECORD_BRICKKEN_CORRELATION_RETRY_EXHAUSTED")) {
      return {
        result: {
          outcome: "RETRY_BUDGET_EXHAUSTED",
          retryable: false,
          reconciliationRequired: true,
          reason: "Correlation retry budget exhausted after 3 attempts.",
        },
        run: current,
      };
    }

    const pair = Object.freeze({
      txId: active.txId,
      txHash: op.blockchainTxHash,
    });

    if (op.stage === "BRICKKEN_CORRELATED" || op.stage === "READ_BACK_VERIFIED") {
      return {
        result: {
          outcome: "CORRELATED_PENDING",
          retryable: false,
          reconciliationRequired: false,
          evidence: {
            evidenceVersion: "1.0",
            correlatedAt: op.brickkenCorrelation?.correlatedAt ?? this.#deps.clock.nowIso(),
            txId: active.txId,
            txHash: op.blockchainTxHash,
            status: "pending",
            executionMode: "client-broadcast",
          },
        },
        run: current,
      };
    }

    let activeRun = current;
    if (op.stage !== "BRICKKEN_CORRELATION_PENDING") {
      if (
        !["RPC_TRANSACTION_VERIFIED", "POLICY_VIOLATION_ONCHAIN"].includes(
          op.stage,
        )
      ) {
        throw new IllegalStateTransitionError();
      }
      const beginRun = beginBrickkenCorrelationV4({
        run: current,
        kind,
        id: this.#deps.ids.eventId(),
        at: this.#deps.clock.nowIso(),
      });
      activeRun = (await this.#deps.repository.update(
        runId,
        current.revision,
        beginRun,
      )) as ExecutionRunV4;
    } else {
      const correlation = op.brickkenCorrelation;
      if (
        correlation === null ||
        correlation.pair.txId !== pair.txId ||
        correlation.pair.txHash !== pair.txHash
      ) {
        throw new IllegalStateTransitionError();
      }
      const last = correlation.attempts.at(-1);
      if (!last) throw new IllegalStateTransitionError();
      if (last.result !== "AUTHORIZED") {
        const lastResult = last.result;
        const lastOutcome: BrickkenCorrelationOutcome =
          lastResult === "TEMPORARILY_NOT_FOUND"
            ? "TEMPORARILY_NOT_FOUND"
            : "CORRELATION_UNCONFIRMED";

        const retryEval = evaluateCorrelationRetry({
          currentPair: correlation.pair,
          requestedPair: pair,
          attemptCount: correlation.attempts.length,
          lastOutcome,
        });
        if (!retryEval.authorized) {
          if (retryEval.reason === "BUDGET_EXHAUSTED") {
            if (
              current.status === "RECONCILIATION_REQUIRED" &&
              current.events.some(
                (e) => e.type === "RECORD_BRICKKEN_CORRELATION_RETRY_EXHAUSTED",
              )
            ) {
              return {
                result: {
                  outcome: "RETRY_BUDGET_EXHAUSTED",
                  retryable: false,
                  reconciliationRequired: true,
                  reason: "Correlation retry budget exhausted after 3 attempts.",
                },
                run: current,
              };
            }
            const exhaustedRun: ExecutionRunV4 = {
              ...current,
              status: "RECONCILIATION_REQUIRED",
              updatedAt: this.#deps.clock.nowIso(),
              events: [
                ...current.events,
                {
                  id: this.#deps.ids.eventId(),
                  sequence: current.events.length + 1,
                  type: "RECORD_BRICKKEN_CORRELATION_RETRY_EXHAUSTED",
                  at: this.#deps.clock.nowIso(),
                  actor: "BRICKKEN",
                  operationKind: kind,
                },
              ],
            };
            const updated = (await this.#deps.repository.update(
              runId,
              current.revision,
              exhaustedRun,
            )) as ExecutionRunV4;
            return {
              result: {
                outcome: "RETRY_BUDGET_EXHAUSTED",
                retryable: false,
                reconciliationRequired: true,
                reason: "Correlation retry budget exhausted after 3 attempts.",
              },
              run: updated,
            };
          }

          if (retryEval.reason === "OUTCOME_NOT_RETRYABLE") {
            const isRefused = current.events.some(
              (e) => e.type === "RECORD_BRICKKEN_CORRELATION_REFUSED",
            );
            return {
              result: {
                outcome: isRefused ? "CORRELATION_REFUSED" : "CORRELATION_CONTRADICTION",
                retryable: false,
                reconciliationRequired: true,
                reason: isRefused
                  ? "Correlation was previously refused by Brickken."
                  : "Correlation outcome is non-retryable.",
              } as BrickkenCorrelationResult,
              run: current,
            };
          }

          const contradictionRun: ExecutionRunV4 = {
            ...current,
            status: "RECONCILIATION_REQUIRED",
            terminalOutcome: null,
            updatedAt: this.#deps.clock.nowIso(),
            events: [
              ...current.events,
              {
                id: this.#deps.ids.eventId(),
                sequence: current.events.length + 1,
                type: "RECORD_BRICKKEN_CORRELATION_CONTRADICTION",
                at: this.#deps.clock.nowIso(),
                actor: "BRICKKEN",
                operationKind: kind,
              },
            ],
          };
          const updated = (await this.#deps.repository.update(
            runId,
            current.revision,
            contradictionRun,
          )) as ExecutionRunV4;
          return {
            result: {
              outcome: "CORRELATION_CONTRADICTION",
              retryable: false,
              reconciliationRequired: true,
              reason: `Pair mismatch: ${retryEval.reason}`,
              returnedHash: pair.txHash,
              requestedHash: correlation.pair.txHash,
            },
            run: updated,
          };
        }
        const retryRun = authorizeCorrelationRetryV4({
          run: current,
          kind,
          pair,
          id: this.#deps.ids.eventId(),
          at: this.#deps.clock.nowIso(),
        });
        activeRun = (await this.#deps.repository.update(
          runId,
          current.revision,
          retryRun,
        )) as ExecutionRunV4;
      }
    }

    let classified: BrickkenCorrelationResult;
    try {
      const rawResponse = await this.#correlationSender.send(pair);
      if ("outcome" in rawResponse) {
        classified = rawResponse;
      } else {
        let status = 200;
        let bodyText = "";
        let json: unknown = null;

        if (rawResponse instanceof Response) {
          status = rawResponse.status;
          bodyText = await rawResponse.text();
          try {
            json = JSON.parse(bodyText);
          } catch {
            json = null;
          }
        } else if (typeof rawResponse === "object" && rawResponse !== null) {
          const obj = rawResponse as {
            status?: number;
            data?: unknown;
            rawBody?: string;
          };
          status = obj.status ?? 200;
          json = obj.data ?? obj;
          bodyText = obj.rawBody ?? JSON.stringify(json);
        }

        classified = classifyCorrelationResponse({
          requestedTxHash: pair.txHash,
          txId: pair.txId,
          status,
          bodyText,
          json,
          correlatedAt: this.#deps.clock.nowIso(),
        });
      }
    } catch (error) {
      classified = classifyCorrelationTransportError(error);
    }

    if (classified.outcome === "CORRELATED_PENDING") {
      const nextRun = recordBrickkenCorrelatedV4({
        run: activeRun,
        kind,
        pair,
        id: this.#deps.ids.eventId(),
        at: this.#deps.clock.nowIso(),
      });
      const updated = (await this.#deps.repository.update(
        runId,
        activeRun.revision,
        nextRun,
      )) as ExecutionRunV4;
      return { result: classified, run: updated };
    }

    if (
      classified.outcome === "TEMPORARILY_NOT_FOUND" ||
      classified.outcome === "CORRELATION_UNCONFIRMED"
    ) {
      const uncertainResult =
        classified.outcome === "TEMPORARILY_NOT_FOUND"
          ? "TEMPORARILY_NOT_FOUND"
          : "TRANSPORT_UNKNOWN";

      const nextRun = recordCorrelationUncertainV4({
        run: activeRun,
        kind,
        pair,
        result: uncertainResult,
        id: this.#deps.ids.eventId(),
        at: this.#deps.clock.nowIso(),
      });
      const updated = (await this.#deps.repository.update(
        runId,
        activeRun.revision,
        nextRun,
      )) as ExecutionRunV4;
      return { result: classified, run: updated };
    }

    const eventType =
      classified.outcome === "CORRELATION_REFUSED"
        ? "RECORD_BRICKKEN_CORRELATION_REFUSED"
        : classified.outcome === "CORRELATION_CONTRADICTION"
        ? "RECORD_BRICKKEN_CORRELATION_CONTRADICTION"
        : "RECORD_BRICKKEN_CORRELATION_PREPARED_TRANSACTION_MISMATCH";

    const refusalOrContradictionRun: ExecutionRunV4 = {
      ...activeRun,
      status: "RECONCILIATION_REQUIRED",
      terminalOutcome: null,
      updatedAt: this.#deps.clock.nowIso(),
      events: [
        ...activeRun.events,
        {
          id: this.#deps.ids.eventId(),
          sequence: activeRun.events.length + 1,
          type: eventType,
          at: this.#deps.clock.nowIso(),
          actor: "BRICKKEN",
          operationKind: kind,
        },
      ],
    };
    const updated = (await this.#deps.repository.update(
      runId,
      activeRun.revision,
      refusalOrContradictionRun,
    )) as ExecutionRunV4;
    return { result: classified, run: updated };
  }

  async checkBrickkenStatus(
    runId: string,
    expectedRevision: number,
    locatorInput?: BrickkenTransactionLocator,
  ): Promise<{
    statusResult: BrickkenTransactionStatusResult;
    durableEvidence: BrickkenStatusDurableEvidenceV1;
    run: ExecutionRunV4;
  }> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    const { kind, operation: op } = deriveActiveOperation(current);
    const active = getActiveAttempt(op);

    if (
      (op.stage !== "BRICKKEN_CORRELATED" && op.stage !== "READ_BACK_VERIFIED") ||
      active.txId === null ||
      op.blockchainTxHash === null
    ) {
      throw new IllegalStateTransitionError();
    }

    if (op.stage === "READ_BACK_VERIFIED") {
      const lastEvidence = op.brickkenStatusEvidence.at(-1);
      const observedAt = this.#deps.clock.nowIso();
      const locator: BrickkenTransactionLocator = locatorInput ?? { txId: active.txId };
      const statusResult: BrickkenTransactionStatusResult = {
        httpStatus: 200,
        responseByteCount: 0,
        contentType: "application/json",
        transactionHash: op.blockchainTxHash,
        rawStatusText: lastEvidence?.status ?? null,
        diagnosticError: null,
        error: null,
      };
      const durableEvidence = buildStatusDurableEvidence({
        diagnostic: statusResult,
        locator,
        observedAt,
      });
      return { statusResult, durableEvidence, run: current };
    }

    const locator: BrickkenTransactionLocator =
      locatorInput ?? { txId: active.txId };

    let statusResult: BrickkenTransactionStatusResult;
    let contradictionDetected = false;

    try {
      const rawResponse = await this.#statusFetcher.fetch(locator);
      if ("rawStatusText" in rawResponse) {
        statusResult = rawResponse;
      } else {
        let rawJson: unknown;
        let httpStatus = 200;
        let responseByteCount = 0;
        let contentType: string | null = "application/json";

        if (rawResponse instanceof Response) {
          httpStatus = rawResponse.status;
          contentType = rawResponse.headers.get("content-type");
          const text = await rawResponse.text();
          responseByteCount = Buffer.byteLength(text, "utf8");
          try {
            rawJson = JSON.parse(text);
          } catch {
            rawJson = null;
          }
        } else if (typeof rawResponse === "object" && rawResponse !== null) {
          const obj = rawResponse as {
            status?: number;
            data?: unknown;
            rawBody?: string;
            headers?: Headers;
          };
          httpStatus = obj.status ?? 200;
          rawJson = obj.data ?? obj;
          const text = obj.rawBody ?? JSON.stringify(rawJson);
          responseByteCount = Buffer.byteLength(text, "utf8");
        } else {
          rawJson = rawResponse;
        }

        statusResult = parseTransactionStatusResponse(
          {
            json: rawJson,
            locator,
            expectedTxHash: op.blockchainTxHash,
            httpStatus,
            responseByteCount,
            contentType,
          },
          locator,
          op.blockchainTxHash,
        );
      }
    } catch (error) {
      if (
        error instanceof BrickkenAdapterError &&
        error.code === "STATUS_CONTRADICTION"
      ) {
        contradictionDetected = true;
        statusResult = {
          httpStatus: 200,
          responseByteCount: 0,
          contentType: "application/json",
          transactionHash: null,
          rawStatusText: null,
          diagnosticError: "STATUS_CONTRADICTION",
          error: "STATUS_CONTRADICTION",
        };
      } else {
        throw error;
      }
    }

    const observedAt = this.#deps.clock.nowIso();
    const durableEvidence = buildStatusDurableEvidence({
      diagnostic: statusResult,
      locator,
      observedAt,
    });

    if (
      contradictionDetected ||
      statusResult.diagnosticError === "STATUS_CONTRADICTION" ||
      (statusResult.transactionHash !== null &&
        statusResult.transactionHash.toLowerCase() !== op.blockchainTxHash.toLowerCase())
    ) {
      const reconciliationRun: ExecutionRunV4 = {
        ...current,
        status: "RECONCILIATION_REQUIRED",
        updatedAt: observedAt,
        events: [
          ...current.events,
          {
            id: this.#deps.ids.eventId(),
            sequence: current.events.length + 1,
            type: "RECORD_BRICKKEN_STATUS_CONTRADICTION",
            at: observedAt,
            actor: "BRICKKEN",
            operationKind: kind,
          },
        ],
      };
      const updated = (await this.#deps.repository.update(
        runId,
        expectedRevision,
        reconciliationRun,
      )) as ExecutionRunV4;
      return { statusResult, durableEvidence, run: updated };
    }

    if (
      statusResult.rawStatusText === "pending" ||
      statusResult.rawStatusText === "success" ||
      statusResult.rawStatusText === "rejected"
    ) {
      const lastStatus = op.brickkenStatusEvidence.at(-1);
      if (
        lastStatus &&
        lastStatus.status === statusResult.rawStatusText &&
        op.brickkenStatus === statusResult.rawStatusText
      ) {
        return { statusResult, durableEvidence, run: current };
      }

      const nextRun = recordBrickkenStatusEvidenceV4({
        run: current,
        kind,
        evidence: {
          evidenceVersion: "1.0",
          observedAt,
          txId: active.txId,
          txHash: op.blockchainTxHash,
          status: statusResult.rawStatusText,
        },
        id: this.#deps.ids.eventId(),
      });
      const updated = (await this.#deps.repository.update(
        runId,
        expectedRevision,
        nextRun,
      )) as ExecutionRunV4;
      return { statusResult, durableEvidence, run: updated };
    }

    return { statusResult, durableEvidence, run: current };
  }

  async trackExecution(
    runId: string,
    expectedRevision: number,
  ): Promise<TrackExecutionResult> {
    let current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    const { operation: initialOp } = deriveActiveOperation(current);
    if (initialOp.blockchainTxHash === null) {
      throw new IllegalStateTransitionError();
    }

    let rpcEvaluation: TransactionComparisonEvaluation | undefined;
    let receiptEvaluation: ReceiptFinalityEvaluation | undefined;
    let correlationResult: OrchestrationCorrelationResult | undefined;
    let statusResult: BrickkenTransactionStatusResult | undefined;

    // 1. Onchain Transaction Verification
    if (initialOp.stage === "BROADCAST_HASH_PERSISTED") {
      const verifyRes = await this.verifyOnchainTransaction(runId, current.revision);
      current = verifyRes.run;
      rpcEvaluation = verifyRes.evaluation;
    }

    let currentOp = deriveActiveOperation(current).operation;

    // If transaction was not found on chain or is not yet observed, cannot evaluate receipt or correlation yet
    if (
      rpcEvaluation &&
      (rpcEvaluation.presence === "NOT_FOUND" ||
        rpcEvaluation.observedTransaction === null ||
        rpcEvaluation.evidence === null)
    ) {
      return { run: current, rpcEvaluation };
    }

    // 2. Receipt & Finality Evaluation
    if (
      [
        "RPC_TRANSACTION_VERIFIED",
        "POLICY_VIOLATION_ONCHAIN",
        "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
        "BRICKKEN_CORRELATION_PENDING",
        "BRICKKEN_CORRELATED",
      ].includes(currentOp.stage) &&
      currentOp.blockchainTxHash !== null &&
      currentOp.rpcTransactionEvidence !== null
    ) {
      const receiptRes = await this.evaluateAndRecordReceiptFinality(
        runId,
        current.revision,
      );
      current = receiptRes.run;
      receiptEvaluation = receiptRes.evaluation;
      currentOp = deriveActiveOperation(current).operation;
    }

    // 3. Brickken Correlation
    if (
      [
        "RPC_TRANSACTION_VERIFIED",
        "POLICY_VIOLATION_ONCHAIN",
        "BRICKKEN_CORRELATION_PENDING",
      ].includes(currentOp.stage) &&
      current.status !== "FAILED" &&
      currentOp.transactionReceiptEvidence?.executionStatus !== "REVERTED" &&
      currentOp.rpcTransactionEvidence?.immutableIdentityStatus === "MATCH"
    ) {
      const corrRes = await this.correlateWithBrickken(runId, current.revision);
      current = corrRes.run;
      correlationResult = corrRes.result;
      currentOp = deriveActiveOperation(current).operation;
    }

    // 4. Brickken Status
    if (currentOp.stage === "BRICKKEN_CORRELATED") {
      try {
        const statusRes = await this.checkBrickkenStatus(runId, current.revision);
        current = statusRes.run;
        statusResult = statusRes.statusResult;
        currentOp = deriveActiveOperation(current).operation;
      } catch (error) {
        // Status text and availability are non-authoritative diagnostics. An
        // identity contradiction still persists reconciliation inside
        // checkBrickkenStatus; only adapter transport/shape failures are ignored
        // here so they cannot veto independently authoritative RPC + read-back.
        if (!(error instanceof BrickkenAdapterError)) throw error;
      }
    }

    // 5. Authoritative server-owned read-back. Brickken status is structural
    // evidence only; it cannot create token identity without the independent
    // finalized receipt, immutable transaction match, fee compliance, and
    // exact durable correlation gates enforced by the transition below.
    if (
      this.#readBack !== undefined &&
      current.phase === "TOKENIZATION" &&
      current.status !== "RECONCILIATION_REQUIRED" &&
      currentOp.stage === "BRICKKEN_CORRELATED" &&
      currentOp.transactionReceiptEvidence?.executionStatus === "SUCCESS" &&
      currentOp.transactionReceiptEvidence.finalityStatus === "FINALIZED" &&
      currentOp.rpcTransactionEvidence?.immutableIdentityStatus === "MATCH" &&
      currentOp.rpcTransactionEvidence.feeAuthorizationStatus === "WITHIN_ENVELOPE"
    ) {
      current = await this.recordTokenIdentityFromReadBack(
        runId,
        current.revision,
      );
    }

    return {
      run: current,
      rpcEvaluation,
      receiptEvaluation,
      correlationResult,
      statusResult,
    };
  }

  async recordTokenIdentityFromReadBack(
    runId: string,
    expectedRevision: number,
    untrustedCallerIdentity?: unknown,
  ): Promise<ExecutionRunV4> {
    // No caller-controlled token identity is accepted at this trust boundary.
    if (untrustedCallerIdentity !== undefined || this.#readBack === undefined) {
      throw new OrchestrationError("READ_BACK_FAILED");
    }

    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);
    if (current.phase !== "TOKENIZATION") {
      throw new IllegalStateTransitionError();
    }

    const operation = current.operations[0];
    const activeAttempt = operation.activePreparationAttemptId === null
      ? undefined
      : operation.preparationAttempts.find(
        (attempt) => attempt.attemptId === operation.activePreparationAttemptId,
      );
    if (
      operation.stage !== "BRICKKEN_CORRELATED" ||
      operation.brickkenCorrelation?.lifecycle !== "CORRELATED" ||
      activeAttempt?.txId === null ||
      activeAttempt?.txId === undefined ||
      operation.brickkenCorrelation.pair.txId !== activeAttempt.txId ||
      operation.blockchainTxHash === null ||
      operation.brickkenCorrelation.pair.txHash !== operation.blockchainTxHash ||
      operation.transactionReceiptEvidence?.executionStatus !== "SUCCESS" ||
      operation.transactionReceiptEvidence.finalityStatus !== "FINALIZED" ||
      operation.transactionReceiptEvidence.identityStatus !== "MATCH" ||
      operation.transactionReceiptEvidence.reconciliationStatus !== "CLEAR" ||
      operation.transactionReceiptEvidence.transactionHash !== operation.blockchainTxHash ||
      operation.rpcTransactionEvidence?.immutableIdentityStatus !== "MATCH" ||
      operation.rpcTransactionEvidence.feeAuthorizationStatus !== "WITHIN_ENVELOPE" ||
      operation.rpcTransactionEvidence.transactionHash !== operation.blockchainTxHash ||
      current.status === "RECONCILIATION_REQUIRED"
    ) {
      throw new IllegalStateTransitionError();
    }

    let receiptEvaluation: ReceiptFinalityEvaluation;
    try {
      receiptEvaluation = await evaluateReceiptAndFinality({
        client: this.#deps.rpc,
        txHash: operation.blockchainTxHash,
        expectedFrom: operation.rpcTransactionEvidence.immutableIdentity.from,
        expectedTo: operation.rpcTransactionEvidence.immutableIdentity.to,
        expectedType: "0x2",
        gasLimit: activeAttempt.feeAuthorization?.authorizedCaps.gasLimit,
        observedAt: this.#deps.clock.nowIso(),
      });
    } catch {
      throw new OrchestrationError("READ_BACK_FAILED");
    }
    const receipt = receiptEvaluation.receipt;
    const observedReceiptEvidence = receiptEvaluation.evidence;
    const durableReceiptEvidence = operation.transactionReceiptEvidence;
    if (
      receiptEvaluation.receiptStatus !== "SUCCESS" ||
      receiptEvaluation.canonicality !== "CANONICAL" ||
      receiptEvaluation.finality !== "FINALIZED" ||
      receiptEvaluation.reconciliationRequired ||
      receipt === null ||
      observedReceiptEvidence === null ||
      observedReceiptEvidence.transactionHash !== durableReceiptEvidence.transactionHash ||
      observedReceiptEvidence.blockHash !== durableReceiptEvidence.blockHash ||
      observedReceiptEvidence.blockNumber !== durableReceiptEvidence.blockNumber ||
      observedReceiptEvidence.transactionIndex !== durableReceiptEvidence.transactionIndex
    ) {
      throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
    }

    let implementationAddress: string | null;
    try {
      const implementationSlot = await this.#deps.rpc.getStorageAt(
        REVIEWED_SEPOLIA_FACTORY,
        ERC1967_IMPLEMENTATION_SLOT,
        receipt.blockNumber,
      );
      implementationAddress = implementationAddressFromErc1967Slot(implementationSlot);
    } catch {
      throw new OrchestrationError("READ_BACK_FAILED");
    }
    if (implementationAddress !== REVIEWED_SEPOLIA_IMPLEMENTATION) {
      throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
    }

    let eventEvidence: TokenizationEventEvidenceV1;
    try {
      eventEvidence = deriveTokenizationEventEvidence({
        receipt,
        expectedTransactionHash: operation.blockchainTxHash,
        implementationAddress,
      });
    } catch (error) {
      if (error instanceof TokenizeReceiptBindingError) {
        throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
      }
      throw error;
    }

    const tokenSymbol = current.manifest.asset.symbol;
    const [tokenResult, tokenizerResult] = await Promise.all([
      this.#readBack.getTokenInfo({ tokenSymbol }),
      this.#readBack.getTokenizerInfo({ tokenSymbol }),
    ]);
    if (!tokenResult.ok || !tokenizerResult.ok) {
      throw new OrchestrationError("READ_BACK_FAILED");
    }

    const token = tokenResult.value;
    const tokenizer = tokenizerResult.value;
    const expectedWallet = current.requiredSigner.walletAddress.toLowerCase();
    const observedWallet = tokenizer.companyWalletAddress.toLowerCase();
    const tokenWallet = token.companyWalletAddress?.toLowerCase() ?? null;
    if (
      token.tokenSymbol !== tokenSymbol ||
      tokenizer.chainId !== current.chainId ||
      tokenizer.tokenAddress.toLowerCase() !== eventEvidence.tokenAddress ||
      observedWallet !== expectedWallet ||
      tokenizer.email?.toLowerCase() !== current.manifest.tokenizer.email ||
      (tokenWallet !== null && tokenWallet !== expectedWallet) ||
      (token.tokenizerEmail !== null &&
        token.tokenizerEmail.toLowerCase() !== current.manifest.tokenizer.email) ||
      (token.name !== null && token.name !== current.manifest.asset.name) ||
      (token.tokenName !== null && token.tokenName !== current.manifest.asset.name) ||
      (token.tokenType !== null && token.tokenType !== current.manifest.asset.tokenType) ||
      (token.maxTokenSupply !== null &&
        token.maxTokenSupply !== current.manifest.asset.supplyCap) ||
      (token.paymentChainId !== null && token.paymentChainId !== current.chainId) ||
      !/^0x[0-9a-fA-F]{40}$/.test(tokenizer.tokenAddress) ||
      tokenizer.tokenAddress.toLowerCase() ===
        "0x0000000000000000000000000000000000000000"
    ) {
      throw new OrchestrationError("READ_BACK_FAILED");
    }

    const verifiedAt = this.#deps.clock.nowIso();
    const readBackEvidenceHash = (await hashCanonicalJson({
      domain: "edict.token-identity-read-back.v1",
      eventEvidence,
      secondaryBrickkenConfirmation: {
        token,
        tokenizer,
      },
    })).hash;
    const nextRun = recordTokenIdentityFromReadBackV4({
      run: current,
      eventEvidence,
      readBack: {
        chainId: current.chainId,
        tokenAddress: eventEvidence.tokenAddress,
        tokenSymbol,
        tokenizerWalletAddress: expectedWallet,
        tokenizationTxHash: operation.blockchainTxHash,
        manifestHash: current.manifestHash,
        planHash: current.planHash,
        verifiedAt,
        readBackEvidenceHash,
      },
      id: this.#deps.ids.eventId(),
    });
    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }
}
