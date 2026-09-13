import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunApiRuntime, createRuntimeSemanticAuthorization } from "./runtime";
import {
  DenyAllSemanticAuthorizationEvaluator,
  OrchestrationError,
  TOKENIZE_ALLOWED_DESTINATION,
  TOKENIZE_CALLDATA_COMMITMENT,
  TOKENIZE_EXECUTION_GATE,
  TOKENIZE_FUNCTION_SIGNATURE,
  TokenizeOnlySemanticAuthorizationEvaluator,
} from "../orchestration";

describe("Production RunApiRuntime composition", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = "postgres://user:pass@ep-fake.neon.tech/test_db";
    process.env.EDICT_RUN_SECURITY_SECRET = Buffer.alloc(32, 1).toString("base64url");
    delete process.env.EDICT_TOKENIZE_EXECUTION_ENABLED;
    delete process.env.EDICT_TOKENIZE_ALLOWED_DESTINATION;
    delete process.env.EDICT_TOKENIZE_FUNCTION_SIGNATURE;
    delete process.env.EDICT_TOKENIZE_CALLDATA_COMMITMENT;
    delete process.env.NEXT_PUBLIC_EDICT_TOKENIZE_EXECUTION_ENABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("constructs production runtime without throwing even when EDICT_SEPOLIA_RPC_URL is unset", () => {
    delete process.env.EDICT_SEPOLIA_RPC_URL;
    const runtime = createRunApiRuntime();
    expect(runtime).toBeDefined();
    expect(runtime.runs).toBeDefined();
    expect(runtime.access).toBeDefined();
    expect(runtime.approvals).toBeDefined();
    expect(runtime.walletExecution).toBeDefined();
  });

  it("wires V4 tracking to exact-pair correlation and hardened status without the V3 alias", () => {
    const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
    expect(source).toContain("brickken.correlateClientBroadcast(pair)");
    expect(source).toContain("brickken.getTransactionStatus(locator)");
    expect(source).not.toContain("confirmBroadcast(");
    expect(source).not.toContain("get-transaction-status");
  });

  it("enforces DENY-ALL semantic authorization so releaseSendAuthority is permanently unreachable", async () => {
    expect(createRuntimeSemanticAuthorization()).toBeInstanceOf(
      DenyAllSemanticAuthorizationEvaluator,
    );
    const runtime = createRunApiRuntime();
    expect(runtime.walletExecution).toBeDefined();

    // Any attempt to release send authority must be unconditionally rejected by DenyAll
    await expect(
      runtime.walletExecution!.releaseSendAuthority("11111111-1111-4111-8111-111111111111", 0),
    ).rejects.toThrow(OrchestrationError);
  });

  it("composes the TOKENIZE-only evaluator only for exact private activation and policy", () => {
    const evaluator = createRuntimeSemanticAuthorization({
      [TOKENIZE_EXECUTION_GATE]: "1",
      [TOKENIZE_ALLOWED_DESTINATION]: "0x4444444444444444444444444444444444444444",
      [TOKENIZE_FUNCTION_SIGNATURE]: "function createTokenization(bytes)",
      [TOKENIZE_CALLDATA_COMMITMENT]: `sha256:${"1".repeat(64)}`,
    });
    expect(evaluator).toBeInstanceOf(TokenizeOnlySemanticAuthorizationEvaluator);
    expect(evaluator.isProductionDenyAll).toBe(false);
  });

  it("prohibits exposure of RPC variables via NEXT_PUBLIC_ prefix in getServerEnv", async () => {
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = "https://sepolia.example.com";
    expect(() => createRunApiRuntime()).toThrow(/Security violation.*NEXT_PUBLIC_/);
  });

  it("rejects every NEXT_PUBLIC TOKENIZE activation or policy variable", () => {
    for (const key of [
      "NEXT_PUBLIC_EDICT_TOKENIZE_EXECUTION_ENABLED",
      "NEXT_PUBLIC_EDICT_TOKENIZE_ALLOWED_DESTINATION",
      "NEXT_PUBLIC_EDICT_TOKENIZE_FUNCTION_SIGNATURE",
      "NEXT_PUBLIC_EDICT_TOKENIZE_CALLDATA_COMMITMENT",
    ]) {
      process.env[key] = "must-not-be-public";
      expect(() => createRunApiRuntime()).toThrow(/server-only/);
      delete process.env[key];
    }
  });
});
