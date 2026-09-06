import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OneTimeBootstrapVerifier } from "./auth";
import * as harnessAuth from "./auth";
import { runPhase8HarnessCli } from "./cli";
import { readPhase8HarnessConfig } from "./config";
import { phase8Response, PHASE8_JSON_HEADERS, PHASE8_HTML_HEADERS } from "./public-output";
import {
  BRICKKEN_READ_LIMITATIONS,
  BRICKKEN_READ_REDACTIONS,
  validatePhase8ActionEvidenceV1,
  type Phase8ActionEvidenceV1,
} from "./evidence";
import { HARNESS_BODY_LIMIT_BYTES, Phase8HarnessRuntime, renderHarnessPage } from "./runtime";
import type { Phase8ActionExecutor, Phase8HarnessConfig } from "./types";

const SECRET = "test-only-bootstrap-secret-with-at-least-32-characters";
const HASH = `sha256:${"a".repeat(64)}` as const;

function freezeForTest<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freezeForTest(descriptor.value);
  }
  return Object.freeze(value);
}

function config(): Phase8HarnessConfig {
  return Object.freeze({
    mode: "sandbox",
    host: "127.0.0.1",
    port: 43119,
    target: Object.freeze({
      action: "BRICKKEN_READ",
      runId: "run-1",
      operation: "TOKENIZE",
      walletRequestHash: null,
    }),
    allowedEnvironment: Object.freeze(Object.create(null) as Record<string, string>),
  });
}

function evidence(): Phase8ActionEvidenceV1 {
  const value: Phase8ActionEvidenceV1 = {
    evidenceVersion: "1.0",
    harnessVersion: "1.0",
    observedAt: "2026-09-04T12:00:00.000Z",
    action: "BRICKKEN_READ",
    runId: config().target.runId,
    operation: config().target.operation,
    walletRequestHash: null,
    evidenceStatus: "PASSED",
    resultFingerprint: "sha256:d54f68d3d3415f1b1ef4b923d428ed5be03bdf2f669eac7375cfcb0867ddb78a",
    details: {
      checkKind: "BRICKKEN_SANDBOX_NETWORK_INFO",
      checkVersion: "1.0",
      environment: "sandbox",
      requestedChainId: "11155111",
      currencyName: "Sepolia ETH",
      blockExplorerHost: "sepolia.etherscan.io",
      credentialBearingRequestSucceeded: true,
      resultCategory: "BRICKKEN_NETWORK_READ_PASSED",
      adapterVersion: "1.0",
      sdkVersion: "0.2.1",
    },
    limitations: [...BRICKKEN_READ_LIMITATIONS],
    redactions: [...BRICKKEN_READ_REDACTIONS],
  };
  return freezeForTest(value);
}

function unsafeEvidence(patch: Record<string, unknown>) {
  return { ...evidence(), ...patch } as unknown as Phase8ActionEvidenceV1;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
    expect((await response.json()).category).toBe("BRICKKEN_READ");
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
      { execute: vi.fn(async () => unsafeEvidence({ unexpected: "must-not-return" })) },
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

  it.each(["FAILED", "BLOCKED", "INCONCLUSIVE", "UNKNOWN"])(
    "never returns ok true for %s evidence",
    async (evidenceStatus) => {
      const { runtime } = harness({
        execute: vi.fn(async () => unsafeEvidence({ evidenceStatus })),
      });
      const auth = await session(runtime);
      const grantId = await arm(runtime, auth);
      const response = await runtime.handle(request("/execute", {
        csrfToken: auth.csrfToken,
        grantId,
        confirmation: "EXECUTE",
      }, { cookie: auth.cookie }));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ ok: false, error: { code: "ACTION_FAILED" } });
    },
  );

  it("awaits cleanup and never returns ok true when cleanup fails", async () => {
    let cleanupFinished = false;
    const { runtime } = harness({
      execute: vi.fn(async () => evidence()),
      cleanup: vi.fn(async () => {
        await Promise.resolve();
        cleanupFinished = true;
        throw new Error("sensitive cleanup failure");
      }),
    });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const response = await runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    expect(cleanupFinished).toBe(true);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: { code: "ACTION_FAILED" } });
  });

  it("bounds compatibility evidence and rejects accessors without invoking them", async () => {
    let reads = 0;
    const accessor = { ...evidence() } as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "details", {
      enumerable: true,
      get() {
        reads += 1;
        return {};
      },
    });
    await expect(validatePhase8ActionEvidenceV1(accessor, config().target, [])).rejects.toThrow();
    expect(reads).toBe(0);
    await expect(validatePhase8ActionEvidenceV1({
      ...evidence(),
      limitations: ["x".repeat(262_145)],
    }, config().target, [])).rejects.toThrow();
  });
});

describe("Phase 8 terminal Stop and deadline races", () => {
  async function executeRequest(
    runtime: Phase8HarnessRuntime,
    auth: Awaited<ReturnType<typeof session>>,
    grantId: string,
  ) {
    return runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
  }

  async function stop(
    runtime: Phase8HarnessRuntime,
    auth: Awaited<ReturnType<typeof session>>,
  ) {
    return runtime.handle(request("/stop", { csrfToken: auth.csrfToken }, { cookie: auth.cookie }));
  }

  it("makes Stop terminal while an Execute body is still being parsed", async () => {
    const execute = vi.fn(async () => evidence());
    const { runtime } = harness({ execute });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const payload = JSON.stringify({ csrfToken: auth.csrfToken, grantId, confirmation: "EXECUTE" });
    let release!: () => void;
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        };
      },
    });
    const pending = runtime.handle(new Request("http://127.0.0.1:43119/execute", {
      method: "POST",
      headers: {
        host: "127.0.0.1:43119",
        origin: "http://127.0.0.1:43119",
        "content-type": "application/json",
        "content-length": String(payload.length),
        cookie: auth.cookie,
      },
      body: bodyStream,
      duplex: "half",
    } as RequestInit));
    expect((await stop(runtime, auth)).status).toBe(200);
    release();
    expect((await pending).status).toBe(410);
    expect(execute).not.toHaveBeenCalled();
  });

  it("invalidates an asynchronous executor factory and cleans up its late result", async () => {
    const factoryStarted = deferred<void>();
    const factoryResult = deferred<Phase8ActionExecutor>();
    const cleanup = vi.fn(async () => undefined);
    const execute = vi.fn(async () => evidence());
    const runtime = new Phase8HarnessRuntime({
      config: config(),
      bootstrap: new OneTimeBootstrapVerifier(SECRET, { nowMs: () => 1_000 }),
      executorFactory: async () => {
        factoryStarted.resolve();
        return factoryResult.promise;
      },
      clock: { nowMs: () => 1_000 },
    });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const pending = executeRequest(runtime, auth, grantId);
    await factoryStarted.promise;
    await stop(runtime, auth);
    factoryResult.resolve({ execute, cleanup });
    expect((await pending).status).toBe(410);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts active execution and discards every late executor settlement", async () => {
    const started = deferred<void>();
    const result = deferred<Phase8ActionEvidenceV1>();
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (context) => {
      signal = context.signal;
      started.resolve();
      return result.promise;
    });
    const { runtime } = harness({ execute });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const pending = executeRequest(runtime, auth, grantId);
    await started.promise;
    await stop(runtime, auth);
    expect(signal?.aborted).toBe(true);
    expect((await pending).status).toBe(410);
    result.resolve(evidence());
    await Promise.resolve();
    expect((await executeRequest(runtime, auth, grantId)).status).toBe(410);
  });

  it("cannot return success when Stop races with evidence validation", async () => {
    const validationStarted = deferred<void>();
    const validationResult = deferred<Phase8ActionEvidenceV1>();
    const cleanup = vi.fn(async () => undefined);
    const runtime = new Phase8HarnessRuntime({
      config: config(),
      bootstrap: new OneTimeBootstrapVerifier(SECRET, { nowMs: () => 1_000 }),
      executorFactory: () => ({ execute: async () => evidence(), cleanup }),
      evidenceValidator: async () => {
        validationStarted.resolve();
        return validationResult.promise;
      },
      clock: { nowMs: () => 1_000 },
    });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const pending = executeRequest(runtime, auth, grantId);
    await validationStarted.promise;
    await stop(runtime, auth);
    validationResult.resolve(evidence());
    expect((await pending).status).toBe(410);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cannot return success when Stop races with cleanup", async () => {
    const cleanupStarted = deferred<void>();
    const cleanupResult = deferred<void>();
    const runtime = new Phase8HarnessRuntime({
      config: config(),
      bootstrap: new OneTimeBootstrapVerifier(SECRET, { nowMs: () => 1_000 }),
      executorFactory: () => ({
        execute: async () => evidence(),
        cleanup: async () => {
          cleanupStarted.resolve();
          return cleanupResult.promise;
        },
      }),
      clock: { nowMs: () => 1_000 },
    });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const pending = executeRequest(runtime, auth, grantId);
    await cleanupStarted.promise;
    await stop(runtime, auth);
    cleanupResult.resolve();
    expect((await pending).status).toBe(410);
  });

  it("makes an injected execution deadline terminal and ignores a late result", async () => {
    const started = deferred<void>();
    const result = deferred<Phase8ActionEvidenceV1>();
    let deadline: (() => void) | undefined;
    const runtime = new Phase8HarnessRuntime({
      config: config(),
      bootstrap: new OneTimeBootstrapVerifier(SECRET, { nowMs: () => 1_000 }),
      executorFactory: () => ({
        execute: async () => {
          started.resolve();
          return result.promise;
        },
      }),
      clock: { nowMs: () => 1_000 },
      executionDeadlineMs: 25,
      timers: {
        setTimeout: (callback) => {
          deadline = callback;
          return "deadline";
        },
        clearTimeout: () => undefined,
      },
    });
    const auth = await session(runtime);
    const grantId = await arm(runtime, auth);
    const pending = executeRequest(runtime, auth, grantId);
    await started.promise;
    deadline?.();
    expect((await pending).status).toBe(504);
    result.resolve(evidence());
    await Promise.resolve();
    expect((await executeRequest(runtime, auth, grantId)).status).toBe(410);
  });
});

describe("Phase 8 public metadata and trusted evidence", () => {
  it.each([
    ["whole run id", { BRICKKEN_API_KEY: "run-secret", EDICT_PHASE8_RUN_ID: "run-secret" }],
    ["partial run id", { BRICKKEN_API_KEY: "prefix-run-fragment-suffix", EDICT_PHASE8_RUN_ID: "run-fragment" }],
    ["operation", { BRICKKEN_API_KEY: "TOKEN", EDICT_PHASE8_OPERATION_KIND: "TOKENIZE" }],
    ["action", { BRICKKEN_API_KEY: "BRICKKEN", EDICT_PHASE8_ACTION: "BRICKKEN_READ" }],
    ["port", { BRICKKEN_API_KEY: "43119" }],
    ["one character", { BRICKKEN_API_KEY: "1" }],
  ])("refuses an API-key/public-metadata collision: %s", (_label, patch) => {
    const source = Object.assign({
      EDICT_PHASE8_MODE: "sandbox",
      EDICT_PHASE8_HOST: "127.0.0.1",
      EDICT_PHASE8_PORT: "43119",
      EDICT_PHASE8_ACTION: "BRICKKEN_READ",
      EDICT_PHASE8_RUN_ID: "run-default",
      EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
      BRICKKEN_API_KEY: "safe-key-with-no-public-overlap",
    }, patch);
    expect(() => readPhase8HarnessConfig(source)).toThrow("PHASE8_PUBLIC_METADATA_COLLISION");
  });

  it("refuses a configured secret reused as a request hash", () => {
    expect(() => readPhase8HarnessConfig({
      EDICT_PHASE8_MODE: "sandbox",
      EDICT_PHASE8_HOST: "127.0.0.1",
      EDICT_PHASE8_PORT: "43119",
      EDICT_PHASE8_ACTION: "WALLET_SEND",
      EDICT_PHASE8_RUN_ID: "run-default",
      EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
      EDICT_PHASE8_WALLET_REQUEST_HASH: HASH,
      DATABASE_URL: HASH,
    })).toThrow("PHASE8_PUBLIC_METADATA_COLLISION");
  });

  it("renders no target metadata before bootstrap authentication", () => {
    const page = renderHarnessPage();
    expect(page).not.toContain(config().target.runId);
    expect(page).not.toContain(config().target.action);
    expect(page).not.toContain(config().target.operation);
    expect(page).not.toContain(SECRET);
  });

  it.each([
    ["rendered page", "Authenticate to reveal"],
    ["HTML header", "nosniff"],
    ["JSON default header", "no-store"],
    ["cookie header", "HttpOnly"],
    ["serialized evidence", '"harnessVersion":"1.0"'],
    ["session response", "csrfToken"],
    ["Arm response", "grantId"],
    ["Execute response", "evidence"],
    ["error response", "ACTION_FAILED"],
  ])("refuses an API key colliding with %s metadata", (_label, apiKey) => {
    const unsafeConfig = Object.freeze({
      ...config(),
      allowedEnvironment: Object.freeze({ BRICKKEN_API_KEY: apiKey }),
    });
    expect(() => new Phase8HarnessRuntime({
      config: unsafeConfig,
      bootstrap: new OneTimeBootstrapVerifier(SECRET, { nowMs: () => 1_000 }),
      executorFactory: () => ({ execute: async () => evidence() }),
      clock: { nowMs: () => 1_000 },
    })).toThrow("PHASE8_PUBLIC_METADATA_COLLISION");
  });

  it("recomputes the strict fingerprint and rejects supplied alternatives", async () => {
    await expect(validatePhase8ActionEvidenceV1(evidence(), config().target, []))
      .resolves.toEqual(evidence());
    for (const patch of [
      { resultFingerprint: `sha256:${"0".repeat(64)}` },
      { resultFingerprint: `sha256:${"1".repeat(64)}`, observedAt: "2026-09-04T12:00:01.000Z" },
    ]) {
      const altered = structuredClone(evidence()) as Phase8ActionEvidenceV1;
      Object.assign(altered, patch);
      freezeForTest(altered);
      await expect(validatePhase8ActionEvidenceV1(altered, config().target, []))
        .rejects.toThrow("PHASE8_EVIDENCE_INVALID");
    }
  });

  it("rejects mutable, unknown, accessor-backed, and secret-colliding evidence", async () => {
    const mutable = structuredClone(evidence());
    const unknown = structuredClone(evidence()) as Phase8ActionEvidenceV1 & { rawResponse?: string };
    unknown.rawResponse = "forbidden";
    freezeForTest(unknown);
    await expect(validatePhase8ActionEvidenceV1(mutable, config().target, []))
      .rejects.toThrow("PHASE8_EVIDENCE_INVALID");
    await expect(validatePhase8ActionEvidenceV1(unknown, config().target, []))
      .rejects.toThrow("PHASE8_EVIDENCE_INVALID");
    await expect(validatePhase8ActionEvidenceV1(evidence(), config().target, ["sandbox"]))
      .rejects.toThrow("PHASE8_EVIDENCE_INVALID");
    await expect(validatePhase8ActionEvidenceV1(evidence(), config().target, ["box"]))
      .rejects.toThrow("PHASE8_EVIDENCE_INVALID");
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
    const page = renderHarnessPage();
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
      executorFactory: () => ({ execute: async () => evidence() }),
      terminal: { isTTY: false, write: () => true },
    })).rejects.toThrow("PHASE8_INTERACTIVE_TTY_REQUIRED");
  });

  it("does not load environment files", () => {
    const directory = path.resolve(__dirname);
    for (const filename of fs.readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    )) {
      const content = fs.readFileSync(path.join(directory, filename), "utf8");
      expect(content, filename).not.toMatch(/dotenv|env-file-if-exists/);
      if (filename !== "phase8-client-bundle-audit.ts") {
        expect(content, filename).not.toContain("NEXT_PUBLIC_");
      }
    }
  });
});


describe("Phase 8 final response containment", () => {
  it.each(["body", "header name", "header value"])("refuses an unforeseen dynamic collision in %s", (location) => {
    const secret = "synthetic-unforeseen-output-value";
    const headers = new Headers(PHASE8_JSON_HEADERS);
    if (location === "header name") headers.set(secret, "public");
    if (location === "header value") headers.set("x-result", secret);
    expect(() => phase8Response(200, location === "body" ? secret : "{}", headers, [secret]))
      .toThrow("PHASE8_OUTPUT_COLLISION");
  });

  it("makes a late generated-token collision terminal without a fallback response", async () => {
    const key = "synthetic-dynamic-token-collision-not-in-static-output";
    const executorFactory = vi.fn();
    const runtime = new Phase8HarnessRuntime({
      config: { ...config(), allowedEnvironment: Object.freeze({ BRICKKEN_API_KEY: key }) },
      bootstrap: new OneTimeBootstrapVerifier(SECRET, { nowMs: () => 1_000 }),
      executorFactory, clock: { nowMs: () => 1_000 },
    });
    const token = vi.spyOn(harnessAuth, "randomOpaqueToken").mockReturnValue(key);
    try {
      await expect(runtime.handle(request("/session", { bootstrapSecret: SECRET })))
        .rejects.toThrow("PHASE8_OUTPUT_COLLISION");
      expect(runtime.stopped).toBe(true);
      expect(executorFactory).not.toHaveBeenCalled();
    } finally { token.mockRestore(); }
  });

  it("checks the actual HTML and normalized default headers", async () => {
    expect(() => phase8Response(200, renderHarnessPage(), PHASE8_HTML_HEADERS, ["nosniff"]))
      .toThrow("PHASE8_OUTPUT_COLLISION");
    expect(() => phase8Response(400, "{}", PHASE8_JSON_HEADERS, ["no-store"]))
      .toThrow("PHASE8_OUTPUT_COLLISION");
    const response = phase8Response(200, renderHarnessPage(), PHASE8_HTML_HEADERS, ["safe-unique-synthetic-key"]);
    expect(await response.text()).toBe(renderHarnessPage());
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
