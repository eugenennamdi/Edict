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
    expect(html).toContain("Plan approval readiness");
    expect(html).toContain("Café Receivables · ED1");
    expect(html).toContain(current.run.planHash);
    expect(html).toContain(current.run.requiredSigner.walletAddress);
    expect(html).toContain(current.manifest.investor.walletAddress);
    expect(html).toContain("25 tokens");
    expect(html).toContain("Ethereum Sepolia");
    expect(html).toContain("Approving this plan does not submit an on-chain transaction");
    expect(html).toContain("Use legacy injected provider");
    expect(html).not.toContain("Approve this plan");
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
        revision: 2,
      },
    };
    const html = renderToStaticMarkup(createElement(ApprovalReadinessSection, { view: approved }));
    expect(html).toContain("Plan approval recorded");
    expect(html).toContain("Execution is not enabled in this phase");
    expect(html).not.toContain("Select wallet");
    expect(html).not.toContain("Allow account access");
    expect(html).not.toContain("Check wallet again");
    expect(html).not.toContain("Use legacy injected provider");
  });

  it("uses semantic provider selection and keeps signing details outside React", () => {
    const source = readFileSync(new URL("approval-section.tsx", import.meta.url), "utf8");
    expect(source).toContain("<fieldset");
    expect(source).toContain('type="radio"');
    expect(source).toContain("Select wallet");
    expect(source).toContain("Allow account access");
    expect(source).toContain("Check wallet again");
    expect(source).toContain("Switch to Ethereum Sepolia");
    expect(source).toContain("Approve this plan");
    expect(source).toContain("Refresh approval status");
    expect(source).not.toMatch(/eth_sign|approval-challenges|submitApproval|eth_sendTransaction/u);
  });
});
