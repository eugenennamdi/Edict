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
    "POLICY_VIOLATION_ONCHAIN",
    "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
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
  return "Verifying finalized on-chain state...";
}

export function isFeePolicyMismatch(run: PublicRunProjection): boolean {
  if (run.status !== "RECONCILIATION_REQUIRED") return false;
  const op = activeLifecycleOperation(run);
  if (!op.blockchainTxHash) return false;
  return (
    op.stage === "POLICY_VIOLATION_ONCHAIN" ||
    op.feePolicyViolationCode === "PRIORITY_FEE_CAP_EXCEEDED" ||
    (op.feePolicyViolationCode !== null && op.feePolicyViolationCode !== undefined) ||
    (op.stage === "BRICKKEN_CORRELATED" && run.status === "RECONCILIATION_REQUIRED")
  );
}

export function verificationFailureCopy(run: PublicRunProjection): string | null {
  if (run.terminalOutcome === "VERIFICATION_FAILED") {
    return "Brickken read-back contradicted the approved mandate. Edict will not submit another transaction.";
  }
  if (run.status === "FAILED" && run.terminalOutcome !== null) {
    return "Verification failed. Edict will not submit another transaction.";
  }
  if (run.status === "RECONCILIATION_REQUIRED" && activeLifecycleOperation(run).blockchainTxHash !== null) {
    if (isFeePolicyMismatch(run)) {
      return "The transaction was confirmed on Ethereum Sepolia, but the wallet used a network priority fee above Edict’s authorized limit. No additional transaction will be submitted.";
    }
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

export type TrackedBlockObservation = {
  readonly receiptTxHash: string;
  readonly receiptBlockHash: string;
  readonly receiptBlockNumber: bigint;
  readonly highestObservedBlockNumber: bigint;
  readonly currentDepth: number;
};

export type BlockDepthUpdateResult = {
  readonly depth: number;
  readonly reorgDetected: boolean;
  readonly nextObservation: TrackedBlockObservation;
};

/**
 * Updates block confirmation depth monotonically unless a blockchain reorg is detected.
 *
 * Audit note on why observed depth previously jumped (e.g. 50 → 40 → 54 → 52 → 60):
 * 1. Node replica lag: Public RPC load balancers route across node pools where some nodes
 *    lag behind others by 2-10+ blocks.
 * 2. Asynchronous race conditions: Unsequenced parallel queries where slower earlier responses
 *    arrive after faster newer responses.
 * 3. Unclamped mutation: Naively overwriting depth on every RPC poll with whatever raw block number returned.
 *
 * This function preserves monotonicity by clamping to the highest observed block height for the
 * verified canonical transaction receipt block. If the receipt's blockHash or blockNumber changes,
 * an actual reorg is detected and depth is recalculated from the new canonical block.
 */
export function updateMonotonicBlockDepth(params: {
  readonly currentObservation: TrackedBlockObservation | null;
  readonly txHash: string;
  readonly receiptBlockHash: string;
  readonly receiptBlockNumber: bigint;
  readonly latestBlockNumber: bigint;
}): BlockDepthUpdateResult {
  const { currentObservation, txHash, receiptBlockHash, receiptBlockNumber, latestBlockNumber } = params;

  // Detect reorg: receipt was previously observed for this txHash, but blockHash or blockNumber changed
  const isReorg = currentObservation !== null &&
    currentObservation.receiptTxHash === txHash &&
    (currentObservation.receiptBlockHash.toLowerCase() !== receiptBlockHash.toLowerCase() ||
     currentObservation.receiptBlockNumber !== receiptBlockNumber);

  // If a reorg occurred, or if this is the first observation, highestObservedBlockNumber starts at latestBlockNumber.
  // Otherwise, protect against lagging RPC replicas by taking max(currentObservation.highestObservedBlockNumber, latestBlockNumber).
  const effectiveHighestBlock = (!isReorg && currentObservation !== null)
    ? (latestBlockNumber > currentObservation.highestObservedBlockNumber
        ? latestBlockNumber
        : currentObservation.highestObservedBlockNumber)
    : latestBlockNumber;

  // Depth is difference between highest observed block and receipt block, + 1. Clamped to at least 1.
  const rawDiff = Number(effectiveHighestBlock - receiptBlockNumber + 1n);
  const depth = Number.isFinite(rawDiff) && rawDiff >= 1 ? rawDiff : 1;

  return {
    depth,
    reorgDetected: isReorg,
    nextObservation: {
      receiptTxHash: txHash,
      receiptBlockHash,
      receiptBlockNumber,
      highestObservedBlockNumber: effectiveHighestBlock,
      currentDepth: depth,
    },
  };
}

