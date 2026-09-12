import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
    ]) expect(source).toContain(text);
    expect(source).not.toMatch(/BRICKKEN_API_KEY|DATABASE_URL|privateKey|seed phrase|eth_sendRawTransaction/u);
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
