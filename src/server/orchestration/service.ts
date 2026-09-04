import "server-only";

import { buildExecutionPlanV1, validateAssetManifestV1 } from "@/core";
import type {
  AdapterResult,
  BrickkenServerAdapter,
  ConfirmedWhitelistEvidence,
  PreparedOperation,
} from "../brickken/types";
import { normalizeSepoliaChainId } from "../brickken/prepared-transaction";
import { IllegalStateTransitionError, RepositoryRevisionConflictError } from "../execution/errors";
import type { ExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import { persistedConfirmationPair } from "../execution/transitions";
import type { ExecutionRun, OperationKind } from "../execution/types";
import { OrchestrationError } from "./errors";
import type { BrickkenWriteGate } from "./write-gate";

export interface ExecutionOrchestratorDependencies {
  readonly repository: ExecutionRunRepository;
  readonly runs: ExecutionRunService;
  readonly brickken: BrickkenServerAdapter;
  readonly writeGate: BrickkenWriteGate;
}

export type WalletResult =
  | Readonly<{ outcome: "BROADCAST"; txHash: string }>
  | Readonly<{ outcome: "REJECTED" }>
  | Readonly<{ outcome: "UNKNOWN" }>;

function operationIndex(kind: OperationKind): 0 | 1 | 2 {
  if (kind === "TOKENIZE") return 0;
  if (kind === "WHITELIST") return 1;
  return 2;
}

function assertRevision(run: ExecutionRun, expectedRevision: number): void {
  if (run.revision !== expectedRevision) throw new RepositoryRevisionConflictError();
}

async function validatedRunPlan(run: ExecutionRun) {
  const manifest = validateAssetManifestV1(run.manifest);
  if (!manifest.ok) throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  const plan = await buildExecutionPlanV1(manifest.value);
  if (plan.manifestHash !== run.manifestHash || plan.planHash !== run.planHash) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  return { manifest: manifest.value, plan };
}

function assertPrepareAllowed(run: ExecutionRun, kind: OperationKind): void {
  if (run.approval === null || run.status === "RECONCILIATION_REQUIRED" || run.terminalOutcome) {
    throw new IllegalStateTransitionError();
  }
  const operation = run.operations[operationIndex(kind)];
  if (operation.stage !== "NOT_STARTED" || operation.preparedTxId !== null) {
    throw new IllegalStateTransitionError();
  }
  if (kind === "TOKENIZE" && run.phase !== "TOKENIZATION") throw new IllegalStateTransitionError();
  if (
    kind === "WHITELIST" &&
    (run.phase !== "WHITELIST" || run.operations[0].stage !== "READ_BACK_VERIFIED")
  ) {
    throw new IllegalStateTransitionError();
  }
  if (
    kind === "MINT" &&
    (run.phase !== "MINT" || run.operations[1].stage !== "READ_BACK_VERIFIED")
  ) {
    throw new IllegalStateTransitionError();
  }
}

function assertPreparedMatchesRun(run: ExecutionRun, prepared: PreparedOperation): void {
  const transaction = prepared.transaction;
  if (
    transaction.normalizedChainId !== run.chainId ||
    transaction.from?.toLowerCase() !== run.requiredSigner.walletAddress ||
    transaction.to === null ||
    transaction.data === null
  ) {
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
      "MINT_POLICY_VIOLATION",
    ].includes(result.error.code)
  );
}

function normalizeObservedChain(value: string | null): "11155111" | null {
  if (value === null) return null;
  if (value.toLowerCase() === "aa36a7") return "11155111";
  return normalizeSepoliaChainId(value);
}

function sameAddress(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right;
}

export class ExecutionOrchestrator {
  readonly #deps: ExecutionOrchestratorDependencies;

  constructor(deps: ExecutionOrchestratorDependencies) {
    this.#deps = deps;
  }

  async prepareOperation(
    runId: string,
    expectedRevision: number,
    kind: OperationKind,
  ): Promise<ExecutionRun> {
    this.#deps.writeGate.assertEnabled("PREPARE");
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    assertPrepareAllowed(current, kind);
    const { manifest } = await validatedRunPlan(current);
    const intent = await this.#deps.runs.beginPrepare(runId, expectedRevision, kind);
    this.#deps.writeGate.assertEnabled("PREPARE");

    let result: AdapterResult<PreparedOperation>;
    if (kind === "TOKENIZE") {
      result = await this.#deps.brickken.prepareTokenization({
        signerAddress: current.requiredSigner.walletAddress,
        tokenizerEmail: manifest.tokenizer.email,
        name: manifest.asset.name,
        tokenSymbol: manifest.asset.symbol,
        supplyCap: manifest.asset.supplyCap,
        documentationUrl: manifest.asset.documentationUrl,
      });
    } else if (kind === "WHITELIST") {
      result = await this.#deps.brickken.prepareWhitelist({
        signerAddress: current.requiredSigner.walletAddress,
        tokenSymbol: manifest.asset.symbol,
        investorAddress: manifest.investor.walletAddress,
        investorEmail: manifest.investor.email,
      });
    } else {
      const whitelist = current.operations[1];
      if (whitelist.stage !== "READ_BACK_VERIFIED" || whitelist.preparedTxId === null) {
        throw new IllegalStateTransitionError();
      }
      const evidence: ConfirmedWhitelistEvidence = {
        runId: current.id,
        whitelistTxId: whitelist.preparedTxId,
        stage: "READ_BACK_VERIFIED",
        investorWalletAddress: manifest.investor.walletAddress,
        isWhitelisted: true,
        source: "blockchain",
      };
      result = await this.#deps.brickken.prepareMint(
        {
          signerAddress: current.requiredSigner.walletAddress,
          tokenSymbol: manifest.asset.symbol,
          investorAddress: manifest.investor.walletAddress,
          investorEmail: manifest.investor.email,
          amount: manifest.investor.mintAmount,
        },
        evidence,
      );
    }

    if (!result.ok) {
      if (definitePrepareRefusal(result)) {
        await this.#deps.runs.recordPrepareFailure(runId, intent.revision, kind);
      } else {
        await this.#deps.runs.recordPrepareUnknown(runId, intent.revision, kind);
      }
      throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    }

    try {
      assertPreparedMatchesRun(current, result.value);
      return await this.#deps.runs.recordPrepared(runId, intent.revision, kind, {
        txId: result.value.txId,
        unsignedTransaction: result.value.transaction.rawUnsigned,
      });
    } catch (error) {
      try {
        await this.#deps.runs.recordPrepareUnknown(runId, intent.revision, kind);
      } catch {
        // The intent remains durable. A later operator must reconcile it.
      }
      if (error instanceof OrchestrationError) throw error;
      throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    }
  }

  async recordWalletPrompt(
    runId: string,
    expectedRevision: number,
    kind: OperationKind,
  ): Promise<ExecutionRun> {
    return this.#deps.runs.recordWalletPrompt(runId, expectedRevision, kind);
  }

  async recordWalletResult(
    runId: string,
    expectedRevision: number,
    kind: OperationKind,
    result: WalletResult,
  ): Promise<ExecutionRun> {
    if (result.outcome === "BROADCAST") {
      return this.#deps.runs.recordBroadcastHash(
        runId,
        expectedRevision,
        kind,
        result.txHash,
      );
    }
    if (result.outcome === "REJECTED") {
      return this.#deps.runs.recordWalletRejection(runId, expectedRevision, kind);
    }
    return this.#deps.runs.recordBroadcastUnknown(runId, expectedRevision, kind);
  }

  async confirmBroadcast(
    runId: string,
    expectedRevision: number,
    kind: OperationKind,
  ): Promise<ExecutionRun> {
    this.#deps.writeGate.assertEnabled("CONFIRM_BROADCAST");
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);

    let submitted = current;
    let pair = persistedConfirmationPair(current, kind);
    const operation = current.operations[operationIndex(kind)];
    if (operation.stage === "BROADCAST_HASH_PERSISTED") {
      const result = await this.#deps.runs.submitConfirmation(runId, expectedRevision, kind);
      submitted = result.run;
      pair = { txId: result.txId, txHash: result.txHash };
    } else if (operation.stage !== "CONFIRMATION_SUBMITTED" || pair === null) {
      throw new IllegalStateTransitionError();
    }

    this.#deps.writeGate.assertEnabled("CONFIRM_BROADCAST");
    const result = await this.#deps.brickken.confirmBroadcast(pair);
    if (!result.ok) {
      await this.#deps.runs.recordConfirmTransportFailure(runId, submitted.revision, kind);
      throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    }
    if (result.value.txHash !== null && result.value.txHash.toLowerCase() !== pair.txHash) {
      await this.#deps.runs.recordConfirmTransportFailure(runId, submitted.revision, kind);
      throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    }
    if (result.value.status === "success") {
      return this.#deps.runs.recordConfirmed(runId, submitted.revision, kind);
    }
    return this.#deps.runs.recordPending(runId, submitted.revision, kind);
  }

  async pollOperation(
    runId: string,
    expectedRevision: number,
    kind: OperationKind,
  ): Promise<ExecutionRun> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    const operation = current.operations[operationIndex(kind)];
    if (
      !["CONFIRMATION_SUBMITTED", "PENDING"].includes(operation.stage) ||
      operation.preparedTxId === null ||
      operation.blockchainTxHash === null
    ) {
      throw new IllegalStateTransitionError();
    }
    const result = await this.#deps.brickken.getTransactionStatus({
      txId: operation.preparedTxId,
      hash: operation.blockchainTxHash,
    });
    if (!result.ok) throw new OrchestrationError("BRICKKEN_OPERATION_FAILED");
    if (
      result.value.transactionHash !== null &&
      result.value.transactionHash.toLowerCase() !== operation.blockchainTxHash
    ) {
      throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
    }
    if (result.value.status === "pending") {
      return this.#deps.runs.recordPending(runId, expectedRevision, kind);
    }
    if (result.value.status === "rejected") {
      return this.#deps.runs.recordRejected(
        runId,
        expectedRevision,
        kind,
        "Brickken reported a rejected transaction.",
      );
    }
    return this.#deps.runs.recordConfirmed(runId, expectedRevision, kind);
  }

  async verifyReadBack(
    runId: string,
    expectedRevision: number,
    kind: OperationKind,
  ): Promise<ExecutionRun> {
    const current = await this.#deps.repository.getById(runId);
    assertRevision(current, expectedRevision);
    if (current.operations[operationIndex(kind)].stage !== "CONFIRMED") {
      throw new IllegalStateTransitionError();
    }
    const { manifest } = await validatedRunPlan(current);
    let matches = false;
    let read = "";

    if (kind === "TOKENIZE") {
      const [token, tokenizer] = await Promise.all([
        this.#deps.brickken.getTokenInfo({ tokenSymbol: manifest.asset.symbol }),
        this.#deps.brickken.getTokenizerInfo({ tokenSymbol: manifest.asset.symbol }),
      ]);
      if (!token.ok || !tokenizer.ok) throw new OrchestrationError("READ_BACK_FAILED");
      const observedName = token.value.name ?? token.value.tokenName;
      matches =
        observedName === manifest.asset.name &&
        token.value.tokenSymbol === manifest.asset.symbol &&
        token.value.tokenType?.toUpperCase() === manifest.asset.tokenType &&
        token.value.tokenizerEmail?.toLowerCase() === manifest.tokenizer.email &&
        sameAddress(token.value.companyWalletAddress, manifest.tokenizer.walletAddress) &&
        token.value.maxTokenSupply === manifest.asset.supplyCap &&
        normalizeObservedChain(token.value.paymentChainId) === current.chainId &&
        sameAddress(tokenizer.value.companyWalletAddress, manifest.tokenizer.walletAddress) &&
        tokenizer.value.email?.toLowerCase() === manifest.tokenizer.email &&
        normalizeObservedChain(tokenizer.value.chainId) === current.chainId;
      read = "TOKEN_INFO+TOKENIZER_INFO";
    } else if (kind === "WHITELIST") {
      const whitelist = await this.#deps.brickken.getWhitelistStatus({
        tokenSymbol: manifest.asset.symbol,
        address: manifest.investor.walletAddress,
      });
      if (!whitelist.ok) throw new OrchestrationError("READ_BACK_FAILED");
      matches =
        whitelist.value.isWhitelisted &&
        whitelist.value.source === "blockchain" &&
        whitelist.value.tokenSymbol === manifest.asset.symbol &&
        sameAddress(whitelist.value.address, manifest.investor.walletAddress);
      read = "WHITELIST_STATUS";
    } else {
      const [tokenizer, balance] = await Promise.all([
        this.#deps.brickken.getTokenizerInfo({ tokenSymbol: manifest.asset.symbol }),
        this.#deps.brickken.getBalanceAndWhitelist({
          tokenSymbol: manifest.asset.symbol,
          investorEmail: manifest.investor.email,
        }),
      ]);
      if (!tokenizer.ok || !balance.ok) throw new OrchestrationError("READ_BACK_FAILED");
      const decimals = balance.value.tokenDecimals;
      const expectedRaw =
        Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 255
          ? (BigInt(manifest.investor.mintAmount) * 10n ** BigInt(decimals)).toString()
          : null;
      matches =
        expectedRaw !== null &&
        balance.value.tokenBalanceRaw === expectedRaw &&
        balance.value.isWhitelisted &&
        balance.value.balanceSource === "blockchain" &&
        sameAddress(balance.value.walletAddress, manifest.investor.walletAddress) &&
        balance.value.tokenAddress.toLowerCase() === tokenizer.value.tokenAddress.toLowerCase();
      read = "TOKENIZER_INFO+BALANCE_AND_WHITELIST";
    }

    return matches
      ? this.#deps.runs.recordReadBackVerified(runId, expectedRevision, kind, read)
      : this.#deps.runs.recordReadBackMismatch(runId, expectedRevision, kind);
  }

  async finalizeVerification(runId: string, expectedRevision: number): Promise<ExecutionRun> {
    return this.#deps.runs.recordFinalVerification(runId, expectedRevision);
  }
}
