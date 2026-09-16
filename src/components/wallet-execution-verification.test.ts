import { describe, expect, it, vi } from "vitest";
import type { PublicRunProjection } from "@/shared/run";
import {
  brickkenVerificationCopy,
  pollVerificationOnce,
  shouldPollVerification,
  verificationFailureCopy,
} from "./wallet-execution-verification";

const TX = `0x${"ab".repeat(32)}`;

function fixture(patch: Partial<PublicRunProjection> = {}): PublicRunProjection {
  const operations: PublicRunProjection["operations"] = [
    { id: "op-1", kind: "TOKENIZE", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
    { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
    { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
  ];
  return {
    id: "11111111-1111-4111-8111-111111111111",
    schemaVersion: "4.0",
    manifestHash: `sha256:${"1".repeat(64)}`,
    planHash: `sha256:${"2".repeat(64)}`,
    environment: "sandbox",
    chainId: "11155111",
    requiredSigner: { role: "tokenizer", walletAddress: "0x1111111111111111111111111111111111111111" },
    phase: "TOKENIZATION",
    status: "CONFIRMING",
    terminalOutcome: null,
    approved: true,
    execution: null,
    operations,
    receiptEligible: false,
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:02.000Z",
    revision: 8,
    trackingRemaining: 20,
    ...patch,
  } as PublicRunProjection;
}

describe("verification polling", () => {
  it("keeps polling a finalized correlated run and applies the verified successor without a page refresh", async () => {
    const finalized = fixture({
      operations: [
        { id: "op-1", kind: "TOKENIZE", stage: "BRICKKEN_CORRELATED", preparedTxId: "tx-1", blockchainTxHash: TX, brickkenStatus: "success", timeout: false },
        { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
    });
    const advanced = fixture({
      phase: "WHITELIST",
      status: "PREPARING",
      executeEligible: true,
      revision: 9,
      tokenizationResult: {
        tokenAddress: "0x3333333333333333333333333333333333333333",
        escrowAddress: "0x4444444444444444444444444444444444444444",
        tokenizationId: "17",
        transactionHash: TX,
        verificationStatus: "VERIFIED",
        verifiedAt: "2026-09-13T12:05:00.000Z",
      },
      operations: [
        { id: "op-1", kind: "TOKENIZE", stage: "READ_BACK_VERIFIED", preparedTxId: "tx-1", blockchainTxHash: TX, brickkenStatus: "success", timeout: false },
        { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
    });

    expect(shouldPollVerification(finalized)).toBe(true);

    let current = finalized;
    const pullLatest = vi.fn(async () => {
      throw new Error("page refresh is not required");
    });
    const next = await pollVerificationOnce({
      run: current,
      track: async () => advanced,
      applyRun: (run) => {
        current = run;
        return true;
      },
      pullLatest,
    });

    expect(next).toEqual(advanced);
    expect(current.phase).toBe("WHITELIST");
    expect(current.status).toBe("PREPARING");
    expect(current.operations[0].stage).toBe("READ_BACK_VERIFIED");
    expect(current.executeEligible).toBe(true);
    expect(shouldPollVerification(current)).toBe(false);
    expect(pullLatest).not.toHaveBeenCalled();
  });

  it("falls back to GET reconcile after the track budget and still does not require a page refresh", async () => {
    const finalized = fixture({
      trackingRemaining: 0,
      operations: [
        { id: "op-1", kind: "TOKENIZE", stage: "BRICKKEN_CORRELATED", preparedTxId: "tx-1", blockchainTxHash: TX, brickkenStatus: "success", timeout: false },
        { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
    });
    const track = vi.fn(async () => finalized);
    const pullLatest = vi.fn(async () => undefined);
    expect(shouldPollVerification(finalized)).toBe(true);
    await pollVerificationOnce({
      run: finalized,
      track,
      applyRun: () => false,
      pullLatest,
    });
    expect(track).not.toHaveBeenCalled();
    expect(pullLatest).toHaveBeenCalledOnce();
  });

  it("stops polling on deterministic verification failure", () => {
    const failed = fixture({
      status: "FAILED",
      terminalOutcome: "VERIFICATION_FAILED",
      operations: [
        { id: "op-1", kind: "TOKENIZE", stage: "BRICKKEN_CORRELATED", preparedTxId: "tx-1", blockchainTxHash: TX, brickkenStatus: "success", timeout: false },
        { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
    });
    expect(shouldPollVerification(failed)).toBe(false);
    expect(verificationFailureCopy(failed)).toContain("contradicted the approved mandate");
  });

  it("shows Brickken wait copy after finality and a longer message after unusual delay", () => {
    expect(brickkenVerificationCopy(false, 3)).toBeNull();
    expect(brickkenVerificationCopy(true, 1)).toBe("Waiting for Brickken verification...");
    expect(brickkenVerificationCopy(true, 6)).toBe(
      "Verification is taking longer than expected. Edict is still checking automatically.",
    );
  });
});
