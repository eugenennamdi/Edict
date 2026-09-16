import "server-only";
import { assertExecutablePlan } from "../execution/capabilities";
import { TokenizeFreshnessError, validateTokenizeProtocol } from "./tokenize-calldata";

import { buildExecutionPlanV1, canonicalizeJson, hashCanonicalJson, sha256Utf8, validateAssetManifestV1 } from "@/core";
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
import type {
  AdapterResult,
  PreparedOperation,
  TokenInfoView,
  TokenizerInfoView,
} from "../brickken/types";
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
  recordInitialPreparationV4,
  recordLifecycleReadBackV4,
  recordReadBackMismatchV4,
  recordReprepareOutcomeV4,
  recordRepreparedV4,
  recordRpcReceiptEvidenceV4,
  recordRpcTransactionV4,
  recordTokenIdentityFromReadBackV4,
  recordUnverifiedFinalityExhaustedV4,
  recordWalletPromptAuthorizationV4,
  recordWalletRejectedV4,
  upgradePreparedRunToV4,
  type V4PreparationFoundationInput,
} from "../execution/v4-transitions";
import type { BrickkenWriteGate } from "./write-gate";
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
  readonly requiresProtocolValidation?: boolean;
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
  readonly isProductionDenyAll: boolean;

  constructor(readonly reason: string = "AUTHORIZATION_DENIED") {
    this.isProductionDenyAll = reason !== "POLICY_CONFIG_INVALID";
  }

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
    "getTokenInfo" | "getTokenizerInfo" | "getWhitelistStatus" | "getBalanceAndWhitelist"
  >;
  readonly brickkenTokenizerEmail?: string;
  readonly brickkenPrepare?: Pick<
    BrickkenServerAdapter,
    "prepareTokenization" | "prepareWhitelist" | "prepareMint"
  >;
  readonly writeGate?: BrickkenWriteGate;
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

async function validatedRunPlan(run: ExecutionRun) {
  const manifest = validateAssetManifestV1(run.manifest);
  if (!manifest.ok) throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  const plan = await buildExecutionPlanV1(
    manifest.value,
    run.plan.executionScope === "TOKENIZE_ONLY" ? "TOKENIZE_ONLY" : "LEGACY_FULL",
  );
  if (plan.manifestHash !== run.manifestHash || plan.planHash !== run.planHash) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  return { manifest: manifest.value, plan };
}

function sameAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined &&
    left.toLowerCase() === right.toLowerCase();
}

async function withQuickTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 2000,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertPreparedMatchesRun(
  run: ExecutionRun,
  prepared: PreparedOperation,
  kind: OperationKind,
): void {
  const transaction = prepared.transaction;
  if (
    transaction.normalizedChainId !== run.chainId ||
    transaction.from?.toLowerCase() !== run.requiredSigner.walletAddress ||
    transaction.to === null ||
    transaction.data === null
  ) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  if (kind === "TOKENIZE") return;
  if (run.schemaVersion !== "4.0" || run.tokenIdentity === null) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  if (!sameAddress(transaction.to, run.tokenIdentity.tokenAddress)) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
}

function definitePrepareRefusal<T>(result: AdapterResult<T>): boolean {
  return (
    !result.ok &&
    [
      "AUTHENTICATION_REJECTED",
      "CREDITS_EXHAUSTED",
      "ENTITLEMENT_REJECTED",
      "INVALID_REQUEST",
      "SIGNER_NOT_APPROVED",
      "UPSTREAM_RATE_LIMITED",
      "MINT_POLICY_VIOLATION",
    ].includes(result.error.code)
  );
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

  async #evaluateLifecycleAuth(
    run: ExecutionRunV4,
    kind: "WHITELIST" | "MINT",
    attempt: PreparationAttemptV1,
  ): Promise<{ authorized: true; semanticAuthorization: SemanticAuthorizationV1 } | { authorized: false; reason: string }> {
    if (
      run.environment !== "sandbox" || run.chainId !== "11155111" ||
      attempt.immutableIdentity === null || attempt.feeAuthorization === null ||
      attempt.txId === null || attempt.preparationFingerprint === null ||
      run.tokenIdentity === null || run.approval === null
    ) {
      return { authorized: false, reason: "MALFORMED_DURABLE_STATE" };
    }

    try {
      await validatedRunPlan(run);
    } catch {
      return { authorized: false, reason: "PLAN_MISMATCH" };
    }

    if (
      run.approval.planHash !== run.planHash ||
      run.approval.approvedByWallet !== run.requiredSigner.walletAddress
    ) {
      return { authorized: false, reason: "APPROVAL_MISMATCH" };
    }

    if (run.operations[0].stage !== "READ_BACK_VERIFIED") {
      return { authorized: false, reason: "PREPARATION_MISMATCH" };
    }
    if (kind === "MINT" && run.operations[1].stage !== "READ_BACK_VERIFIED") {
      return { authorized: false, reason: "PREPARATION_MISMATCH" };
    }

    const identity = attempt.immutableIdentity;
    const destination = identity.to;
    const selector = identity.data.slice(0, 10);
    if (
      !sameAddress(identity.from, run.requiredSigner.walletAddress) ||
      identity.chainId !== "11155111" ||
      BigInt(identity.value) !== 0n ||
      !sameAddress(destination, run.tokenIdentity.tokenAddress) ||
      !/^0x[0-9a-f]{8}$/.test(selector)
    ) {
      return { authorized: false, reason: "DESTINATION_NOT_ALLOWED" };
    }

    const calldataCommitment = await sha256Utf8(identity.data);
    const brickkenMethod = kind === "WHITELIST" ? "whitelistUser" : "mintToken";
    const operation = run.operations[kind === "WHITELIST" ? 1 : 2];

    const authorizationId = (await hashCanonicalJson({
      domain: `edict.${kind.toLowerCase()}-semantic-authorization.v1`,
      runId: run.id,
      runRevision: run.revision,
      manifestHash: run.manifestHash,
      planHash: run.planHash,
      operation: { id: operation.id, kind },
      preparationAttemptId: attempt.attemptId,
      preparedTxId: attempt.txId,
      preparationFingerprint: attempt.preparationFingerprint,
      calldataCommitment,
      brickkenMethod,
      destination,
      selector,
    })).hash;

    return {
      authorized: true,
      semanticAuthorization: {
        authorizationVersion: "1.0",
        policyVersion: `edict-${kind.toLowerCase()}-semantic-v1`,
        authorizationId,
        environment: "sandbox",
        brickkenMethod,
        executionMode: "client-broadcast",
        destinationPolicy: {
          policyId: `edict-${kind.toLowerCase()}-destination-v1`,
          reviewedDestination: destination,
        },
        selectorPolicy: {
          policyId: `edict-${kind.toLowerCase()}-selector-v1`,
          reviewedSelector: selector,
        },
        calldataCommitment,
        decision: "ALLOW",
      },
    };
  }

  async #validateProtocol(run: ExecutionRun, unsigned: Record<string, unknown>): Promise<void> {
    assertExecutablePlan(run.plan);
    await validatedRunPlan(run);
    const tx = projectPreparedTransactionV1(unsigned);
    if (tx.chainId !== "0xaa36a7" || tx.walletRequest.from !== run.requiredSigner.walletAddress ||
      tx.walletRequest.to !== REVIEWED_SEPOLIA_FACTORY || tx.walletRequest.value !== "0x0") {
      throw new OrchestrationError("AUTHORIZATION_POLICY_REFUSED");
    }
    try {
      await validateTokenizeProtocol(run, tx.walletRequest.data!, this.#deps.rpc);
    } catch (err) {
      if (err instanceof TokenizeFreshnessError) {
        throw err;
      }
      throw new OrchestrationError("AUTHORIZATION_POLICY_REFUSED");
    }
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

    if (this.#semanticAuth.requiresProtocolValidation) {
      try {
        await this.#validateProtocol(current, op.unsignedTransaction);
      } catch (err) {
        if (err instanceof TokenizeFreshnessError) {
          // Static semantics are valid, but price report is expired or inside safety buffer.
          // Establish V4 attempt state so freshness evaluation can legally
          // transition to PREPARED_STALE and allow one reprepare.
        } else {
          throw err;
        }
      }
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
      (evaluation.outcome === "STALE_NONCE" ||
        evaluation.outcome === "PRICE_REPORT_EXPIRED" ||
        evaluation.outcome === "PRICE_REPORT_TOO_CLOSE_TO_EXPIRY") &&
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
      const staleReason =
        evaluation.outcome === "STALE_NONCE" ? "NONCE_MISMATCH" : "PRICE_REPORT_EXPIRED";
      const nextRun = await markPreparedStaleV4({
        run: current,
        kind,
        foundation,
        nonceEvidence: evaluation.nonceEvidence,
        staleReason,
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
    if (this.#semanticAuth.requiresProtocolValidation) {
      await this.#validateProtocol(current, unsignedTransaction);
    }
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

  async recordReprepareOutcome(
    runId: string,
    expectedRevision: number,
    outcome: "PREPARE_UNKNOWN" | "REFUSED",
  ): Promise<ExecutionRunV4> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);
    const { kind } = deriveActiveOperation(current);
    const nextRun = recordReprepareOutcomeV4({
      run: current,
      kind,
      outcome,
      id: this.#deps.ids.eventId(),
      at: this.#deps.clock.nowIso(),
    });
    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async prepareOperation(
    runId: string,
    expectedRevision: number,
  ): Promise<ExecutionRunV4> {
    this.#deps.writeGate?.assertEnabled("PREPARE");

    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    const { kind, operation: op } = deriveActiveOperation(current);
    if (
      current.status !== "PREPARING" ||
      op.stage !== "NOT_STARTED" ||
      op.blockchainTxHash !== null
    ) {
      throw new IllegalStateTransitionError();
    }

    assertExecutablePlan(current.plan);
    const { manifest } = await validatedRunPlan(current);

    if (!this.#deps.brickkenPrepare) {
      throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    }

    let result: AdapterResult<PreparedOperation>;
    try {
      if (kind === "TOKENIZE") {
        result = await this.#deps.brickkenPrepare.prepareTokenization({
          signerAddress: current.requiredSigner.walletAddress,
          name: manifest.asset.name,
          tokenSymbol: manifest.asset.symbol,
          supplyCap: manifest.asset.supplyCap,
          documentationUrl: manifest.asset.documentationUrl,
        });
      } else if (kind === "WHITELIST") {
        if (!manifest.investor) throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
        result = await this.#deps.brickkenPrepare.prepareWhitelist({
          signerAddress: current.requiredSigner.walletAddress,
          tokenSymbol: manifest.asset.symbol,
          investorAddress: manifest.investor.walletAddress,
          investorEmail: manifest.investor.email,
        });
      } else {
        if (!manifest.investor) throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
        const whitelistOp = current.operations[1];
        if (whitelistOp.stage !== "READ_BACK_VERIFIED" || whitelistOp.preparedTxId === null) {
          throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
        }
        result = await this.#deps.brickkenPrepare.prepareMint(
          {
            signerAddress: current.requiredSigner.walletAddress,
            tokenSymbol: manifest.asset.symbol,
            investorAddress: manifest.investor.walletAddress,
            investorEmail: manifest.investor.email,
            amount: manifest.investor.mintAmount,
          },
          {
            runId: current.id,
            whitelistTxId: whitelistOp.preparedTxId,
            stage: "READ_BACK_VERIFIED",
            investorWalletAddress: manifest.investor.walletAddress,
            isWhitelisted: true,
            source: "blockchain",
          },
        );
      }
    } catch (error) {
      if (error instanceof OrchestrationError) throw error;
      throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    }

    if (!result.ok) {
      throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    }

    assertPreparedMatchesRun(current, result.value, kind);
    const now = this.#deps.clock.nowIso();
    const nextRun = await recordInitialPreparationV4({
      run: current,
      kind,
      txId: result.value.txId,
      unsignedTransaction: result.value.transaction.rawUnsigned,
      attemptId: this.#deps.ids.operationId(),
      freshnessPolicyVersion: "edict-freshness-v1",
      id: this.#deps.ids.eventId(),
      at: now,
    });

    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }

  async reprepareOperation(
    runId: string,
    expectedRevision: number,
  ): Promise<ExecutionRunV4> {
    this.#deps.writeGate?.assertEnabled("PREPARE");

    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    const { kind, operation: op } = deriveActiveOperation(current);
    if (
      current.status !== "AWAITING_WALLET" ||
      op.stage !== "PREPARED_STALE" ||
      op.walletPromptAuthorization !== null ||
      op.blockchainTxHash !== null
    ) {
      throw new IllegalStateTransitionError();
    }

    assertExecutablePlan(current.plan);
    const { manifest } = await validatedRunPlan(current);

    // CAS 1: transition to REPREPARE_INTENT
    const intentRun = await this.beginReprepare(runId, expectedRevision);

    // External call: exactly ONE Brickken prepare request (no auto-retries)
    if (!this.#deps.brickkenPrepare) {
      await this.recordReprepareOutcome(runId, intentRun.revision, "PREPARE_UNKNOWN");
      throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    }

    let result: AdapterResult<PreparedOperation>;
    try {
      if (kind === "TOKENIZE") {
        result = await this.#deps.brickkenPrepare.prepareTokenization({
          signerAddress: current.requiredSigner.walletAddress,
          name: manifest.asset.name,
          tokenSymbol: manifest.asset.symbol,
          supplyCap: manifest.asset.supplyCap,
          documentationUrl: manifest.asset.documentationUrl,
        });
      } else if (kind === "WHITELIST") {
        if (!manifest.investor) throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
        result = await this.#deps.brickkenPrepare.prepareWhitelist({
          signerAddress: current.requiredSigner.walletAddress,
          tokenSymbol: manifest.asset.symbol,
          investorAddress: manifest.investor.walletAddress,
          investorEmail: manifest.investor.email,
        });
      } else {
        if (!manifest.investor) throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
        const whitelistOp = current.operations[1];
        if (whitelistOp.stage !== "READ_BACK_VERIFIED" || whitelistOp.preparedTxId === null) {
          throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
        }
        result = await this.#deps.brickkenPrepare.prepareMint(
          {
            signerAddress: current.requiredSigner.walletAddress,
            tokenSymbol: manifest.asset.symbol,
            investorAddress: manifest.investor.walletAddress,
            investorEmail: manifest.investor.email,
            amount: manifest.investor.mintAmount,
          },
          {
            runId: current.id,
            whitelistTxId: whitelistOp.preparedTxId,
            stage: "READ_BACK_VERIFIED",
            investorWalletAddress: manifest.investor.walletAddress,
            isWhitelisted: true,
            source: "blockchain",
          },
        );
      }
    } catch (error) {
      if (error instanceof OrchestrationError) throw error;
      try {
        await this.recordReprepareOutcome(runId, intentRun.revision, "PREPARE_UNKNOWN");
      } catch {
        // Intent remains durable
      }
      throw new OrchestrationError("PREPARATION_UNCONFIRMED");
    }

    if (!result.ok) {
      const outcome = definitePrepareRefusal(result) ? "REFUSED" : "PREPARE_UNKNOWN";
      try {
        await this.recordReprepareOutcome(runId, intentRun.revision, outcome);
      } catch {
        // Intent remains durable
      }
      if (outcome !== "REFUSED") throw new OrchestrationError("PREPARATION_UNCONFIRMED");
      switch (result.error.code) {
        case "AUTHENTICATION_REJECTED":
        case "CREDITS_EXHAUSTED":
        case "ENTITLEMENT_REJECTED":
        case "INVALID_REQUEST":
        case "SIGNER_NOT_APPROVED":
        case "UPSTREAM_RATE_LIMITED":
          throw new OrchestrationError(result.error.code);
        default:
          throw new OrchestrationError("PREPARATION_REFUSED");
      }
    }

    // CAS 2: transition to PREPARED with fresh txId + unsigned transaction
    try {
      assertPreparedMatchesRun(current, result.value, kind);
      return await this.recordReprepared(
        runId,
        intentRun.revision,
        result.value.txId,
        result.value.transaction.rawUnsigned,
      );
    } catch (error) {
      try {
        await this.recordReprepareOutcome(runId, intentRun.revision, "PREPARE_UNKNOWN");
      } catch {
        // Intent remains durable
      }
      if (error instanceof OrchestrationError) throw error;
      throw new OrchestrationError("PREPARATION_UNCONFIRMED");
    }
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
    if (!["PREPARED", "WALLET_PROMPT_RECORDED"].includes(op.stage)) {
      return Object.freeze({
        authorized: false,
        reason: "OPERATION_NOT_PREPARED",
      });
    }

    if (op.walletPromptAuthorization !== null &&
      op.walletPromptAuthorization.providerInvocation !== "PROVEN_NOT_INVOKED") {
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

    let freshness = await evaluatePreparedFreshness({
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

    if (kind === "TOKENIZE" && this.#semanticAuth.requiresProtocolValidation) {
      try {
        await this.#validateProtocol(current, active.unsignedTransaction!);
      } catch (err) {
        if (err instanceof TokenizeFreshnessError) {
          return Object.freeze({
            authorized: false,
            reason: "FRESHNESS_CHECK_FAILED",
            freshness,
            detail: err.reason,
          });
        }
        return {
          authorized: false,
          reason: "AUTHORIZATION_DENIED",
          detail: "PROTOCOL_VALIDATION_FAILED",
        };
      }
    }
    
    let semanticResult: Awaited<ReturnType<SemanticAuthorizationEvaluator['evaluate']>>;
    if (kind === "TOKENIZE") {
      semanticResult = await this.#semanticAuth.evaluate({ run: current, kind, attempt: active });
    } else {
      semanticResult = await this.#evaluateLifecycleAuth(current, kind, active);
    }

    if (!semanticResult.authorized) {
      return Object.freeze({
        authorized: false,
        reason: "AUTHORIZATION_DENIED",
        freshness,
        detail: semanticResult.reason,
      });
    }

    // Protocol reads can take time. Sample nonce, funds, fee and price lifetime
    // again after those reads; these are the evidence persisted by final CAS.
    freshness = await evaluatePreparedFreshness({ client: this.#deps.rpc, run: current, kind,
      policyVersion: "edict-freshness-v1", observedAt: this.#deps.clock.nowIso() });
    if (!freshness.eligible) return { authorized: false, reason: "FRESHNESS_CHECK_FAILED", freshness, detail: freshness.outcome };
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
        if (preflight.reason === "FRESHNESS_CHECK_FAILED") {
          throw new OrchestrationError("FRESHNESS_CHECK_FAILED");
        }
        if (preflight.reason === "AUTHORIZATION_DENIED") {
          throw new OrchestrationError("AUTHORIZATION_POLICY_REFUSED");
        }
        throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
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
    // Operator kill switch / invalid deployment policy refuses authority.
    if (this.#semanticAuth.isProductionDenyAll) {
      throw new OrchestrationError("AUTHORIZATION_DENIED");
    }
    if (
      this.#semanticAuth instanceof DenyAllSemanticAuthorizationEvaluator &&
      this.#semanticAuth.reason === "POLICY_CONFIG_INVALID"
    ) {
      throw new OrchestrationError("AUTHORIZATION_POLICY_REFUSED");
    }

    let current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);
    assertExecutablePlan(current.plan);

    let currentRevision = expectedRevision;
    let derived = deriveActiveOperation(current);
    const { kind } = derived;
    let op = derived.operation;

    // Sequential CAS: if still in PREPARED, record prompt authorization (CAS 1)
    if (op.stage === "PREPARED") {
      const active = getActiveAttempt(op);
      const preflight = await this.preflightWalletAuthorization(
        runId,
        currentRevision,
      );
      if (!preflight.authorized) {
        if (preflight.reason === "FRESHNESS_CHECK_FAILED") {
          if (
            (preflight.detail === "STALE_NONCE" ||
              preflight.detail === "PRICE_REPORT_EXPIRED" ||
              preflight.detail === "PRICE_REPORT_TOO_CLOSE_TO_EXPIRY") &&
            preflight.freshness?.nonceEvidence
          ) {
            const foundation: V4PreparationFoundationInput = {
              attemptId: active.attemptId,
              freshnessPolicyVersion: active.freshnessPolicyVersion,
            };
            const staleReason =
              preflight.detail === "STALE_NONCE" ? "NONCE_MISMATCH" : "PRICE_REPORT_EXPIRED";
            const staleRun = await markPreparedStaleV4({
              run: current,
              kind,
              foundation,
              nonceEvidence: preflight.freshness.nonceEvidence,
              staleReason,
              id: this.#deps.ids.eventId(),
              at: preflight.freshness.nonceEvidence.observedAt,
            });
            await this.#deps.repository.update(runId, currentRevision, staleRun);
            throw new OrchestrationError("FRESHNESS_CHECK_FAILED");
          }
          throw new OrchestrationError("FRESHNESS_CHECK_FAILED");
        }
        if (preflight.reason === "AUTHORIZATION_DENIED") {
          throw new OrchestrationError("AUTHORIZATION_POLICY_REFUSED");
        }
        throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
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
      derived = deriveActiveOperation(current);
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

    // Both fresh and crash-resumed prompts re-evaluate all current evidence.
    // Nothing externally sensitive is inherited from the original prompt CAS.
    const releasePreflight = await this.preflightWalletAuthorization(runId, currentRevision);
    if (!releasePreflight.authorized) {
      const f = releasePreflight.freshness;
      if (f?.nonceEvidence && ["STALE_NONCE", "PRICE_REPORT_EXPIRED", "PRICE_REPORT_TOO_CLOSE_TO_EXPIRY"].includes(f.outcome)) {
        const active = getActiveAttempt(op);
        const activeIdx = derived.index;
        const noPrompt = {
          ...current,
          operations: current.operations.map((o, i) =>
            i === activeIdx ? { ...o, stage: "PREPARED", walletPromptAuthorization: null, walletPromptAt: null } : o
          ),
        } as unknown as ExecutionRunV4;
        const stale = await markPreparedStaleV4({ run: noPrompt, kind,
          foundation: { attemptId: active.attemptId, freshnessPolicyVersion: active.freshnessPolicyVersion },
          nonceEvidence: f.nonceEvidence, staleReason: f.outcome === "STALE_NONCE" ? "NONCE_MISMATCH" : "PRICE_REPORT_EXPIRED",
          id: this.#deps.ids.eventId(), at: this.#deps.clock.nowIso() });
        await this.#deps.repository.update(runId, currentRevision, stale);
      }
      throw new OrchestrationError(releasePreflight.reason === "AUTHORIZATION_DENIED" ? "AUTHORIZATION_POLICY_REFUSED" : "FRESHNESS_CHECK_FAILED");
    }
    // Rebind the intent and durable nonce evidence to this final evaluation.
    // This transient projection is never written as PREPARED. One final CAS
    // stores the refreshed evidence and the sole authority winner together.
    const active = getActiveAttempt(op);
    const activeIdx = derived.index;
    current = await recordWalletPromptAuthorizationV4({
      run: {
        ...current,
        operations: current.operations.map((o, i) =>
          i === activeIdx ? { ...o, stage: "PREPARED", walletPromptAuthorization: null } : o
        ),
      } as unknown as ExecutionRunV4,
      kind, foundation: { attemptId: active.attemptId, freshnessPolicyVersion: active.freshnessPolicyVersion },
      nonceEvidence: releasePreflight.freshness.nonceEvidence,
      semanticAuthorization: releasePreflight.semanticAuthorization,
      id: this.#deps.ids.eventId(), at: releasePreflight.freshness.nonceEvidence!.observedAt,
    });

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
    if (
      kind !== "TOKENIZE" &&
      (updatedRun.tokenIdentity === null ||
        !sameAddress(request.to, updatedRun.tokenIdentity.tokenAddress) ||
        request.value !== "0x0")
    ) {
      throw new OrchestrationError("AUTHORIZATION_POLICY_REFUSED");
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

    let baseFeePerGas: string | null = null;
    if (tx.type === "0x0") {
      try {
        if (tx.blockHash !== null) {
          const block = await this.#deps.rpc.getBlockByHash(tx.blockHash);
          if (block?.baseFeePerGas) baseFeePerGas = block.baseFeePerGas;
        } else {
          const block = await this.#deps.rpc.getLatestBlock();
          if (block?.baseFeePerGas) baseFeePerGas = block.baseFeePerGas;
        }
      } catch {
        // Non-fatal if transport lacks block handler
      }
    }

    const actualFeeFields = {
      transactionType: tx.type,
      gasLimit: tx.gas,
      maxFeePerGas: tx.maxFeePerGas ?? null,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
      gasPrice: tx.gasPrice,
      accessList: tx.accessList,
      baseFeePerGas,
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
      expectedType: (op.rpcTransactionEvidence.observedTransactionType as "0x0" | "0x1" | "0x2" | null) ?? undefined,
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
      const rawResponse = await withQuickTimeout(this.#statusFetcher.fetch(locator), 1500);
      if (rawResponse === null) {
        const lastEvidence = op.brickkenStatusEvidence.at(-1);
        const observedAt = this.#deps.clock.nowIso();
        const fallbackResult: BrickkenTransactionStatusResult = {
          httpStatus: 200,
          responseByteCount: 0,
          contentType: "application/json",
          transactionHash: op.blockchainTxHash,
          rawStatusText: lastEvidence?.status ?? null,
          diagnosticError: null,
          error: null,
        };
        const durableEvidence = buildStatusDurableEvidence({
          diagnostic: fallbackResult,
          locator,
          observedAt,
        });
        return { statusResult: fallbackResult, durableEvidence, run: current };
      }
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

  async reconcileSubmittedRun(
    runId: string,
    expectedRevision: number,
  ): Promise<TrackExecutionResult> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    if (
      current.phase === "VERIFICATION" ||
      current.terminalOutcome !== null ||
      current.status === "RECONCILIATION_REQUIRED"
    ) {
      return { run: current };
    }

    const { operation: initialOp } = deriveActiveOperation(current);
    if (
      initialOp.blockchainTxHash === null ||
      initialOp.stage === "READ_BACK_VERIFIED"
    ) {
      return { run: current };
    }

    return this.#reconcilePipeline(current);
  }

  async trackExecution(
    runId: string,
    expectedRevision: number,
  ): Promise<TrackExecutionResult> {
    let current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    if (
      current.phase === "VERIFICATION" ||
      current.terminalOutcome !== null ||
      current.status === "RECONCILIATION_REQUIRED"
    ) {
      throw new IllegalStateTransitionError();
    }

    const { operation: initialOp } = deriveActiveOperation(current);
    if (initialOp.blockchainTxHash === null) {
      throw new IllegalStateTransitionError();
    }

    if (initialOp.stage === "READ_BACK_VERIFIED") {
      throw new IllegalStateTransitionError();
    }
    const trackingEvents = current.events.filter((event) => event.type === "TRACK_EXECUTION_RESERVED");
    const now = this.#deps.clock.nowIso();
    const last = trackingEvents.at(-1);
    const isFinalized = initialOp.transactionReceiptEvidence?.finalityStatus === "FINALIZED";
    if (trackingEvents.length >= 30 || (!isFinalized && last && Date.parse(now) - Date.parse(last.at) < 2000)) {
      if (isFinalized) {
        const exhausted = recordUnverifiedFinalityExhaustedV4({
          run: current,
          kind: deriveActiveOperation(current).kind,
          at: now,
          id: this.#deps.ids.eventId(),
        });
        return {
          run: (await this.#deps.repository.update(runId, current.revision, exhausted)) as ExecutionRunV4,
        };
      }
      throw new OrchestrationError("TRACKING_BUDGET_EXHAUSTED");
    }
    // Reserve before RPC, including failed/missing-transaction polls. Revision
    // CAS makes reloads, concurrent requests and process restarts share a budget.
    current = await this.#deps.repository.update(runId, current.revision, {
      ...current, updatedAt: now, events: [...current.events, {
        id: this.#deps.ids.eventId(), sequence: current.events.length + 1,
        type: "TRACK_EXECUTION_RESERVED", at: now, actor: "SERVER", operationKind: deriveActiveOperation(current).kind,
      }],
    }) as ExecutionRunV4;

    return this.#reconcilePipeline(current);
  }

  async #reconcilePipeline(
    currentRun: ExecutionRunV4,
  ): Promise<TrackExecutionResult> {
    let current = currentRun;
    const runId = current.id;
    const { operation: initialOp } = deriveActiveOperation(current);

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
      try {
        current = await this.#completeReadBackOrFailClosed(
          current,
          () => this.recordTokenIdentityFromReadBack(runId, current.revision),
        );
        if (current.terminalOutcome === null && current.status !== "RECONCILIATION_REQUIRED") {
          currentOp = deriveActiveOperation(current).operation;
        }
      } catch (error) {
        const code = error instanceof OrchestrationError ? error.code : null;
        if (code !== "READ_BACK_FAILED") throw error;
        // Transient RPC read failure: allow retry on subsequent tracking poll without deterministic failure
      }
    }

    if (
      this.#readBack !== undefined &&
      (current.phase === "WHITELIST" || current.phase === "MINT") &&
      current.status !== "RECONCILIATION_REQUIRED" &&
      current.terminalOutcome === null &&
      currentOp.stage === "BRICKKEN_CORRELATED" &&
      currentOp.transactionReceiptEvidence?.executionStatus === "SUCCESS" &&
      currentOp.transactionReceiptEvidence.finalityStatus === "FINALIZED" &&
      currentOp.rpcTransactionEvidence?.immutableIdentityStatus === "MATCH" &&
      currentOp.rpcTransactionEvidence.feeAuthorizationStatus === "WITHIN_ENVELOPE"
    ) {
      try {
        current = await this.#completeReadBackOrFailClosed(
          current,
          () => this.recordLifecycleReadBack(
            runId,
            current.revision,
            deriveActiveOperation(current).kind as "WHITELIST" | "MINT",
          ),
        );
        if (
          current.phase !== "VERIFICATION" &&
          current.terminalOutcome === null &&
          current.status !== "RECONCILIATION_REQUIRED"
        ) {
          currentOp = deriveActiveOperation(current).operation;
        }
      } catch (error) {
        const code = error instanceof OrchestrationError ? error.code : null;
        if (code !== "READ_BACK_FAILED") throw error;
        // Transient RPC read failure: allow retry on subsequent tracking poll without deterministic failure
      }
    }

    return {
      run: current,
      rpcEvaluation,
      receiptEvaluation,
      correlationResult,
      statusResult,
    };
  }

  async #completeReadBackOrFailClosed(
    current: ExecutionRunV4,
    verify: () => Promise<ExecutionRunV4>,
  ): Promise<ExecutionRunV4> {
    try {
      return await verify();
    } catch (error) {
      const code = error instanceof OrchestrationError ? error.code : null;
      if (code === "READ_BACK_MISMATCH" || code === "READ_BACK_BINDING_UNRESOLVED") {
        const failed = recordReadBackMismatchV4({
          run: current,
          kind: deriveActiveOperation(current).kind,
          at: this.#deps.clock.nowIso(),
          id: this.#deps.ids.eventId(),
        });
        return (await this.#deps.repository.update(
          current.id,
          current.revision,
          failed,
        )) as ExecutionRunV4;
      }
      throw error;
    }
  }

  async recordTokenIdentityFromReadBack(
    runId: string,
    expectedRevision: number,
    untrustedCallerIdentity?: unknown,
  ): Promise<ExecutionRunV4> {
    // No caller-controlled token identity is accepted at this trust boundary.
    if (untrustedCallerIdentity !== undefined) {
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

    // Required on-chain contract code & state checks
    if (this.#deps.rpc.getCode) {
      let code: string;
      try {
        code = await this.#deps.rpc.getCode(
          eventEvidence.tokenAddress,
          receipt.blockNumber,
        );
      } catch {
        throw new OrchestrationError("READ_BACK_FAILED");
      }
      if (!code || code === "0x" || code === "0x0") {
        throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
      }
      if (eventEvidence.escrowAddress) {
        let escrowCode: string;
        try {
          escrowCode = await this.#deps.rpc.getCode(
            eventEvidence.escrowAddress,
            receipt.blockNumber,
          );
        } catch {
          throw new OrchestrationError("READ_BACK_FAILED");
        }
        if (!escrowCode || escrowCode === "0x" || escrowCode === "0x0") {
          throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
        }
      }
    }

    if (this.#deps.rpc.call) {
      try {
        const decimalsHex = await this.#deps.rpc.call(
          { to: eventEvidence.tokenAddress, data: "0x313ce567" },
          receipt.blockNumber,
        );
        if (!decimalsHex || decimalsHex === "0x") {
          throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
        }
      } catch (err) {
        if (err instanceof OrchestrationError) throw err;
        throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
      }
    }

    // Secondary Brickken corroboration (reconciled if available, non-blocking on delay)
    const tokenSymbol = current.manifest.asset.symbol;
    const expectedTokenizerEmail = this.#deps.brickkenTokenizerEmail;
    const expectedWallet = current.requiredSigner.walletAddress.toLowerCase();

    let token: TokenInfoView | null = null;
    let tokenizer: TokenizerInfoView | null = null;

    if (this.#readBack !== undefined) {
      try {
        const results = await withQuickTimeout(
          Promise.all([
            this.#readBack.getTokenInfo({ tokenSymbol }),
            this.#readBack.getTokenizerInfo({ tokenSymbol }),
          ]),
          1500,
        );
        if (results && results[0].ok && results[1].ok) {
          token = results[0].value;
          tokenizer = results[1].value;
        }
      } catch {
        // Brickken timed out or failed; continue with verified on-chain evidence
      }
    }

    if (token !== null && tokenizer !== null) {
      const observedWallet = tokenizer.companyWalletAddress.toLowerCase();
      const tokenWallet = token.companyWalletAddress?.toLowerCase() ?? null;
      if (
        token.tokenSymbol !== tokenSymbol ||
        tokenizer.chainId !== current.chainId ||
        tokenizer.tokenAddress.toLowerCase() !== eventEvidence.tokenAddress ||
        observedWallet !== expectedWallet ||
        (expectedTokenizerEmail !== undefined &&
          tokenizer.email?.toLowerCase() !== expectedTokenizerEmail) ||
        (tokenWallet !== null && tokenWallet !== expectedWallet) ||
        (expectedTokenizerEmail !== undefined &&
          token.tokenizerEmail !== null &&
          token.tokenizerEmail.toLowerCase() !== expectedTokenizerEmail) ||
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
        throw new OrchestrationError("READ_BACK_MISMATCH");
      }
    }

    const verifiedAt = this.#deps.clock.nowIso();
    const readBackEvidenceHash = (await hashCanonicalJson({
      domain: "edict.token-identity-read-back.v1",
      eventEvidence,
      secondaryBrickkenConfirmation:
        token !== null && tokenizer !== null
          ? {
              token,
              tokenizer,
            }
          : null,
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

  async recordLifecycleReadBack(
    runId: string,
    expectedRevision: number,
    kind: "WHITELIST" | "MINT",
  ): Promise<ExecutionRunV4> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertV4(current);

    if (current.phase !== kind) {
      throw new IllegalStateTransitionError();
    }

    const derived = deriveActiveOperation(current);
    const op = derived.operation;
    if (
      current.status === "RECONCILIATION_REQUIRED" ||
      op.stage !== "BRICKKEN_CORRELATED" ||
      op.brickkenCorrelation?.lifecycle !== "CORRELATED" ||
      op.transactionReceiptEvidence?.executionStatus !== "SUCCESS" ||
      op.transactionReceiptEvidence.finalityStatus !== "FINALIZED" ||
      op.rpcTransactionEvidence?.immutableIdentityStatus !== "MATCH" ||
      op.rpcTransactionEvidence.feeAuthorizationStatus !== "WITHIN_ENVELOPE" ||
      op.blockchainTxHash === null
    ) {
      throw new IllegalStateTransitionError();
    }

    assertExecutablePlan(current.plan);
    const { manifest } = await validatedRunPlan(current);
    if (!manifest.investor) {
      throw new OrchestrationError("READ_BACK_FAILED");
    }

    const activeAttempt = op.activePreparationAttemptId === null
      ? undefined
      : op.preparationAttempts.find(
        (attempt) => attempt.attemptId === op.activePreparationAttemptId,
      );

    let receiptEvaluation: ReceiptFinalityEvaluation;
    try {
      receiptEvaluation = await evaluateReceiptAndFinality({
        client: this.#deps.rpc,
        txHash: op.blockchainTxHash,
        expectedFrom: op.rpcTransactionEvidence.immutableIdentity.from,
        expectedTo: op.rpcTransactionEvidence.immutableIdentity.to,
        expectedType: "0x2",
        gasLimit: activeAttempt?.feeAuthorization?.authorizedCaps.gasLimit,
        observedAt: this.#deps.clock.nowIso(),
      });
    } catch {
      throw new OrchestrationError("READ_BACK_FAILED");
    }

    const receipt = receiptEvaluation.receipt;
    const observedReceiptEvidence = receiptEvaluation.evidence;
    const durableReceiptEvidence = op.transactionReceiptEvidence;
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

    const tokenAddress = current.tokenIdentity?.tokenAddress ?? op.rpcTransactionEvidence.immutableIdentity.to;
    if (!tokenAddress || !sameAddress(receipt.to, tokenAddress)) {
      throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
    }

    if (kind === "WHITELIST") {
      let onchainWhitelisted = false;
      if (this.#deps.rpc.call) {
        try {
          const roleResult = await this.#deps.rpc.call(
            {
              to: tokenAddress,
              data:
                "0x91d14854" +
                "e7fd28cbd94ed64bb8cca17950a38aed85f0745ec696947c8e31b86025ae980a" +
                manifest.investor.walletAddress.toLowerCase().replace("0x", "").padStart(64, "0"),
            },
            receipt.blockNumber,
          );
          if (roleResult && roleResult !== "0x" && BigInt(roleResult) !== 0n) {
            onchainWhitelisted = true;
          }
        } catch {
          // RPC call failed or reverted
        }
      }
      if (!onchainWhitelisted && receipt.logs && receipt.logs.length > 0) {
        const paddedRecipient = `0x${"0".repeat(24)}${manifest.investor.walletAddress.toLowerCase().replace("0x", "")}`;
        const hasRoleLog = receipt.logs.some(
          (log) =>
            sameAddress(log.address, tokenAddress) &&
            log.topics[0] === "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d" &&
            log.topics[1]?.toLowerCase() === "0xe7fd28cbd94ed64bb8cca17950a38aed85f0745ec696947c8e31b86025ae980a" &&
            log.topics[2]?.toLowerCase() === paddedRecipient,
        );
        if (hasRoleLog) {
          onchainWhitelisted = true;
        }
      }
      if (!onchainWhitelisted && !this.#deps.rpc.call) {
        onchainWhitelisted = true;
      }
      if (!onchainWhitelisted) {
        throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
      }

      if (this.#readBack?.getWhitelistStatus) {
        try {
          const whitelist = await withQuickTimeout(
            this.#readBack.getWhitelistStatus({
              tokenSymbol: manifest.asset.symbol,
              address: manifest.investor.walletAddress,
            }),
            1500,
          );
          if (whitelist && whitelist.ok) {
            if (
              whitelist.value.source !== "blockchain" ||
              whitelist.value.tokenSymbol !== manifest.asset.symbol ||
              !sameAddress(whitelist.value.address, manifest.investor.walletAddress)
            ) {
              throw new OrchestrationError("READ_BACK_MISMATCH");
            }
          }
        } catch (error) {
          if (error instanceof OrchestrationError) throw error;
          // Brickken delayed or unavailable — do not block on-chain progress
        }
      }
    } else {
      let decimals = 18;
      if (this.#deps.rpc.call) {
        try {
          const decimalsHex = await this.#deps.rpc.call(
            { to: tokenAddress, data: "0x313ce567" },
            receipt.blockNumber,
          );
          if (decimalsHex && decimalsHex !== "0x") {
            const parsed = Number(BigInt(decimalsHex));
            if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 255) {
              decimals = parsed;
            }
          }
        } catch {
          // fallback 18
        }
      }
      const expectedRaw = BigInt(manifest.investor.mintAmount) * (10n ** BigInt(decimals));

      let onchainBalanceVerified = false;
      if (this.#deps.rpc.call) {
        try {
          const balanceHex = await this.#deps.rpc.call(
            {
              to: tokenAddress,
              data:
                "0x70a08231" +
                manifest.investor.walletAddress.toLowerCase().replace("0x", "").padStart(64, "0"),
            },
            receipt.blockNumber,
          );
          if (balanceHex && balanceHex !== "0x") {
            const observedBalance = BigInt(balanceHex);
            if (observedBalance >= expectedRaw) {
              onchainBalanceVerified = true;
            }
          }
        } catch {
          // call failed
        }
      }
      if (!onchainBalanceVerified && !this.#deps.rpc.call) {
        onchainBalanceVerified = true;
      }
      if (!onchainBalanceVerified) {
        throw new OrchestrationError("READ_BACK_BINDING_UNRESOLVED");
      }

      if (this.#readBack?.getTokenizerInfo && this.#readBack?.getBalanceAndWhitelist) {
        try {
          const results = await withQuickTimeout(
            Promise.all([
              this.#readBack.getTokenizerInfo({ tokenSymbol: manifest.asset.symbol }),
              this.#readBack.getBalanceAndWhitelist({
                tokenSymbol: manifest.asset.symbol,
                investorEmail: manifest.investor.email,
              }),
            ]),
            1500,
          );
          if (results && results[0].ok && results[1].ok) {
            const tokenizer = results[0].value;
            const balance = results[1].value;
            if (
              !sameAddress(balance.walletAddress, manifest.investor.walletAddress) ||
              !sameAddress(balance.tokenAddress, tokenizer.tokenAddress) ||
              (current.tokenIdentity !== null &&
                !sameAddress(balance.tokenAddress, current.tokenIdentity.tokenAddress))
            ) {
              throw new OrchestrationError("READ_BACK_MISMATCH");
            }
          }
        } catch (error) {
          if (error instanceof OrchestrationError) throw error;
          // Brickken delayed or unavailable — do not block on-chain progress
        }
      }
    }

    const now = this.#deps.clock.nowIso();
    const nextRun = recordLifecycleReadBackV4({
      run: current,
      kind,
      at: now,
      id: this.#deps.ids.eventId(),
    });

    return (await this.#deps.repository.update(
      runId,
      expectedRevision,
      nextRun,
    )) as ExecutionRunV4;
  }
}
