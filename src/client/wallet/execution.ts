"use client";

import "client-only";

import {
  validateWalletPromptEnvelopeV1,
  type AuthorizedExecutionRunProjection,
  type WalletOperationKind,
  type WalletPromptEnvelopeV1,
  type WalletSemanticPolicy,
} from "@/shared/wallet";
import { WalletBoundaryError, providerErrorCode } from "./errors";
import type { SelectedWalletSession } from "./session";

export interface WalletPromptRequestV1 {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly operationKind: WalletOperationKind;
}

export interface WalletResultRequestV1 {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly operationKind: WalletOperationKind;
  readonly walletIntentHash: `sha256:${string}`;
  readonly result:
    | Readonly<{ outcome: "BROADCAST"; txHash: string }>
    | Readonly<{ outcome: "REJECTED" }>
    | Readonly<{ outcome: "UNKNOWN" }>;
}

export interface ExecutionGateway {
  readRun(runId: string): Promise<AuthorizedExecutionRunProjection>;
  recordPrompt(input: WalletPromptRequestV1): Promise<WalletPromptEnvelopeV1>;
  recordResult(input: WalletResultRequestV1): Promise<AuthorizedExecutionRunProjection>;
}

export type TransactionExecutionResult =
  | Readonly<{
      outcome: "BROADCAST_RECORDED";
      txHash: string;
      run: AuthorizedExecutionRunProjection;
    }>
  | Readonly<{ outcome: "REJECTED" }>;

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = /^0x0{64}$/i;

function assertReady(state: Awaited<ReturnType<SelectedWalletSession["inspect"]>>): void {
  if (state.state === "REQUIRED_ACCOUNT_UNAVAILABLE" || state.state === "UNAUTHORIZED") {
    throw new WalletBoundaryError("REQUIRED_ACCOUNT_UNAVAILABLE");
  }
  if (state.state === "WRONG_CHAIN") throw new WalletBoundaryError("WRONG_CHAIN");
  if (state.state !== "READY") throw new WalletBoundaryError("PRE_SEND_ABORTED");
}

async function recordUnknown(
  gateway: ExecutionGateway,
  envelope: WalletPromptEnvelopeV1,
): Promise<never> {
  try {
    await gateway.recordResult({
      runId: envelope.runId,
      expectedRevision: envelope.promptRevision,
      operationKind: envelope.operation.kind,
      walletIntentHash: envelope.integrity.walletIntentHash,
      result: Object.freeze({ outcome: "UNKNOWN" }),
    });
  } catch {
    // The durable prompt remains the replay lock when the unknown result cannot be recorded.
  }
  throw new WalletBoundaryError("BROADCAST_OUTCOME_UNKNOWN");
}

export async function executePreparedTransactionFromUserAction(input: {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly operationKind: WalletOperationKind;
  readonly wallet: SelectedWalletSession;
  readonly gateway: ExecutionGateway;
  readonly semanticPolicy: WalletSemanticPolicy;
}): Promise<TransactionExecutionResult> {
  const run = await input.gateway.readRun(input.runId);
  const operation = run.operations.find((item) => item.kind === input.operationKind);
  if (
    run.id !== input.runId ||
    run.revision !== input.expectedRevision ||
    !run.approved ||
    !operation ||
    !["PREPARED", "WALLET_REJECTED"].includes(operation.stage) ||
    operation.blockchainTxHash !== null
  ) {
    throw new WalletBoundaryError("PRE_SEND_ABORTED");
  }

  assertReady(await input.wallet.inspect(run.requiredSigner.walletAddress));
  const initialGeneration = input.wallet.generation;

  let rawEnvelope: WalletPromptEnvelopeV1;
  try {
    rawEnvelope = await input.gateway.recordPrompt({
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      operationKind: input.operationKind,
    });
  } catch {
    throw new WalletBoundaryError("DURABLE_PROMPT_RECORDING_FAILED");
  }

  let envelope: WalletPromptEnvelopeV1;
  try {
    envelope = await validateWalletPromptEnvelopeV1(rawEnvelope);
  } catch (error) {
    throw new WalletBoundaryError(
      error instanceof Error && error.message === "WALLET_INTENT_HASH_MISMATCH"
        ? "WALLET_INTENT_HASH_MISMATCH"
        : "MALFORMED_PROMPT_ENVELOPE",
    );
  }
  if (
    envelope.runId !== run.id ||
    envelope.manifestHash !== run.manifestHash ||
    envelope.planHash !== run.planHash ||
    envelope.operation.id !== operation.id ||
    envelope.operation.kind !== input.operationKind ||
    envelope.preparedTransactionId !== operation.preparedTxId ||
    envelope.requiredSigner !== run.requiredSigner.walletAddress ||
    envelope.chainId !== run.chainId ||
    envelope.promptRevision !== run.revision + 1
  ) {
    throw new WalletBoundaryError("MALFORMED_PROMPT_ENVELOPE");
  }
  const semantic = input.semanticPolicy.authorize({
    operationKind: input.operationKind,
    chainId: envelope.chainId,
    walletRequest: envelope.walletRequest,
  });
  if (!semantic.allowed) throw new WalletBoundaryError("SEMANTIC_POLICY_REFUSED");

  input.wallet.assertGeneration(initialGeneration);
  assertReady(await input.wallet.inspect(envelope.requiredSigner));
  input.wallet.assertGeneration(initialGeneration);

  let providerInvoked = false;
  let providerResult: unknown;
  try {
    providerInvoked = true;
    const pendingResult = input.wallet.requestExplicit("eth_sendTransaction", [
      envelope.walletRequest,
    ]);
    providerResult = await pendingResult;
  } catch (error) {
    if (!providerInvoked) throw new WalletBoundaryError("PRE_SEND_ABORTED");
    void providerErrorCode(error);
    return recordUnknown(input.gateway, envelope);
  }

  if (input.wallet.generation !== initialGeneration) {
    return recordUnknown(input.gateway, envelope);
  }
  if (typeof providerResult !== "string" || !HASH.test(providerResult) || ZERO_HASH.test(providerResult)) {
    try {
      await input.gateway.recordResult({
        runId: envelope.runId,
        expectedRevision: envelope.promptRevision,
        operationKind: envelope.operation.kind,
        walletIntentHash: envelope.integrity.walletIntentHash,
        result: Object.freeze({ outcome: "UNKNOWN" }),
      });
    } catch {
      // The durable prompt remains blocking.
    }
    throw new WalletBoundaryError("INVALID_TRANSACTION_HASH");
  }
  const txHash = providerResult.toLowerCase();
  let durable: AuthorizedExecutionRunProjection;
  try {
    durable = await input.gateway.recordResult({
      runId: envelope.runId,
      expectedRevision: envelope.promptRevision,
      operationKind: envelope.operation.kind,
      walletIntentHash: envelope.integrity.walletIntentHash,
      result: Object.freeze({ outcome: "BROADCAST", txHash }),
    });
  } catch {
    try {
      const durable = await input.gateway.readRun(input.runId);
      const durableOperation = durable.operations.find((item) => item.kind === input.operationKind);
      if (durableOperation?.blockchainTxHash?.toLowerCase() === txHash) {
        return Object.freeze({ outcome: "BROADCAST_RECORDED", txHash, run: durable });
      }
    } catch {
      // Fall through to the stable handoff failure.
    }
    throw new WalletBoundaryError("DURABLE_HASH_HANDOFF_FAILED");
  }
  return Object.freeze({ outcome: "BROADCAST_RECORDED", txHash, run: durable });
}
