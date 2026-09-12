import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunApiRuntime } from "./runtime";
import { OrchestrationError } from "../orchestration/errors";

describe("Production RunApiRuntime composition", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = "postgres://user:pass@ep-fake.neon.tech/test_db";
    process.env.EDICT_RUN_SECURITY_SECRET = Buffer.alloc(32, 1).toString("base64url");
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

  it("enforces DENY-ALL semantic authorization so releaseSendAuthority is permanently unreachable", async () => {
    const runtime = createRunApiRuntime();
    expect(runtime.walletExecution).toBeDefined();

    // Any attempt to release send authority must be unconditionally rejected by DenyAll
    await expect(
      runtime.walletExecution!.releaseSendAuthority("11111111-1111-4111-8111-111111111111", 0),
    ).rejects.toThrow(OrchestrationError);
  });

  it("prohibits exposure of RPC variables via NEXT_PUBLIC_ prefix in getServerEnv", async () => {
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = "https://sepolia.example.com";
    expect(() => createRunApiRuntime()).toThrow(/Security violation.*NEXT_PUBLIC_/);
  });
});
