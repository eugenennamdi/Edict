import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExecutionPlanV1, validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import type { PlanningView } from "../run-planning";
import { ApprovalReadinessSection } from "./approval-section";

async function view(): Promise<PlanningView> {
  const manifest = validateAssetManifestV1(createValidRawManifest());
  if (!manifest.ok) throw new Error("Invalid fixture");
  const plan = await buildExecutionPlanV1(manifest.value);
  return {
    manifest: manifest.value,
    plan,
    run: {
      id: "11111111-1111-4111-8111-111111111111",
      schemaVersion: "2.0",
      manifestHash: plan.manifestHash,
      planHash: plan.planHash,
      environment: "sandbox",
      chainId: "11155111",
      requiredSigner: plan.requiredSigner,
      phase: "PLAN",
      status: "AWAITING_APPROVAL",
      terminalOutcome: null,
      approved: false,
      execution: null,
      operations: [
        { id: "operation-1", kind: "TOKENIZE", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "operation-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "operation-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
      receiptEligible: false,
      createdAt: "2026-09-08T12:00:00.000Z",
      updatedAt: "2026-09-08T12:00:00.000Z",
      revision: 1,
      canCancel: true,
    },
  };
}

describe("approval readiness UI", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the complete authority boundary without mounting wallet effects during render", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const current = await view();
    const html = renderToStaticMarkup(createElement(ApprovalReadinessSection, { view: current }));
    expect(html).toContain("Mandate Approval");
    expect(html).toContain("Café Receivables · ED1");
    expect(html).toContain(current.run.planHash);
    expect(html).toContain(current.run.requiredSigner.walletAddress);
    expect(html).toContain(current.manifest.investor!.walletAddress);
    expect(html).toContain("25 tokens");
    expect(html).toContain("Ethereum Sepolia");
    expect(html).toContain("Approving this plan does not submit an on-chain transaction");
    expect(html).toContain("Connect wallet");
    expect(html).toContain("Connect your browser wallet to approve this mandate");
    expect(html).not.toContain("Use legacy injected provider");
    expect(html).not.toContain("Available injected wallets");
    expect(html).not.toContain("Approve this plan");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders cleanly when manifest omits investor and tokenizer email", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const rawTokenizeOnly = {
      schemaVersion: "1.0",
      environment: "sandbox",
      chainId: "11155111",
      tokenizer: {
        walletAddress: "0x1111111111111111111111111111111111111111",
      },
      asset: {
        name: "Test Asset",
        symbol: "TST",
        tokenType: "RWA_TOKEN",
        supplyCap: "1000",
        documentationUrl: "https://example.com/doc",
      },
    };
    const validated = validateAssetManifestV1(rawTokenizeOnly);
    if (!validated.ok) throw new Error("Validation failed");
    const plan = await buildExecutionPlanV1(validated.value, "TOKENIZE_ONLY");
    const current = await view();
    const tokenizeOnlyView: PlanningView = {
      ...current,
      manifest: validated.value,
      plan,
      run: {
        ...current.run,
        manifestHash: plan.manifestHash,
        planHash: plan.planHash,
      },
    };
    const html = renderToStaticMarkup(createElement(ApprovalReadinessSection, { view: tokenizeOnlyView }));
    expect(html).toContain("Mandate Approval");
    expect(html).toContain("Test Asset · TST");
    expect(html).toContain(plan.planHash);
    expect(html).toContain("0x1111111111111111111111111111111111111111");
    expect(html).not.toContain("Future allocation · not executed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders an already-approved durable run without wallet-readiness actions", async () => {
    const current = await view();
    const approved: PlanningView = {
      ...current,
      run: {
        ...current.run,
        approved: true,
        phase: "TOKENIZATION",
        status: "PREPARING",
        execution: {
          projectionVersion: "1.0",
          nextOperation: { id: "operation-1", kind: "TOKENIZE", sequence: 1, name: "Create tokenization" },
          preparationStatus: "READY_FOR_PREPARATION",
          transactionReview: null,
        },
        revision: 2,
      },
    };
    const html = renderToStaticMarkup(createElement(ApprovalReadinessSection, { view: approved }));
    expect(html).toContain("Plan approval recorded");
    expect(html).toContain("You can now execute the mandate");
    expect(html).not.toContain("Connect wallet");
    expect(html).not.toContain("Approve this plan");
    expect(html).not.toContain("Use legacy injected provider");
    expect(html).not.toContain("Available injected wallets");
  });

  it("keeps signing details outside React and relies on global wallet readiness", () => {
    const source = readFileSync(new URL("approval-section.tsx", import.meta.url), "utf8");
    expect(source).toContain("Connect wallet");
    expect(source).toContain("Switch to Ethereum Sepolia");
    expect(source).toContain("Switch account / wallet");
    expect(source).toContain("Approve this plan");
    expect(source).toContain("Refresh approval status");
    expect(source).not.toContain("<fieldset");
    expect(source).not.toContain('type="radio"');
    expect(source).not.toContain("Use legacy injected provider");
    expect(source).not.toContain("Available injected wallets");
    expect(source).not.toMatch(/eth_sign|approval-challenges|submitApproval|eth_sendTransaction/u);
  });
});
