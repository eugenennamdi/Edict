import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicRunProjection } from "@/shared/run";
import { WalletExecutionSection } from "./wallet-execution-section";
import { classifyWalletExecutionErrorDetail, classifyWalletExecutionFailure, initialWalletExecutionUiModel, reduceWalletExecutionUi } from "./wallet-execution-ui-state";

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
    expect(source).toContain("verifying it automatically");
    expect(source).toContain("Reviewed Brickken tokenization contract");
    expect(source).toContain("0.1 ETH policy ceiling");
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
  it.each(["TOKENIZATION", "WHITELIST", "MINT"] as const)("remains visible in %s without offering another send", (phase) => {
    const base = fixture();
    const run = fixture({ schemaVersion: "4.0", phase, status: phase === "TOKENIZATION" ? "SUCCEEDED" : "PREPARING",
      executablePlan: true, tokenizationResult: {
        tokenAddress: "0x3333333333333333333333333333333333333333",
        escrowAddress: "0x4444444444444444444444444444444444444444", tokenizationId: "17",
        transactionHash: `0x${"ab".repeat(32)}`, verificationStatus: "VERIFIED", verifiedAt: base.updatedAt,
      }, operations: [{ ...base.operations[0], stage: "READ_BACK_VERIFIED", blockchainTxHash: `0x${"ab".repeat(32)}` }, base.operations[1], base.operations[2]],
    });
    const html = renderToStaticMarkup(createElement(WalletExecutionSection, { run, onRefresh: async () => undefined }));
    expect(html).toContain("Tokenized asset created");
    expect(html).toContain(run.tokenizationResult!.tokenAddress);
    expect(html).toContain(run.tokenizationResult!.escrowAddress);
    expect(html).toContain("VERIFIED");
    expect(html).not.toContain("Choose the wallet");
  });
});
