"use client";

import "client-only";

import type {
  BrowserBroadcastUnknownReason,
  WalletExecutionHttpGateway,
} from "@/client/run-api/wallet-execution-gateway";
import { WalletExecutionGatewayError } from "@/client/run-api/wallet-execution-gateway";
import {
  parseSendAuthorizedEnvelopeV1,
  validateWalletTransactionRequestV1,
  type SendAuthorizedEnvelopeV1,
} from "@/shared/wallet";
import { WalletBoundaryError, providerErrorCode } from "./errors";
import type { SelectedWalletSession } from "./session";

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = /^0x0{64}$/i;

export type V4WalletExecutionResult = Readonly<{
  outcome: "BROADCAST_RECORDED";
  txHash: string;
}>;

function ready(state: Awaited<ReturnType<SelectedWalletSession["inspect"]>>): boolean {
  return state.state === "READY";
}

async function establishReadiness(
  wallet: SelectedWalletSession,
  requiredSigner: string,
): Promise<void> {
  let state = await wallet.inspect(requiredSigner);
  if (state.state === "UNAUTHORIZED") {
    state = await wallet.requestAccountsFromUserAction(requiredSigner);
  }
  if (state.state === "REQUIRED_ACCOUNT_UNAVAILABLE") {
    throw new WalletBoundaryError("REQUIRED_ACCOUNT_UNAVAILABLE");
  }
  if (state.state === "WRONG_CHAIN") {
    state = await wallet.switchToSepoliaFromUserAction(requiredSigner);
  }
  if (!ready(state)) {
    throw new WalletBoundaryError(
      state.state === "WRONG_CHAIN" ? "WRONG_CHAIN" : "PRE_SEND_ABORTED",
    );
  }
}

function unknownReason(error: unknown, generationChanged: boolean): BrowserBroadcastUnknownReason {
  if (providerErrorCode(error) === 4001) return "PROVIDER_4001";
  if (error instanceof WalletBoundaryError && error.code === "ATTEMPT_INVALIDATED" && !generationChanged) {
    return "PROVIDER_TIMEOUT";
  }
  return "PROVIDER_ERROR";
}

async function reportUnknown(
  gateway: WalletExecutionHttpGateway,
  runId: string,
  envelope: SendAuthorizedEnvelopeV1,
  reason: BrowserBroadcastUnknownReason,
): Promise<never> {
  try {
    await gateway.recordUnknown(runId, {
      expectedRevision: envelope.expectedRevision,
      invocationAttemptId: envelope.invocationAttemptId,
      walletIntentHash: envelope.walletIntentHash,
      reason,
    });
  } catch {
    // INVOKED_OR_UNKNOWN is already durable; failure to report never permits resend.
  }
  throw new WalletBoundaryError("BROADCAST_OUTCOME_UNKNOWN");
}

export async function executeSendAuthorizedEnvelopeFromUserAction(input: {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly requiredSigner: string;
  readonly wallet: SelectedWalletSession;
  readonly gateway: WalletExecutionHttpGateway;
}): Promise<V4WalletExecutionResult> {
  await establishReadiness(input.wallet, input.requiredSigner);
  const generationBeforeAuthority = input.wallet.generation;

  let rawEnvelope: SendAuthorizedEnvelopeV1;
  try {
    rawEnvelope = await input.gateway.authorize(input.runId, input.expectedRevision);
  } catch (error) {
    if (!(error instanceof WalletExecutionGatewayError)) {
      throw new WalletBoundaryError("AUTHORIZATION_REQUEST_REFUSED");
    }
    const code = error.code === "EXECUTION_AUTHORIZATION_UNAVAILABLE"
      ? "EXECUTION_AUTHORIZATION_UNAVAILABLE"
      : error.code === "REVISION_CONFLICT"
        ? "AUTHORIZATION_STATE_CHANGED"
        : error.code === "AUTHORIZATION_RESPONSE_UNKNOWN"
          ? "AUTHORIZATION_RESPONSE_UNKNOWN"
          : error.code === "MALFORMED_RESPONSE"
            ? "AUTHORIZATION_RESPONSE_MALFORMED"
            : "AUTHORIZATION_REQUEST_REFUSED";
    throw new WalletBoundaryError(code);
  }

  let envelope: SendAuthorizedEnvelopeV1;
  try {
    envelope = parseSendAuthorizedEnvelopeV1(rawEnvelope);
  } catch {
    throw new WalletBoundaryError("MALFORMED_PROMPT_ENVELOPE");
  }

  const afterAuthority = async (): Promise<void> => {
    if (envelope.requiredSigner !== input.requiredSigner) {
      return reportUnknown(input.gateway, input.runId, envelope, "PROVIDER_ERROR");
    }
    try {
      input.wallet.assertGeneration(generationBeforeAuthority);
      await establishReadiness(input.wallet, envelope.requiredSigner);
      input.wallet.assertGeneration(generationBeforeAuthority);
      validateWalletTransactionRequestV1(envelope.walletRequest);
    } catch (error) {
      return reportUnknown(
        input.gateway,
        input.runId,
        envelope,
        unknownReason(error, input.wallet.generation !== generationBeforeAuthority),
      );
    }
  };
  await afterAuthority();

  let providerResult: unknown;
  try {
    providerResult = await input.wallet.sendTransactionOnce({
      expectedGeneration: generationBeforeAuthority,
      requiredSigner: envelope.requiredSigner,
      walletRequest: envelope.walletRequest,
    });
  } catch (error) {
    return reportUnknown(
      input.gateway,
      input.runId,
      envelope,
      unknownReason(error, input.wallet.generation !== generationBeforeAuthority),
    );
  }

  if (input.wallet.generation !== generationBeforeAuthority) {
    return reportUnknown(input.gateway, input.runId, envelope, "PROVIDER_ERROR");
  }
  if (
    typeof providerResult !== "string" ||
    !TRANSACTION_HASH.test(providerResult) ||
    ZERO_HASH.test(providerResult)
  ) {
    return reportUnknown(input.gateway, input.runId, envelope, "PROVIDER_ERROR");
  }

  const txHash = providerResult.toLowerCase();
  try {
    await input.gateway.ingestHash(input.runId, {
      expectedRevision: envelope.expectedRevision,
      invocationAttemptId: envelope.invocationAttemptId,
      walletIntentHash: envelope.walletIntentHash,
      txHash,
    });
  } catch {
    return reportUnknown(
      input.gateway,
      input.runId,
      envelope,
      "HASH_PERSISTENCE_UNCONFIRMED",
    );
  }
  return Object.freeze({ outcome: "BROADCAST_RECORDED", txHash });
}
