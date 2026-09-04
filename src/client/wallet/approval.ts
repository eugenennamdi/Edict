"use client";

import "client-only";

import {
  validateApprovalChallenge,
  type ApprovalChallengeEnvelopeV1,
  type AuthorizedRunProjection,
} from "@/shared/wallet";
import { WalletBoundaryError, providerErrorCode } from "./errors";
import type { SelectedWalletSession } from "./session";

export interface ApprovalGateway {
  readRun(runId: string): Promise<AuthorizedRunProjection>;
  issueChallenge(input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }): Promise<ApprovalChallengeEnvelopeV1>;
  submitApproval(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly challengeToken: string;
    readonly signature: string;
  }): Promise<AuthorizedRunProjection>;
}

const SIGNATURE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;

export async function approveRunFromUserAction(input: {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly wallet: SelectedWalletSession;
  readonly gateway: ApprovalGateway;
  readonly nowEpochSeconds: () => bigint;
}): Promise<AuthorizedRunProjection> {
  const run = await input.gateway.readRun(input.runId);
  if (run.revision !== input.expectedRevision || run.approved || run.status !== "AWAITING_APPROVAL") {
    throw new WalletBoundaryError("TYPED_DATA_MISMATCH");
  }
  const challenge = await input.gateway.issueChallenge({
    runId: input.runId,
    expectedRevision: input.expectedRevision,
  });
  const validated = validateApprovalChallenge(challenge, run, input.nowEpochSeconds());
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
  await input.gateway.submitApproval({
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    challengeToken: validated.value.challengeToken,
    signature,
  });
  const durable = await input.gateway.readRun(input.runId);
  if (!durable.approved) throw new WalletBoundaryError("TYPED_DATA_MISMATCH");
  return durable;
}
