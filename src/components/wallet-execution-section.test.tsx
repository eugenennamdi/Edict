import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicRunProjection } from "@/shared/run";
import { WalletExecutionSection } from "./wallet-execution-section";
import {
  classifyWalletExecutionFailure,
  initialWalletExecutionUiModel,
  reduceWalletExecutionUi,
} from "./wallet-execution-ui-state";

describe("wallet execution UI composition", () => {
  it("renders every required safe state and keeps server secrets out of the client module", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "wallet-execution-section.tsx"), "utf8");
    for (const text of [
      "Wallet required",
      "Select a wallet provider",
      "Grant account access",
      "Switch to Ethereum Sepolia",
      "Required signer unavailable",
      "Execution authorization unavailable",
      "Ready for wallet prompt",
      "Wallet prompt in progress",
      "Transaction hash recorded",
      "Broadcast outcome uncertain",
      "Reconciliation required",
      "Promote to execution state",
      "Check server readiness",
      "Track transaction status",
    ]) expect(source).toContain(text);
    expect(source.indexOf('mutateActivation("promote")')).toBeLessThan(
      source.indexOf('mutateActivation("readiness")'),
    );
    expect(source).not.toMatch(/BRICKKEN_API_KEY|DATABASE_URL|privateKey|seed phrase|eth_sendRawTransaction/u);
  });

  it("renders explicit promotion for a V2 PREPARED run before wallet readiness", () => {
    const run = {
      id: "11111111-1111-4111-8111-111111111111",
      schemaVersion: "2.0",
      manifestHash: `sha256:${"1".repeat(64)}`,
      planHash: `sha256:${"2".repeat(64)}`,
      environment: "sandbox",
      chainId: "11155111",
      requiredSigner: { role: "tokenizer", walletAddress: "0x1111111111111111111111111111111111111111" },
      phase: "TOKENIZATION",
      status: "AWAITING_WALLET",
      terminalOutcome: null,
      approved: true,
      execution: null,
      operations: [
        { id: "op-1", kind: "TOKENIZE", stage: "PREPARED", preparedTxId: "tx-1", blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
      receiptEligible: false,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:02.000Z",
      revision: 4,
      canCancel: true,
    } as PublicRunProjection;
    const html = renderToStaticMarkup(createElement(WalletExecutionSection, {
      run,
      onRefresh: async () => undefined,
    }));
    expect(html).toContain("Promote to execution state");
    expect(html).not.toContain("Check server readiness");
    expect(html).not.toContain("Request server authorization and open wallet");
  });

  it("serializes rapid starts and ignores rerender/provider readiness while execution is pending", () => {
    const ready = reduceWalletExecutionUi(initialWalletExecutionUiModel, {
      type: "LOCAL_STATE",
      state: "READY",
    });
    const started = reduceWalletExecutionUi(ready, { type: "START" });
    expect(reduceWalletExecutionUi(started, { type: "START" })).toBe(started);
    expect(reduceWalletExecutionUi(started, { type: "LOCAL_STATE", state: "READY" })).toBe(started);
    expect(started).toEqual({ state: "PROMPT_IN_PROGRESS", locked: false, inProgress: true });
  });

  it("keeps stale PREPARED/provider reselection locked after uncertainty until durable state replaces the view", () => {
    const ready = reduceWalletExecutionUi(initialWalletExecutionUiModel, {
      type: "LOCAL_STATE",
      state: "READY",
    });
    const ambiguous = reduceWalletExecutionUi(
      reduceWalletExecutionUi(ready, { type: "START" }),
      { type: "AMBIGUOUS" },
    );
    expect(reduceWalletExecutionUi(ambiguous, { type: "LOCAL_STATE", state: "PROVIDER_SELECTION" })).toBe(ambiguous);
    expect(reduceWalletExecutionUi(ambiguous, { type: "LOCAL_STATE", state: "READY" })).toBe(ambiguous);
    expect(reduceWalletExecutionUi(ambiguous, { type: "DURABLE_RECONCILIATION" })).toEqual({
      state: "RECONCILIATION_REQUIRED",
      locked: true,
      inProgress: false,
    });
  });

  it("locks revision conflict or authorization transport uncertainty behind durable refresh", () => {
    const ready = reduceWalletExecutionUi(initialWalletExecutionUiModel, {
      type: "LOCAL_STATE",
      state: "READY",
    });
    const refresh = reduceWalletExecutionUi(
      reduceWalletExecutionUi(ready, { type: "START" }),
      { type: "REFRESH_REQUIRED" },
    );
    expect(refresh).toEqual({ state: "DURABLE_REFRESH_REQUIRED", locked: true, inProgress: false });
    expect(reduceWalletExecutionUi(refresh, { type: "START" })).toBe(refresh);
    expect(classifyWalletExecutionFailure("AUTHORIZATION_RESPONSE_UNKNOWN")).toEqual({
      event: { type: "REFRESH_REQUIRED" },
      refresh: true,
    });
    expect(classifyWalletExecutionFailure("AUTHORIZATION_STATE_CHANGED")).toEqual({
      event: { type: "REFRESH_REQUIRED" },
      refresh: true,
    });
  });

  it("forces durable refresh after post-authority ambiguity and keeps deny-all distinct", () => {
    expect(classifyWalletExecutionFailure("BROADCAST_OUTCOME_UNKNOWN")).toEqual({
      event: { type: "AMBIGUOUS" },
      refresh: true,
    });
    expect(classifyWalletExecutionFailure("EXECUTION_AUTHORIZATION_UNAVAILABLE")).toEqual({
      event: { type: "AUTHORIZATION_UNAVAILABLE" },
      refresh: false,
    });
  });
});
