import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicRunProjection } from "@/shared/run";
import { WalletExecutionSection } from "./wallet-execution-section";
import { classifyWalletExecutionErrorDetail, classifyWalletExecutionFailure, initialWalletExecutionUiModel, reduceWalletExecutionUi } from "./wallet-execution-ui-state";
import { updateMonotonicBlockDepth } from "./wallet-execution-verification";

function fixture(patch: Partial<PublicRunProjection> = {}): PublicRunProjection {
  const operations: PublicRunProjection["operations"] = [
    { id: "op-1", kind: "TOKENIZE", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
    { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
    { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
  ];
  return {
    id: "11111111-1111-4111-8111-111111111111", schemaVersion: "2.0",
    manifestHash: `sha256:${"1".repeat(64)}`, planHash: `sha256:${"2".repeat(64)}`,
    environment: "sandbox", chainId: "11155111",
    requiredSigner: { role: "tokenizer", walletAddress: "0x1111111111111111111111111111111111111111" },
    phase: "TOKENIZATION", status: "PREPARING", terminalOutcome: null, approved: true,
    execution: null, operations, receiptEligible: false,
    createdAt: "2026-09-13T12:00:00.000Z", updatedAt: "2026-09-13T12:00:02.000Z", revision: 2,
    ...patch,
  } as PublicRunProjection;
}

describe("wallet execution product surface", () => {
  it("exposes one product action and keeps internal controls and secrets out", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "wallet-execution-section.tsx"), "utf8");
    const workspace = fs.readFileSync(path.resolve(__dirname, "run-planning-workspace.tsx"), "utf8");
    const plan = fs.readFileSync(path.resolve(__dirname, "planning-artifacts.tsx"), "utf8");
    const exampleEnvironment = fs.readFileSync(path.resolve(__dirname, "../../.env.example"), "utf8");
    expect(source).toContain("Execute mandate");
    expect(source).toContain("Technical details");
    expect(source).toContain("Edict will continue automatically");
    expect(source).toContain("Brickken Tokenization Factory");
    expect(source).toContain("Server-capped · max 0.1 ETH");
    for (const internal of ["Prepare transaction for review", "Promote to execution state", "Check server readiness", "Refresh prepared transaction", "Track transaction status", "Request server authorization"])
      expect(source).not.toContain(internal);
    expect(source).not.toMatch(/BRICKKEN_API_KEY|DATABASE_URL|privateKey|seed phrase|eth_sendRawTransaction/u);
    expect(workspace).not.toMatch(/ExecutionReviewSection|prepareNextOperation|7 ops/u);
    expect(plan).toContain("Create tokenized asset");
    expect(plan).not.toContain("Configure investor access");
    expect(plan).not.toContain("Issue allocation");
    expect(plan).toContain("Verify tokenization");
    expect(plan).toContain("view.plan.operations.map");
    expect(exampleEnvironment).not.toContain("EDICT_TOKENIZE_CALLDATA_COMMITMENT");
  });

  it("projects both an unprepared and stale pre-authority run as ready to execute", () => {
    const first = renderToStaticMarkup(createElement(WalletExecutionSection, { run: fixture(), onRefresh: async () => undefined }));
    expect(first).toContain("Ready to execute");
    const base = fixture();
    const stale = fixture({ schemaVersion: "4.0", status: "AWAITING_WALLET", operations: [
      { ...base.operations[0], stage: "PREPARED_STALE", preparedTxId: "tx-1" }, base.operations[1], base.operations[2],
    ] });
    const staleHtml = renderToStaticMarkup(createElement(WalletExecutionSection, { run: stale, onRefresh: async () => undefined }));
    expect(staleHtml).toContain("Ready to execute");
    expect(staleHtml).not.toContain("Refresh prepared transaction");
  });

  it("uses plain-language attention copy and never offers another send after a hash", () => {
    const base = fixture();
    const attention = fixture({ schemaVersion: "4.0", status: "RECONCILIATION_REQUIRED", operations: [
      { ...base.operations[0], stage: "RPC_TRANSACTION_RECONCILIATION_REQUIRED", blockchainTxHash: `0x${"a".repeat(64)}` }, base.operations[1], base.operations[2],
    ] });
    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run: attention, onRefresh: async () => undefined }));
    expect(html).toContain("Needs attention");
    expect(html).toContain("Edict will not submit another transaction");
    expect(html).not.toContain(">Execute mandate</button>");
  });

  it("renders the precise policy mismatch card and lifecycle progression when fee policy is exceeded", () => {
    const base = fixture();
    const policyMismatchRun = fixture({
      schemaVersion: "4.0",
      phase: "MINT",
      status: "RECONCILIATION_REQUIRED",
      operations: [
        {
          ...base.operations[0],
          stage: "READ_BACK_VERIFIED",
          blockchainTxHash: "0xcd837b344b4929493be0070a740164539068179601b6634c68165b986f52d1a9",
          authorizedPriorityFeePerGas: "0x77359400",
          observedPriorityFeePerGas: null,
        },
        {
          ...base.operations[1],
          stage: "READ_BACK_VERIFIED",
          blockchainTxHash: "0x8191a8a382ca0e8279c307b42f018ee32a1179a016dcd5bed6ef5a04ad7dca41",
          authorizedPriorityFeePerGas: "0x77359400",
          observedPriorityFeePerGas: null,
        },
        {
          ...base.operations[2],
          stage: "BRICKKEN_CORRELATED",
          blockchainTxHash: "0x3173106fa06e452ad5957f32581d97d8da2df9812ea32b6c12b8a0b4796d31a8",
          feePolicyViolationCode: "PRIORITY_FEE_CAP_EXCEEDED",
          authorizedPriorityFeePerGas: "0x77359400",
          observedPriorityFeePerGas: "0x80b14f63",
        },
      ],
    });

    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run: policyMismatchRun, onRefresh: async () => undefined }));

    expect(html).toContain("Transaction completed with a policy mismatch");
    expect(html).toContain("The transaction was confirmed on Ethereum Sepolia, but the wallet used a network priority fee above Edict’s authorized limit. No additional transaction will be submitted.");
    expect(html).toContain("Authorized priority fee");
    expect(html).toContain("2.0 gwei");
    expect(html).toContain("Observed priority fee");
    expect(html).toContain("2.159 gwei");
    expect(html).toContain("0x3173106fa06e452ad5957f32581d97d8da2df9812ea32b6c12b8a0b4796d31a8");
    expect(html).toContain("https://sepolia.etherscan.io/tx/0x3173106fa06e452ad5957f32581d97d8da2df9812ea32b6c12b8a0b4796d31a8");

    // Lifecycle progression shows Create asset ✓, Authorize investor ✓, Issue allocation ⚠
    expect(html).toContain("① Create asset");
    expect(html).toContain("② Authorize investor");
    expect(html).toContain("③ Issue allocation");
    expect(html).toContain("⚠");
  });

  it("renders the precise gas limit cap mismatch card for legacy transactions without false priority fee claims", () => {
    const base = fixture();
    const gasMismatchRun = fixture({
      schemaVersion: "4.0",
      phase: "TOKENIZATION",
      status: "RECONCILIATION_REQUIRED",
      operations: [
        {
          ...base.operations[0],
          stage: "BRICKKEN_CORRELATED",
          blockchainTxHash: "0xca554ea011572fb03dc2f99f722dc408ea9ab730e2c8a73112bedec55e420eb7",
          feePolicyViolationCode: "GAS_LIMIT_CAP_EXCEEDED",
          authorizedGasLimit: "0x3fa847",
          observedGasLimit: "0x48567f",
          authorizedMaxFeePerGas: "0xe389a9d6",
          observedMaxFeePerGas: "0x4bd88df2",
          observedTransactionType: "0x0",
          authorizedPriorityFeePerGas: "0xb2d05e00",
          observedPriorityFeePerGas: null,
        },
        base.operations[1],
        base.operations[2],
      ],
    });

    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run: gasMismatchRun, onRefresh: async () => undefined }));

    expect(html).toContain("Transaction completed with a policy mismatch");
    expect(html).toContain("The transaction was confirmed on Ethereum Sepolia, but the wallet used a gas limit above Edict’s authorized limit. No additional transaction will be submitted.");
    expect(html).toContain("Authorized gas limit");
    expect(html).toContain("4,171,847 gas");
    expect(html).toContain("Observed gas limit");
    expect(html).toContain("4,740,735 gas");
    expect(html).toContain("Transaction type");
    expect(html).toContain("Legacy (type 0)");
    expect(html).toContain("0xca554ea011572fb03dc2f99f722dc408ea9ab730e2c8a73112bedec55e420eb7");
    expect(html).not.toContain("used a network priority fee above Edict’s authorized limit");
    expect(html).not.toContain("Observed priority fee");
  });

  it("serializes rapid starts and locks post-authority ambiguity", () => {
    const ready = reduceWalletExecutionUi(initialWalletExecutionUiModel, { type: "LOCAL_STATE", state: "READY" });
    const started = reduceWalletExecutionUi(ready, { type: "START" });
    expect(reduceWalletExecutionUi(started, { type: "START" })).toBe(started);
    expect(reduceWalletExecutionUi(started, { type: "AMBIGUOUS" })).toEqual({ state: "BROADCAST_UNCERTAIN", locked: true, inProgress: false });
    expect(classifyWalletExecutionFailure("BROADCAST_OUTCOME_UNKNOWN")).toEqual({ event: { type: "AMBIGUOUS" }, refresh: true });
  });

  it("classifies error details with truthful on-chain submission status and next actions", () => {
    const semantic = classifyWalletExecutionErrorDetail("SEMANTIC_POLICY_REFUSED");
    expect(semantic.onChainSubmission).toBe("NO");
    expect(semantic.title).toContain("policy");
    expect(semantic.nextStep).toContain("requires attention");
    expect(semantic.retryAllowed).toBe(false);

    const freshness = classifyWalletExecutionErrorDetail("FRESHNESS_CHECK_FAILED");
    expect(freshness.onChainSubmission).toBe("NO");
    expect(freshness.title).toBe("Prepared transaction needs refreshing");
    expect(freshness.description).toContain("expired");
    expect(freshness.nextStep).toContain("Reprepare");

    const unknown = classifyWalletExecutionErrorDetail("BROADCAST_OUTCOME_UNKNOWN");
    expect(unknown.onChainSubmission).toBe("UNKNOWN");
    expect(unknown.nextStep).toContain("Do not submit another transaction");
    expect(unknown.retryAllowed).toBe(false);

    const userReject = classifyWalletExecutionErrorDetail("TRANSACTION_REJECTED");
    expect(userReject.onChainSubmission).toBe("NO");
    expect(userReject.nextStep).toContain("safely try again");

    const exhausted = classifyWalletExecutionErrorDetail("REPREPARE_EXHAUSTED");
    expect(exhausted.onChainSubmission).toBe("NO");
    expect(exhausted.title).toBe("Preparation attempts exhausted");
    expect(exhausted.retryAllowed).toBe(false);
    expect(exhausted.nextStep).toContain("Create a new mandate");

    const optionExhausted = classifyWalletExecutionErrorDetail("UNKNOWN", { reprepareEligible: false });
    expect(optionExhausted.title).toBe("Preparation attempts exhausted");
    expect(optionExhausted.retryAllowed).toBe(false);

    const prepFailed = classifyWalletExecutionErrorDetail("PREPARATION_FAILED");
    expect(prepFailed.onChainSubmission).toBe("NO");
    expect(prepFailed.title).toBe("Preparation request failed");
    expect(prepFailed.retryAllowed).toBe(true);

    const serverReject = classifyWalletExecutionErrorDetail("SERVER_REJECTION");
    expect(serverReject.title).toBe("Preparation request failed");
    expect(serverReject.retryAllowed).toBe(true);

    const malformed = classifyWalletExecutionErrorDetail("MALFORMED_RESPONSE");
    expect(malformed.title).toBe("Preparation response invalid");
    expect(malformed.retryAllowed).toBe(false);

    const fallback = classifyWalletExecutionErrorDetail("SOME_UNKNOWN_ERROR");
    expect(fallback.title).toBe("Execution halted");
    expect(fallback.nextStep).not.toContain("Check your wallet");
    expect(fallback.retryAllowed).toBe(false);
  });

  it("handles SERVER_REJECTION and PREPARATION_FAILED failure classification", () => {
    expect(classifyWalletExecutionFailure("SERVER_REJECTION")).toEqual({
      event: { type: "REFRESH_REQUIRED" },
      refresh: true,
    });
    expect(classifyWalletExecutionFailure("PREPARATION_FAILED")).toEqual({
      event: { type: "REFRESH_REQUIRED" },
      refresh: true,
    });
  });

  it("projects budget exhausted stale run as Needs attention and forbids execution", () => {
    const base = fixture();
    const exhaustedRun = fixture({
      schemaVersion: "4.0",
      status: "AWAITING_WALLET",
      executeEligible: false,
      execution: {
        projectionVersion: "1.0",
        nextOperation: { id: "op-1", kind: "TOKENIZE", sequence: 1, name: "Create tokenization" },
        preparationStatus: "PREPARED_STALE",
        preparationFailureCode: null,
        staleReason: "PRICE_REPORT_EXPIRED",
        reprepareEligible: false,
        transactionReview: null,
      },
      operations: [
        { ...base.operations[0], stage: "PREPARED_STALE", preparedTxId: "tx-2" },
        base.operations[1],
        base.operations[2],
      ],
    });
    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run: exhaustedRun, onRefresh: async () => undefined }));
    expect(html).toContain("Needs attention");
    expect(html).toContain("All allowed preparation attempts (maximum 2) have expired");
    expect(html).not.toContain("Confirm in wallet");
    expect(html).not.toContain("Reprepare tokenization");
    expect(html).not.toContain(">Execute mandate</button>");
  });

  it("exposes two-stage action labels: Execute mandate when unprepared, Confirm in wallet when prepared, Reprepare when stale", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "wallet-execution-section.tsx"), "utf8");
    expect(source).toContain("Confirm in wallet");
    expect(source).toContain("Reprepare tokenization");
    expect(source).toContain("On-chain transaction submitted:");
    expect(source).toContain("Dismiss");
  });
});

describe("verified tokenization result", () => {
  it("remains visible in TOKENIZATION without offering another send", () => {
    const base = fixture();
    const run = fixture({
      schemaVersion: "4.0",
      phase: "TOKENIZATION",
      status: "SUCCEEDED",
      executablePlan: true,
      tokenizationResult: {
        tokenAddress: "0x3333333333333333333333333333333333333333",
        escrowAddress: "0x4444444444444444444444444444444444444444",
        tokenizationId: "17",
        transactionHash: `0x${"ab".repeat(32)}`,
        verificationStatus: "VERIFIED",
        verifiedAt: base.updatedAt,
      },
      operations: [
        { ...base.operations[0], stage: "READ_BACK_VERIFIED", blockchainTxHash: `0x${"ab".repeat(32)}` },
        base.operations[1],
        base.operations[2],
      ],
    });
    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run, onRefresh: async () => undefined }));
    expect(html).toContain("Tokenized asset created");
    expect(html).toContain(run.tokenizationResult!.tokenAddress);
    expect(html).toContain(run.tokenizationResult!.escrowAddress);
    expect(html).toContain("VERIFIED");
    expect(html).not.toContain("Choose the wallet");
  });

  it.each(["WHITELIST", "MINT"] as const)("is hidden in %s while doing subsequent operations", (phase) => {
    const base = fixture();
    const run = fixture({
      schemaVersion: "4.0",
      phase,
      status: "PREPARING",
      executablePlan: true,
      tokenizationResult: {
        tokenAddress: "0x3333333333333333333333333333333333333333",
        escrowAddress: "0x4444444444444444444444444444444444444444",
        tokenizationId: "17",
        transactionHash: `0x${"ab".repeat(32)}`,
        verificationStatus: "VERIFIED",
        verifiedAt: base.updatedAt,
      },
      operations: [
        { ...base.operations[0], stage: "READ_BACK_VERIFIED", blockchainTxHash: `0x${"ab".repeat(32)}` },
        base.operations[1],
        base.operations[2],
      ],
    });
    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run, onRefresh: async () => undefined }));
    expect(html).not.toContain("Tokenized asset created and verified.");
    expect(html).not.toContain(run.tokenizationResult!.escrowAddress);
    expect(html).not.toContain("Choose the wallet");
  });
});

describe("post-submit progress stepper", () => {
  it("renders real progress stepper with external link and reassurance copy when tracking", () => {
    const base = fixture();
    const txHash = `0x${"42".repeat(32)}`;
    const trackingRun = fixture({
      schemaVersion: "4.0",
      status: "CONFIRMING",
      operations: [
        { ...base.operations[0], stage: "RPC_TRANSACTION_VERIFIED", blockchainTxHash: txHash },
        base.operations[1],
        base.operations[2],
      ],
    });

    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run: trackingRun, onRefresh: async () => undefined }));
    expect(html).toContain("Transaction submitted");
    expect(html).toContain("Included on Ethereum Sepolia");
    expect(html).toContain("Finalizing — 1 / 2 required confirmations");
    expect(html).toContain("Verifying lifecycle state");
    expect(html).toContain("No action required. Edict will continue automatically.");
    expect(html).toContain(`https://sepolia.etherscan.io/tx/${txHash}`);
  });

  it("transitions active step to read-back verification when finalized", () => {
    const base = fixture();
    const txHash = `0x${"42".repeat(32)}`;
    const finalizedRun = fixture({
      schemaVersion: "4.0",
      status: "CONFIRMING",
      operations: [
        { ...base.operations[0], stage: "BRICKKEN_CORRELATED", blockchainTxHash: txHash },
        base.operations[1],
        base.operations[2],
      ],
    });

    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run: finalizedRun, onRefresh: async () => undefined }));
    expect(html).toContain("Transaction submitted");
    expect(html).toContain("Included on Ethereum Sepolia");
    expect(html).toContain("Finalized on Ethereum Sepolia");
    expect(html).toContain("Verifying lifecycle state");
    expect(html).toContain("Verifying finalized on-chain state...");
  });

  it("shows a longer wait message in source and a clear verification-failure attention state", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "wallet-execution-verification.ts"), "utf8");
    expect(source).toContain("Verifying finalized on-chain state...");
    expect(source).toContain("Verification is taking longer than expected. Edict is still checking automatically.");
    const base = fixture();
    const failed = fixture({
      schemaVersion: "4.0",
      status: "FAILED",
      terminalOutcome: "VERIFICATION_FAILED",
      operations: [
        { ...base.operations[0], stage: "BRICKKEN_CORRELATED", blockchainTxHash: `0x${"42".repeat(32)}` },
        base.operations[1],
        base.operations[2],
      ],
    });
    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run: failed, onRefresh: async () => undefined }));
    expect(html).toContain("Needs attention");
    expect(html).toContain("contradicted the approved mandate");
    expect(html).not.toContain("Verifying finalized on-chain state...");
  });

  it("renders 'Waiting for Ethereum finality' with block depth and no X / 2 when minimum confirmation depth is satisfied", () => {
    const base = fixture();
    const txHash = `0x${"42".repeat(32)}`;
    const trackingRun = fixture({
      schemaVersion: "4.0",
      status: "CONFIRMING",
      operations: [
        { ...base.operations[0], stage: "RPC_TRANSACTION_VERIFIED", blockchainTxHash: txHash },
        base.operations[1],
        base.operations[2],
      ],
    });

    const html = renderToStaticMarkup(
      createElement(WalletExecutionSection, {
        run: trackingRun,
        onRefresh: async () => undefined,
        initialConfirmations: 60,
      })
    );
    expect(html).toContain("Waiting for Ethereum finality");
    expect(html).toContain("Minimum confirmation depth satisfied");
    expect(html).toContain("60 blocks deep");
    expect(html).toContain("Waiting for Ethereum consensus finality. This typically takes ~13–15 minutes.");
    expect(html).not.toContain("60 / 2");
    expect(html).not.toContain("/ 2 required confirmations");
  });

  it("renders 'Finalizing — 1 / 2 required confirmations' before minimum confirmation depth is satisfied", () => {
    const base = fixture();
    const txHash = `0x${"42".repeat(32)}`;
    const trackingRun = fixture({
      schemaVersion: "4.0",
      status: "CONFIRMING",
      operations: [
        { ...base.operations[0], stage: "RPC_TRANSACTION_VERIFIED", blockchainTxHash: txHash },
        base.operations[1],
        base.operations[2],
      ],
    });

    const html = renderToStaticMarkup(
      createElement(WalletExecutionSection, {
        run: trackingRun,
        onRefresh: async () => undefined,
        initialConfirmations: 1,
      })
    );
    expect(html).toContain("Finalizing — 1 / 2 required confirmations");
    expect(html).not.toContain("Waiting for Ethereum finality");
  });
});

describe("updateMonotonicBlockDepth", () => {
  it("preserves monotonicity across fluctuating RPC replica block numbers (50 -> 40 -> 54 -> 52 -> 60)", () => {
    const txHash = `0x${"11".repeat(32)}`;
    const receiptBlockHash = `0x${"22".repeat(32)}`;
    const receiptBlockNumber = 1000n;

    // Simulation of 5 consecutive RPC checks where load-balanced node replicas report:
    // depths 50, 40, 54, 52, 60
    // receiptBlockNumber is 1000n, so latest blocks correspond to:
    // 1049n (diff 50)
    // 1039n (diff 40)
    // 1053n (diff 54)
    // 1051n (diff 52)
    // 1059n (diff 60)
    const replicaReports = [1049n, 1039n, 1053n, 1051n, 1059n];
    let observation = null;
    const depths: number[] = [];

    for (const latestBlockNumber of replicaReports) {
      const result = updateMonotonicBlockDepth({
        currentObservation: observation,
        txHash,
        receiptBlockHash,
        receiptBlockNumber,
        latestBlockNumber,
      });
      depths.push(result.depth);
      expect(result.reorgDetected).toBe(false);
      observation = result.nextObservation;
    }

    // Monotonic progression: never regresses backwards
    expect(depths).toEqual([50, 50, 54, 54, 60]);
  });

  it("detects an actual reorg when blockHash changes, resetting clamp and recalculating depth", () => {
    const txHash = `0x${"11".repeat(32)}`;
    const initialReceiptBlockHash = `0x${"22".repeat(32)}`;
    const initialReceiptBlockNumber = 1000n;

    // First observation: block 1050 (depth 51)
    const first = updateMonotonicBlockDepth({
      currentObservation: null,
      txHash,
      receiptBlockHash: initialReceiptBlockHash,
      receiptBlockNumber: initialReceiptBlockNumber,
      latestBlockNumber: 1050n,
    });
    expect(first.depth).toBe(51);
    expect(first.reorgDetected).toBe(false);

    // Reorg occurs: transaction is re-mined into block 1005 with a new blockHash
    const reorgedReceiptBlockHash = `0x${"33".repeat(32)}`;
    const reorgedReceiptBlockNumber = 1005n;
    const reorgResult = updateMonotonicBlockDepth({
      currentObservation: first.nextObservation,
      txHash,
      receiptBlockHash: reorgedReceiptBlockHash,
      receiptBlockNumber: reorgedReceiptBlockNumber,
      latestBlockNumber: 1048n,
    });

    expect(reorgResult.reorgDetected).toBe(true);
    // Depth is 1048 - 1005 + 1 = 44, not clamped to stale 51 from previous fork
    expect(reorgResult.depth).toBe(44);
    expect(reorgResult.nextObservation.receiptBlockHash).toBe(reorgedReceiptBlockHash);
  });

  it("detects an actual reorg when blockNumber changes", () => {
    const txHash = `0x${"11".repeat(32)}`;
    const blockHash = `0x${"22".repeat(32)}`;

    const first = updateMonotonicBlockDepth({
      currentObservation: null,
      txHash,
      receiptBlockHash: blockHash,
      receiptBlockNumber: 1000n,
      latestBlockNumber: 1050n,
    });
    expect(first.depth).toBe(51);

    const reorgResult = updateMonotonicBlockDepth({
      currentObservation: first.nextObservation,
      txHash,
      receiptBlockHash: blockHash,
      receiptBlockNumber: 1002n, // Block number changed
      latestBlockNumber: 1051n,
    });
    expect(reorgResult.reorgDetected).toBe(true);
    expect(reorgResult.depth).toBe(50);
  });
});
