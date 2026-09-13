"use client";

import "client-only";

import {
  validateApprovalChallenge,
  type ApprovalChallengeEnvelopeV1,
  type AuthorizedRunProjection,
} from "@/shared/wallet";
import type { PublicRunProjection } from "@/shared/run";
import { WalletBoundaryError, providerErrorCode } from "./errors";
import type { SelectedWalletSession } from "./session";

export type ApprovalGatewayErrorCode =
  | "ACCESS_UNAVAILABLE"
  | "RUN_UNAVAILABLE"
  | "STALE_OR_STATE_CONFLICT"
  | "REQUEST_REFUSED"
  | "SERVICE_UNAVAILABLE"
  | "MALFORMED_REQUEST"
  | "MALFORMED_RESPONSE"
  | "TRANSPORT_FAILURE";

const gatewayMessages: Readonly<Record<ApprovalGatewayErrorCode, string>> = Object.freeze({
  ACCESS_UNAVAILABLE: "Run access is unavailable.",
  RUN_UNAVAILABLE: "The run is unavailable.",
  STALE_OR_STATE_CONFLICT: "The run changed and requires fresh review.",
  REQUEST_REFUSED: "The approval request was refused.",
  SERVICE_UNAVAILABLE: "The approval service is unavailable.",
  MALFORMED_REQUEST: "The approval request is invalid.",
  MALFORMED_RESPONSE: "The approval response is unsafe.",
  TRANSPORT_FAILURE: "The approval service could not be reached.",
});

export class ApprovalGatewayError extends Error {
  constructor(readonly code: ApprovalGatewayErrorCode) {
    super(gatewayMessages[code]);
    this.name = "ApprovalGatewayError";
  }
}

export interface ApprovalGateway {
  readRun(runId: string): Promise<PublicRunProjection>;
  issueChallenge(input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }): Promise<ApprovalChallengeEnvelopeV1>;
  submitApproval(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly challengeToken: string;
    readonly signature: string;
  }): Promise<PublicRunProjection>;
}

export type ApprovalAttemptResult =
  | Readonly<{ outcome: "APPROVAL_RECORDED"; run: PublicRunProjection }>
  | Readonly<{
      outcome: "APPROVAL_NOT_RECORDED";
      run: PublicRunProjection;
      reason: "STALE_OR_CHANGED" | "REFUSED_OR_UNRECORDED";
    }>
  | Readonly<{ outcome: "ACCESS_UNAVAILABLE" }>
  | Readonly<{
      outcome: "APPROVAL_UNCONFIRMED";
      reason: "SERVICE_UNAVAILABLE" | "MALFORMED_RESPONSE" | "TRANSPORT_FAILURE" | "UNSAFE_DURABLE_STATE";
    }>;

export type ApprovalAuthority = Readonly<Pick<
  PublicRunProjection,
  "id" | "revision" | "manifestHash" | "planHash" | "environment" | "chainId" | "requiredSigner"
>>;

export interface ApprovalWalletSession {
  readonly generation: number;
  inspect(requiredSigner: string): Promise<Awaited<ReturnType<SelectedWalletSession["inspect"]>>>;
  assertGeneration(expected: number): void;
  requestExplicit(
    method: "eth_signTypedData_v4",
    params: readonly unknown[],
  ): Promise<unknown>;
}

const SIGNATURE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;

function sameAuthority(candidate: PublicRunProjection, authority: ApprovalAuthority): boolean {
  return candidate.id === authority.id &&
    candidate.manifestHash === authority.manifestHash &&
    candidate.planHash === authority.planHash &&
    candidate.environment === authority.environment &&
    candidate.chainId === authority.chainId &&
    candidate.requiredSigner.role === authority.requiredSigner.role &&
    candidate.requiredSigner.walletAddress === authority.requiredSigner.walletAddress;
}

function recordedApproval(candidate: PublicRunProjection, authority: ApprovalAuthority): boolean {
  return sameAuthority(candidate, authority) &&
    candidate.approved &&
    candidate.revision === authority.revision + 1 &&
    candidate.phase === "TOKENIZATION" &&
    candidate.status === "PREPARING" &&
    candidate.terminalOutcome === null;
}

function unconfirmedReason(
  error: unknown,
): Extract<ApprovalAttemptResult, { outcome: "APPROVAL_UNCONFIRMED" }>["reason"] {
  if (!(error instanceof ApprovalGatewayError)) return "TRANSPORT_FAILURE";
  if (error.code === "MALFORMED_REQUEST" || error.code === "MALFORMED_RESPONSE") return "MALFORMED_RESPONSE";
  if (error.code === "TRANSPORT_FAILURE") return "TRANSPORT_FAILURE";
  return "SERVICE_UNAVAILABLE";
}

export async function readApprovalStatusFromUserAction(input: {
  readonly authority: ApprovalAuthority;
  readonly gateway: ApprovalGateway;
  readonly unrecordedReason: "STALE_OR_CHANGED" | "REFUSED_OR_UNRECORDED";
}): Promise<ApprovalAttemptResult> {
  let durable: PublicRunProjection;
  try {
    durable = await input.gateway.readRun(input.authority.id);
  } catch (error) {
    if (error instanceof ApprovalGatewayError && error.code === "ACCESS_UNAVAILABLE") {
      return Object.freeze({ outcome: "ACCESS_UNAVAILABLE" });
    }
    return Object.freeze({ outcome: "APPROVAL_UNCONFIRMED", reason: unconfirmedReason(error) });
  }
  if (recordedApproval(durable, input.authority)) {
    return Object.freeze({ outcome: "APPROVAL_RECORDED", run: durable });
  }
  if (!sameAuthority(durable, input.authority) || durable.approved) {
    return Object.freeze({ outcome: "APPROVAL_UNCONFIRMED", reason: "UNSAFE_DURABLE_STATE" });
  }
  return Object.freeze({
    outcome: "APPROVAL_NOT_RECORDED",
    run: durable,
    reason: input.unrecordedReason,
  });
}

export async function approveRunFromUserAction(input: {
  readonly authority: ApprovalAuthority;
  readonly wallet: ApprovalWalletSession;
  readonly gateway: ApprovalGateway;
  readonly nowEpochSeconds: () => bigint;
}): Promise<ApprovalAttemptResult> {
  const run = await input.gateway.readRun(input.authority.id);
  const reconcile = async (
    reason: "STALE_OR_CHANGED" | "REFUSED_OR_UNRECORDED",
  ): Promise<ApprovalAttemptResult> => readApprovalStatusFromUserAction({
    authority: input.authority,
    gateway: input.gateway,
    unrecordedReason: reason,
  });

  if (run.approved) {
    return recordedApproval(run, input.authority)
      ? Object.freeze({ outcome: "APPROVAL_RECORDED", run })
      : Object.freeze({ outcome: "APPROVAL_UNCONFIRMED", reason: "UNSAFE_DURABLE_STATE" });
  }
  if (
    !sameAuthority(run, input.authority) ||
    run.revision !== input.authority.revision ||
    run.phase !== "PLAN" ||
    run.status !== "AWAITING_APPROVAL" ||
    run.terminalOutcome !== null
  ) {
    return Object.freeze({ outcome: "APPROVAL_NOT_RECORDED", run, reason: "STALE_OR_CHANGED" });
  }
  let challenge: ApprovalChallengeEnvelopeV1;
  try {
    challenge = await input.gateway.issueChallenge({
      runId: input.authority.id,
      expectedRevision: input.authority.revision,
    });
  } catch (error) {
    if (
      error instanceof ApprovalGatewayError &&
      (error.code === "ACCESS_UNAVAILABLE" || error.code === "STALE_OR_STATE_CONFLICT")
    ) {
      return reconcile(error.code === "STALE_OR_STATE_CONFLICT" ? "STALE_OR_CHANGED" : "REFUSED_OR_UNRECORDED");
    }
    throw error;
  }
  const validated = validateApprovalChallenge(
    challenge,
    run as PublicRunProjection & AuthorizedRunProjection,
    input.nowEpochSeconds(),
  );
  if (!validated.ok) throw new WalletBoundaryError(validated.code);
  const readiness = await input.wallet.inspect(run.requiredSigner.walletAddress);
  if (readiness.state === "REQUIRED_ACCOUNT_UNAVAILABLE" || readiness.state === "UNAUTHORIZED") {
    throw new WalletBoundaryError("REQUIRED_ACCOUNT_UNAVAILABLE");
  }
  if (readiness.state !== "READY") throw new WalletBoundaryError("WRONG_CHAIN");
  const generation = input.wallet.generation;
  let signature: unknown;
  try {
    signature = await input.wallet.requestExplicit(
      validated.value.signingRequest.method,
      validated.value.signingRequest.params,
    );
  } catch (error) {
    if (error instanceof WalletBoundaryError) throw error;
    const code = providerErrorCode(error);
    if (code === 4001) throw new WalletBoundaryError("SIGNATURE_REJECTED");
    if (code === 4200) throw new WalletBoundaryError("TYPED_DATA_SIGNING_UNSUPPORTED");
    if (code === 4900 || code === 4901) throw new WalletBoundaryError("WALLET_DISCONNECTED");
    throw new WalletBoundaryError("UNSUPPORTED_METHOD");
  }
  input.wallet.assertGeneration(generation);
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
    throw new WalletBoundaryError("TYPED_DATA_MISMATCH");
  }
  try {
    await input.gateway.submitApproval({
      runId: input.authority.id,
      expectedRevision: input.authority.revision,
      challengeToken: validated.value.challengeToken,
      signature,
    });
  } catch (error) {
    return reconcile(
      error instanceof ApprovalGatewayError && error.code === "STALE_OR_STATE_CONFLICT"
        ? "STALE_OR_CHANGED"
        : "REFUSED_OR_UNRECORDED",
    );
  }
  return reconcile("REFUSED_OR_UNRECORDED");
}
