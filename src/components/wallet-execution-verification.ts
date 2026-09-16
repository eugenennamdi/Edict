import type { PublicRunProjection } from "@/shared/run";

export function activeLifecycleOperation(run: PublicRunProjection) {
  const index = run.phase === "WHITELIST" ? 1 : run.phase === "MINT" || run.phase === "VERIFICATION" ? 2 : 0;
  return run.operations[index] ?? run.operations[run.operations.length - 1] ?? run.operations[0];
}

export function shouldPollVerification(run: PublicRunProjection): boolean {
  if (run.terminalOutcome !== null) return false;
  if (run.status === "RECONCILIATION_REQUIRED" || run.status === "FAILED") return false;
  const operation = activeLifecycleOperation(run);
  return operation.blockchainTxHash !== null && operation.stage !== "READ_BACK_VERIFIED";
}

export function isIncludedOnChain(stage: string): boolean {
  return [
    "RPC_TRANSACTION_VERIFIED",
    "BRICKKEN_CORRELATION_PENDING",
    "BRICKKEN_CORRELATED",
    "CONFIRMED",
    "READ_BACK_VERIFIED",
  ].includes(stage);
}

export function isLifecycleFinalized(stage: string): boolean {
  return stage === "BRICKKEN_CORRELATED" || stage === "READ_BACK_VERIFIED";
}

export function verificationPollDelayMs(pollCount: number, finalized: boolean): number {
  if (pollCount <= 0) return 400;
  if (finalized) return Math.min(3_000 * (2 ** Math.min(pollCount - 1, 2)), 15_000);
  return Math.min(2_000 * (2 ** Math.min(pollCount - 1, 4)), 30_000);
}

export function brickkenVerificationCopy(finalized: boolean, pollCount: number): string | null {
  if (!finalized) return null;
  if (pollCount >= 6) {
    return "Verification is taking longer than expected. Edict is still checking automatically.";
  }
  return "Waiting for Brickken verification...";
}

export function verificationFailureCopy(run: PublicRunProjection): string | null {
  if (run.terminalOutcome === "VERIFICATION_FAILED") {
    return "Brickken read-back contradicted the approved mandate. Edict will not submit another transaction.";
  }
  if (run.status === "FAILED" && run.terminalOutcome !== null) {
    return "Verification failed. Edict will not submit another transaction.";
  }
  if (run.status === "RECONCILIATION_REQUIRED" && activeLifecycleOperation(run).blockchainTxHash !== null) {
    return "The transaction was submitted, but Edict detected an execution mismatch. Edict will not submit another transaction.";
  }
  return null;
}

export async function pollVerificationOnce(input: {
  readonly run: PublicRunProjection;
  readonly track: (runId: string, expectedRevision: number) => Promise<PublicRunProjection>;
  readonly applyRun: (run: PublicRunProjection) => boolean;
  readonly pullLatest: () => Promise<void>;
}): Promise<PublicRunProjection | null> {
  if (!shouldPollVerification(input.run)) return null;
  if ((input.run.trackingRemaining ?? 0) > 0) {
    try {
      const next = await input.track(input.run.id, input.run.revision);
      if (!input.applyRun(next)) await input.pullLatest();
      return next;
    } catch {
      await input.pullLatest();
      return null;
    }
  }
  await input.pullLatest();
  return null;
}
