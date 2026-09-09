import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanningView } from "./run-planning";
import { ExecutionReviewSection } from "./execution-review-section";
import { createPreparedTransactionReviewV1 } from "@/shared/wallet";

function view(status: "READY_FOR_PREPARATION" | "PREPARATION_UNCONFIRMED"): PlanningView {
  const signer = "0x1111111111111111111111111111111111111111";
  return { run: {
    id: "11111111-1111-4111-8111-111111111111", schemaVersion: "2.0",
    manifestHash: `sha256:${"1".repeat(64)}`, planHash: `sha256:${"2".repeat(64)}`,
    environment: "sandbox", chainId: "11155111", requiredSigner: { role: "tokenizer", walletAddress: signer },
    phase: "TOKENIZATION", status: status === "PREPARATION_UNCONFIRMED" ? "RECONCILIATION_REQUIRED" : "PREPARING",
    terminalOutcome: null, approved: true, execution: { projectionVersion: "1.0", nextOperation: { id: "operation-1", kind: "TOKENIZE", sequence: 1, name: "Create tokenization" }, preparationStatus: status, transactionReview: null },
    operations: [
      { id: "operation-1", kind: "TOKENIZE", stage: status === "PREPARATION_UNCONFIRMED" ? "PREPARE_UNKNOWN" : "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      { id: "operation-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      { id: "operation-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
    ], receiptEligible: false, createdAt: "2026-09-09T12:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z", revision: 2, canCancel: status !== "PREPARATION_UNCONFIRMED",
  }, manifest: {} as PlanningView["manifest"], plan: {} as PlanningView["plan"] };
}

describe("execution preparation review UI", () => {
  it("offers only explicit preparation when the server marks TOKENIZE ready", () => {
    const onPrepare = vi.fn();
    const html = renderToStaticMarkup(createElement(ExecutionReviewSection, { view: view("READY_FOR_PREPARATION"), pending: false, preparationUnconfirmed: false, onPrepare }));
    expect(html).toContain("Prepare transaction for review");
    expect(html).toContain("does not request wallet confirmation");
    expect(html).not.toContain("Send transaction");
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it("offers refresh-only recovery for an ambiguous durable outcome", () => {
    const html = renderToStaticMarkup(createElement(ExecutionReviewSection, { view: view("PREPARATION_UNCONFIRMED"), pending: false, preparationUnconfirmed: false, onPrepare: vi.fn() }));
    expect(html).toContain("will not automatically repeat");
    expect(html).not.toContain("Prepare transaction for review");
  });

  it("renders the exact durable prepared transaction as review-only", async () => {
    const ready = view("READY_FOR_PREPARATION");
    const review = await createPreparedTransactionReviewV1({
      reviewVersion: "1.0", runId: ready.run.id, runRevision: 4,
      manifestHash: ready.run.manifestHash as `sha256:${string}`,
      planHash: ready.run.planHash as `sha256:${string}`,
      approvalRevision: 1, environment: "sandbox", chainId: "11155111",
      operation: { id: "operation-1", kind: "TOKENIZE", sequence: 1 },
      requiredSigner: ready.run.requiredSigner.walletAddress,
      brickken: { method: "newTokenization", executionMode: "client-broadcast" },
      preparedTransactionId: "prepared-1", walletRequestVersion: "1.0",
      walletRequest: { from: ready.run.requiredSigner.walletAddress, to: "0x3333333333333333333333333333333333333333", data: "0x1234", value: "0x0" },
      chainRequirement: { mode: "PROVIDER_PRECONDITION", decimalChainId: "11155111", rpcChainId: "0xaa36a7" },
      calldataSemantics: "OPAQUE_SERVER_PREPARED", walletConfirmation: "NOT_REQUESTED",
    });
    const prepared: PlanningView = { ...ready, run: {
      ...ready.run,
      status: "AWAITING_WALLET",
      revision: 4,
      execution: {
        ...ready.run.execution!,
        preparationStatus: "PREPARED_FOR_REVIEW",
        transactionReview: review as unknown as NonNullable<
          NonNullable<PlanningView["run"]["execution"]>["transactionReview"]
        >,
      },
      operations: [
        { ...ready.run.operations[0], stage: "PREPARED", preparedTxId: "prepared-1" },
        ready.run.operations[1], ready.run.operations[2],
      ],
    } };
    const html = renderToStaticMarkup(createElement(ExecutionReviewSection, { view: prepared, pending: false, preparationUnconfirmed: false, onPrepare: vi.fn() }));
    expect(html).toContain("Transaction prepared. Wallet confirmation has not been requested.");
    expect(html).toContain("0x3333333333333333333333333333333333333333");
    expect(html).toContain("0x1234");
    expect(html).toContain(review.integrity.preparedTransactionFingerprint);
    expect(html).toContain("not wallet authorization");
    expect(html).not.toContain("Prepare transaction for review");
    expect(html).not.toContain("Send transaction");
  });

  it("contains no wallet provider, signing, broadcast, secret, or browser-storage capability", () => {
    const source = readFileSync(new URL("execution-review-section.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/client\/wallet|eth_sendTransaction|eth_requestAccounts|eth_sign|window\.|document\.|localStorage|sessionStorage|BRICKKEN_API_KEY|DATABASE_URL|console\./u);
  });
});
