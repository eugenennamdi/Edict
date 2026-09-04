import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OneTimeBootstrapVerifier } from "./auth";
import { runPhase8HarnessCli } from "./cli";
import { readPhase8HarnessConfig } from "./config";
import { validatePhase8ActionEvidenceV1 } from "./evidence";
import { HARNESS_BODY_LIMIT_BYTES, Phase8HarnessRuntime, renderHarnessPage } from "./runtime";
import type { Phase8ActionExecutor, Phase8HarnessConfig } from "./types";

const SECRET = "test-only-bootstrap-secret-with-at-least-32-characters";
const HASH = `sha256:${"a".repeat(64)}` as const;

function config(): Phase8HarnessConfig {
  return Object.freeze({
    mode: "sandbox",
    host: "127.0.0.1",
    port: 43119,
    target: Object.freeze({
      action: "WALLET_SEND",
      runId: "run-1",
      operation: "TOKENIZE",
      walletRequestHash: HASH,
    }),
    allowedEnvironment: Object.freeze(Object.create(null) as Record<string, string>),
  });
}

function evidence(details: Record<string, string | number | boolean | null> = { status: "PASSED" }) {
  return {
    evidenceVersion: "1.0",
    harnessVersion: "1.0",
    observedAt: "2026-09-04T12:00:00.000Z",
    ...config().target,
    evidenceStatus: "PASSED",
    resultFingerprint: null,
    details,
    limitations: ["One exact wallet, version, operation, and transaction profile only."],
    redactions: ["CREDENTIALS", "RAW_EXTERNAL_RESPONSES"],
  };
}

function harness(executor: Phase8ActionExecutor = { execute: vi.fn(async () => evidence()) }) {
  let now = 1_000;
  const clock = { nowMs: () => now };
  return {
    runtime: new Phase8HarnessRuntime({
      config: config(),
      bootstrap: new OneTimeBootstrapVerifier(SECRET, clock),
      executorFactory: () => executor,
      clock,
    }),
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

function request(pathname: string, value: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(value);
  return new Request(`http://127.0.0.1:43119${pathname}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:43119",
      origin: "http://127.0.0.1:43119",
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(payload).byteLength),
      ...headers,
    },
    body: payload,
  });
}

async function session(runtime: Phase8HarnessRuntime) {
  const response = await runtime.handle(request("/session", { bootstrapSecret: SECRET }));
  const result = await response.json() as { ok: boolean; csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!result.ok || !cookie) throw new Error("Expected session.");
  return { csrfToken: result.csrfToken, cookie };
}

async function arm(runtime: Phase8HarnessRuntime, auth: Awaited<ReturnType<typeof session>>) {
  const response = await runtime.handle(request("/arm", {
    csrfToken: auth.csrfToken,
    ...config().target,
  }, { cookie: auth.cookie }));
  const result = await response.json() as { ok: boolean; grantId: string };
  if (!result.ok) throw new Error("Expected grant.");
  return result.grantId;
}

describe("Phase 8 environment isolation", () => {
  it("copies only the exact per-action environment allowlist", () => {
    const parsed = readPhase8HarnessConfig({
      EDICT_PHASE8_MODE: "sandbox",
      EDICT_PHASE8_HOST: "127.0.0.1",
      EDICT_PHASE8_PORT: "43119",
      EDICT_PHASE8_ACTION: "BRICKKEN_PREPARE",
      EDICT_PHASE8_RUN_ID: "run-1",
      EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
      DATABASE_URL: "postgresql://example.invalid/database",
      BRICKKEN_API_KEY: "test-placeholder-not-a-real-key",
      NEXT_PUBLIC_BRICKKEN_API_KEY: "must-not-copy",
      UNRELATED_SECRET: "must-not-copy",
    });
    expect(Object.keys(parsed.allowedEnvironment).sort()).toEqual(["BRICKKEN_API_KEY", "DATABASE_URL"]);
    expect(parsed.allowedEnvironment).not.toHaveProperty("NEXT_PUBLIC_BRICKKEN_API_KEY");
    expect(parsed.allowedEnvironment).not.toHaveProperty("UNRELATED_SECRET");
  });

  it.each([
    ["production mode", { EDICT_PHASE8_MODE: "production", EDICT_PHASE8_HOST: "127.0.0.1" }],
    ["non-loopback", { EDICT_PHASE8_MODE: "sandbox", EDICT_PHASE8_HOST: "0.0.0.0" }],
  ])("refuses %s", (_label, patch) => {
    expect(() => readPhase8HarnessConfig({
      EDICT_PHASE8_PORT: "43119",
      EDICT_PHASE8_ACTION: "WALLET_SEND",
      EDICT_PHASE8_RUN_ID: "run-1",
      EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
      EDICT_PHASE8_WALLET_REQUEST_HASH: HASH,
      ...patch,
    })).toThrow();
  });

  it("requires an exact canonical request hash only for send and comparison", () => {
    expect(() => readPhase8HarnessConfig({
      EDICT_PHASE8_MODE: "sandbox",
      EDICT_PHASE8_HOST: "127.0.0.1",
      EDICT_PHASE8_PORT: "43119",
      EDICT_PHASE8_ACTION: "WALLET_SEND",
      EDICT_PHASE8_RUN_ID: "run-1",
      EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
    })).toThrow();
  });
});

describe("Phase 8 bootstrap and request defenses", () => {
  it("consumes the bootstrap secret and rejects replay", async () => {
    const { runtime } = harness();
    const first = await runtime.handle(request("/session", { bootstrapSecret: SECRET }));
    expect(first.status).toBe(200);
    const replay = await runtime.handle(request("/session", { bootstrapSecret: SECRET }));
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({ ok: false, error: { code: "BOOTSTRAP_REFUSED" } });
  });

  it("expires an unused bootstrap secret", async () => {
    const state = harness();
    state.advance(5 * 60 * 1_000 + 1);
    expect((await state.runtime.handle(request("/session", { bootstrapSecret: SECRET }))).status).toBe(403);
  });

  it.each([
    ["Host", { host: "attacker.invalid" }, 403],
    ["Origin", { origin: "http://attacker.invalid" }, 403],
    ["content type", { "content-type": "text/plain" }, 400],
    ["declared body size", { "content-length": String(HARNESS_BODY_LIMIT_BYTES + 1) }, 400],
  ])("refuses invalid %s", async (_label, headers, status) => {
    const { runtime } = harness();
    expect((await runtime.handle(request("/session", { bootstrapSecret: SECRET }, headers))).status).toBe(status);
  });

  it("requires a valid session cookie and CSRF token", async () => {
    const { runtime } = harness();
    const auth = await session(runtime);
    const response = await runtime.handle(request("/arm", {
      csrfToken: "wrong-csrf-token-with-a-bounded-length",
      ...config().target,
    }, { cookie: auth.cookie }));
    expect(response.status).toBe(403);
  });

  it("issues only HttpOnly SameSite=Strict loopback HTTP cookies", async () => {
    const { runtime } = harness();
    const response = await runtime.handle(request("/session", { bootstrapSecret: SECRET }));
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
  });
});

describe("Phase 8 one-action grants", () => {
  it("requires separate Arm and Execute requests and consumes the grant once", async () => {
    const execute = vi.fn(async () => evidence());
    const { runtime } = harness({ execute });
    const auth = await session(runtime);
    expect(execute).not.toHaveBeenCalled();
    const grantId = await arm(runtime, auth);
    expect(execute).not.toHaveBeenCalled();
    const response = await runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await response.json()).category).toBe("WALLET_SEND");
    const replay = await runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    expect(replay.status).toBe(410);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not construct the selected action executor before Execute passes every gate", async () => {
    const executorFactory = vi.fn(() => ({ execute: vi.fn(async () => evidence()) }));
    const runtime = new Phase8HarnessRuntime({
      config: config(),
      bootstrap: new OneTimeBootstrapVerifier(SECRET, { nowMs: () => 1_000 }),
      executorFactory,
      clock: { nowMs: () => 1_000 },
    });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    expect(executorFactory).not.toHaveBeenCalled();
    await runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    expect(executorFactory).toHaveBeenCalledTimes(1);
  });

  it("does not create or imply the next action grant", async () => {
    const { runtime } = harness();
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const result = await (await runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }))).json();
    expect(JSON.stringify(result)).not.toContain("nextGrant");
    expect((await runtime.handle(request("/arm", {
      csrfToken: auth.csrfToken,
      ...config().target,
    }, { cookie: auth.cookie }))).status).toBe(410);
  });

  it("suppresses concurrent duplicate execute requests", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async () => { await pending; return evidence(); });
    const { runtime } = harness({ execute });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const executeRequest = () => runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    const first = executeRequest();
    const second = await executeRequest();
    expect(second.status).toBe(409);
    finish?.();
    await first;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never prints ok true for action or evidence-sanitization failures", async () => {
    for (const executor of [
      { execute: vi.fn(async () => { throw new Error("sensitive failure"); }) },
      { execute: vi.fn(async () => evidence({ apiKey: "must-not-return" })) },
    ]) {
      const { runtime } = harness(executor);
      const auth = await session(runtime);
      const grantId = await arm(runtime, auth);
      const response = await runtime.handle(request("/execute", {
        csrfToken: auth.csrfToken,
        grantId,
        confirmation: "EXECUTE",
      }, { cookie: auth.cookie }));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("ok\":true");
    }
  });

  it("bounds compatibility evidence and rejects accessors without invoking them", () => {
    let reads = 0;
    const accessor = evidence();
    Object.defineProperty(accessor, "details", {
      enumerable: true,
      get() {
        reads += 1;
        return {};
      },
    });
    expect(() => validatePhase8ActionEvidenceV1(accessor, config().target, [])).toThrow();
    expect(reads).toBe(0);
    expect(() => validatePhase8ActionEvidenceV1({
      ...evidence(),
      limitations: ["x".repeat(262_145)],
    }, config().target, [])).toThrow();
  });
});

describe("Phase 8 production isolation", () => {
  it("keeps the production route inventory at exactly five", () => {
    const root = path.resolve(__dirname, "../..");
    const routes: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.name === "route.ts") routes.push(path.relative(root, absolute));
      }
    };
    visit(path.join(root, "src/app"));
    expect(routes.sort()).toHaveLength(5);
    expect(routes.every((route) => route.startsWith("src/app/api/runs/"))).toBe(true);
  });

  it("puts no credential name or bootstrap value into the browser page", () => {
    const page = renderHarnessPage(config().target);
    expect(page).not.toMatch(/BRICKKEN_API_KEY|DATABASE_URL|EDICT_SEPOLIA_RPC_URL/);
    expect(page).not.toContain(SECRET);
  });

  it("constructs no transport and performs no request during module import", async () => {
    const originalFetch = globalThis.fetch;
    const spy = vi.fn(async () => { throw new Error("unexpected network"); });
    globalThis.fetch = spy;
    try {
      await import("./server");
      await import("./runtime");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires a real interactive TTY before generating or starting", async () => {
    await expect(runPhase8HarnessCli({
      environment: {},
      executorFactory: () => ({ execute: async () => evidence({ status: "unused" }) }),
      terminal: { isTTY: false, write: () => true },
    })).rejects.toThrow("PHASE8_INTERACTIVE_TTY_REQUIRED");
  });

  it("does not load environment files", () => {
    const directory = path.resolve(__dirname);
    for (const filename of fs.readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    )) {
      const content = fs.readFileSync(path.join(directory, filename), "utf8");
      expect(content, filename).not.toMatch(/dotenv|env-file-if-exists|NEXT_PUBLIC_/);
    }
  });
});
