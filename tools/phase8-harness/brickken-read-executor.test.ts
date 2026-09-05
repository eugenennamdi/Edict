import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneTimeBootstrapVerifier } from "./auth";
import { runBrickkenReadHarnessCli } from "./brickken-read-cli";
import {
  BrickkenReadExecutorError,
  createBrickkenReadExecutor,
} from "./brickken-read-executor";
import { readPhase8HarnessConfig } from "./config";
import { Phase8HarnessRuntime } from "./runtime";
import { validatePhase8ActionEvidenceV1 } from "./evidence";
import type { BrickkenServerAdapter } from "../../src/server/brickken/types";
import type { AdapterDependencies } from "../../src/server/brickken/adapter";
import type { Phase8ActionContext } from "./types";

const BOOTSTRAP = "offline-bootstrap-secret-with-at-least-32-characters";
const API_KEY = "test-only-brickken-api-key-sentinel";
const ORIGIN = "http://127.0.0.1:43119";
const NOW = new Date("2026-09-05T12:00:00.000Z");

function environment(extra: Record<string, string | undefined> = {}) {
  return {
    EDICT_PHASE8_MODE: "sandbox",
    EDICT_PHASE8_HOST: "127.0.0.1",
    EDICT_PHASE8_PORT: "43119",
    EDICT_PHASE8_ACTION: "BRICKKEN_READ",
    EDICT_PHASE8_RUN_ID: "run-brickken-read-1",
    EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
    BRICKKEN_API_KEY: API_KEY,
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function request(pathname: string, value: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(value);
  return new Request(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:43119",
      origin: ORIGIN,
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(payload).byteLength),
      ...headers,
    },
    body: payload,
  });
}

async function establish(runtime: Phase8HarnessRuntime) {
  const response = await runtime.handle(request("/session", { bootstrapSecret: BOOTSTRAP }));
  const body = await response.json() as { ok: true; csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected test session cookie.");
  return { csrfToken: body.csrfToken, cookie };
}

async function arm(
  runtime: Phase8HarnessRuntime,
  auth: Awaited<ReturnType<typeof establish>>,
) {
  const target = readPhase8HarnessConfig(environment()).target;
  const response = await runtime.handle(request("/arm", {
    csrfToken: auth.csrfToken,
    ...target,
  }, { cookie: auth.cookie }));
  const body = await response.json() as { ok: true; grantId: string };
  return body.grantId;
}

function runtime(input: {
  readonly fetch: typeof fetch;
  readonly onFactory?: () => void;
}) {
  const config = readPhase8HarnessConfig(environment({
    DATABASE_URL: "postgresql://discarded.invalid/database",
    EDICT_SEPOLIA_RPC_URL: "https://discarded.invalid/rpc",
    EDICT_RUN_SECURITY_SECRET: "discarded-run-secret",
    NEXT_PUBLIC_BRICKKEN_API_KEY: "discarded-public-value",
  }));
  return {
    config,
    runtime: new Phase8HarnessRuntime({
      config,
      bootstrap: new OneTimeBootstrapVerifier(BOOTSTRAP, { nowMs: () => NOW.getTime() }),
      executorFactory: () => {
        input.onFactory?.();
        return createBrickkenReadExecutor({ fetch: input.fetch, now: () => NOW });
      },
      clock: { nowMs: () => NOW.getTime() },
    }),
  };
}

function successResponse(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    currencyName: "Sepolia ETH",
    blockExplorerUrl: "https://sepolia.etherscan.io",
    ...extra,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeAdapter(result: unknown, methodCalls: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const forbidden = () => vi.fn(async () => {
    throw new Error("Forbidden adapter method called.");
  });
  const adapter = {
    prepareTokenization: methodCalls.prepareTokenization ?? forbidden(),
    prepareWhitelist: methodCalls.prepareWhitelist ?? forbidden(),
    prepareMint: methodCalls.prepareMint ?? forbidden(),
    confirmBroadcast: methodCalls.confirmBroadcast ?? forbidden(),
    getTransactionStatus: methodCalls.getTransactionStatus ?? forbidden(),
    getTokenInfo: methodCalls.getTokenInfo ?? forbidden(),
    getTokenizerInfo: methodCalls.getTokenizerInfo ?? forbidden(),
    getWhitelistStatus: methodCalls.getWhitelistStatus ?? forbidden(),
    getBalanceAndWhitelist: methodCalls.getBalanceAndWhitelist ?? forbidden(),
    getNetworkInfo: methodCalls.getNetworkInfo ?? vi.fn(async () => result),
  } as unknown as BrickkenServerAdapter;
  return { adapter, methodCalls: Object.fromEntries(Object.entries(adapter)) };
}

describe("BRICKKEN_READ lifecycle and wire contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs nothing and makes no request at module import or action-specific CLI startup", async () => {
    const originalFetch = globalThis.fetch;
    const network = vi.fn(async () => { throw new Error("Unexpected network request."); });
    globalThis.fetch = network;
    try {
      vi.resetModules();
      await import("./brickken-read-executor");
      expect(network).not.toHaveBeenCalled();

      let capturedFactory: (() => unknown) | undefined;
      const runner = vi.fn(async (input: Parameters<typeof import("./cli").runPhase8HarnessCli>[0]) => {
        capturedFactory = input.executorFactory;
        return {
          close: async () => undefined,
          address: { address: "127.0.0.1", port: 43119, family: "IPv4" },
        };
      });
      await runBrickkenReadHarnessCli({
        environment: environment({
          EDICT_PHASE8_ACTION: "WALLET_SEND",
          DATABASE_URL: "must-be-discarded",
          EDICT_SEPOLIA_RPC_URL: "must-be-discarded",
        }),
        terminal: { isTTY: true, write: () => true },
        harnessRunner: runner,
      });
      expect(network).not.toHaveBeenCalled();
      expect(capturedFactory).toBeTypeOf("function");
      const passedEnvironment = runner.mock.calls[0]?.[0].environment;
      expect(passedEnvironment).toEqual({
        EDICT_PHASE8_MODE: "sandbox",
        EDICT_PHASE8_HOST: "127.0.0.1",
        EDICT_PHASE8_PORT: "43119",
        EDICT_PHASE8_ACTION: "BRICKKEN_READ",
        EDICT_PHASE8_RUN_ID: "run-brickken-read-1",
        EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
        BRICKKEN_API_KEY: API_KEY,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts the bounded normalized projection through the real adapter and fake transport", async () => {
    const config = readPhase8HarnessConfig(environment());
    const executor = createBrickkenReadExecutor({
      fetch: vi.fn(async () => successResponse()),
      now: () => NOW,
    });
    await expect(executor.execute({
      target: config.target,
      allowedEnvironment: config.allowedEnvironment,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      evidenceStatus: "PASSED",
      details: { credentialBearingRequestSucceeded: true },
    });
  });

  it("makes exactly one credential-bearing GET only after session, Arm, and valid Execute", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let factories = 0;
    const state = runtime({
      onFactory: () => { factories += 1; },
      fetch: vi.fn(async (input, init) => {
        requests.push({ url: String(input), init });
        return successResponse();
      }),
    });

    expect(requests).toHaveLength(0);
    expect(factories).toBe(0);
    const auth = await establish(state.runtime);
    expect(requests).toHaveLength(0);
    const grantId = await arm(state.runtime, auth);
    expect(requests).toHaveLength(0);
    expect(factories).toBe(0);

    const response = await state.runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    expect(response.status).toBe(200);
    expect(factories).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.sandbox.brickken.com/get-network-info?chainId=11155111",
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(new Headers(requests[0]?.init?.headers).get("x-api-key")).toBe(API_KEY);

    const output = await response.json();
    expect(output).toMatchObject({
      ok: true,
      category: "BRICKKEN_READ",
      evidence: {
        evidenceStatus: "PASSED",
        resultFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        details: {
          resultCategory: "BRICKKEN_NETWORK_READ_PASSED",
          requestedChainId: "11155111",
          currencyName: "Sepolia ETH",
          blockExplorerHost: "sepolia.etherscan.io",
        },
      },
    });
    expect(JSON.stringify(output)).not.toContain(API_KEY);

    const duplicate = await state.runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    expect(duplicate.status).toBe(410);
    expect(requests).toHaveLength(1);
  });

  it("passes only the narrowed key and fixed sandbox configuration to the adapter factory", async () => {
    const factory = vi.fn((_dependencies: AdapterDependencies) => {
      void _dependencies;
      return fakeAdapter({
        ok: true,
        value: { currencyName: "Sepolia ETH", blockExplorerHost: "sepolia.etherscan.io" },
      }).adapter;
    });
    const executor = createBrickkenReadExecutor({ adapterFactory: factory, now: () => NOW });
    const config = readPhase8HarnessConfig(environment({
      DATABASE_URL: "must-not-pass",
      EDICT_SEPOLIA_RPC_URL: "must-not-pass",
      UNRELATED_SECRET: "must-not-pass",
    }));

    const evidence = await executor.execute({
      target: config.target,
      allowedEnvironment: config.allowedEnvironment,
    });

    expect(Object.keys(config.allowedEnvironment)).toEqual(["BRICKKEN_API_KEY"]);
    expect(evidence.resultFingerprint).toBe(
      "sha256:d54f68d3d3415f1b1ef4b923d428ed5be03bdf2f669eac7375cfcb0867ddb78a",
    );
    await expect(validatePhase8ActionEvidenceV1(
      evidence,
      config.target,
      Object.values(config.allowedEnvironment),
    )).resolves.toEqual(evidence);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      runtimeConfig: {
        apiKey: API_KEY,
        baseUrl: "https://api.sandbox.brickken.com",
        chainId: "11155111",
      },
    });
    expect(factory.mock.calls[0]?.[0].fetch).toBeTypeOf("function");
  });

  it("calls no prepare, send, status, database, RPC, wallet, confirmation, polling, or read-back method", async () => {
    const read = vi.fn(async () => ({
      ok: true as const,
      value: { currencyName: "Sepolia ETH", blockExplorerHost: "sepolia.etherscan.io" },
    }));
    const state = fakeAdapter({}, { getNetworkInfo: read });
    const executor = createBrickkenReadExecutor({
      adapterFactory: () => state.adapter,
      now: () => NOW,
    });
    const config = readPhase8HarnessConfig(environment());

    await executor.execute({ target: config.target, allowedEnvironment: config.allowedEnvironment });

    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({ chainId: "11155111" });
    for (const [name, method] of Object.entries(state.methodCalls)) {
      if (name !== "getNetworkInfo") expect(method).not.toHaveBeenCalled();
    }
  });

  it("fails before adapter construction for malformed key, action, or narrowed environment", async () => {
    const factory = vi.fn((_dependencies: AdapterDependencies) => {
      void _dependencies;
      return fakeAdapter({}).adapter;
    });
    const base = readPhase8HarnessConfig(environment());
    const cases: Phase8ActionContext[] = [
      { target: base.target, allowedEnvironment: {} },
      { target: base.target, allowedEnvironment: { BRICKKEN_API_KEY: ` ${API_KEY}` } },
      { target: base.target, allowedEnvironment: { BRICKKEN_API_KEY: `${API_KEY}\r\n` } },
      { target: base.target, allowedEnvironment: { BRICKKEN_API_KEY: `${API_KEY}\u0000` } },
      { target: base.target, allowedEnvironment: { BRICKKEN_API_KEY: `${API_KEY}\u007f` } },
      { target: base.target, allowedEnvironment: { BRICKKEN_API_KEY: `${API_KEY}é` } },
      { target: base.target, allowedEnvironment: { BRICKKEN_API_KEY: API_KEY, DATABASE_URL: "x" } },
      { target: { ...base.target, action: "BRICKKEN_PREPARE" as const }, allowedEnvironment: base.allowedEnvironment },
    ];

    for (const context of cases) {
      const executor = createBrickkenReadExecutor({ adapterFactory: factory, now: () => NOW });
      await expect(executor.execute(context)).rejects.toMatchObject({
        code: "BRICKKEN_NETWORK_READ_FAILED",
      });
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("aborts on its independent deadline and discards late settlement", async () => {
    vi.useFakeTimers();
    let settle: ((value: unknown) => void) | undefined;
    const operation = new Promise((resolve) => { settle = resolve; });
    let observedSignal: AbortSignal | undefined;
    const factory = vi.fn((dependencies: AdapterDependencies) => {
      observedSignal = undefined;
      void dependencies.fetch?.("https://api.sandbox.brickken.com/get-network-info?chainId=11155111", {
        method: "GET",
        headers: { "x-api-key": API_KEY },
      }).catch(() => undefined);
      return fakeAdapter(operation).adapter;
    });
    const executor = createBrickkenReadExecutor({
      adapterFactory: factory,
      fetch: vi.fn(async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return operation as Promise<Response>;
      }),
      deadlineMs: 25,
      now: () => NOW,
    });
    const config = readPhase8HarnessConfig(environment());
    const pending = executor.execute({
      target: config.target,
      allowedEnvironment: config.allowedEnvironment,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "BRICKKEN_NETWORK_READ_FAILED",
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(observedSignal?.aborted).toBe(true);
    settle?.({
      ok: true,
      value: { currencyName: "Sepolia ETH", blockExplorerHost: "sepolia.etherscan.io" },
    });
    await Promise.resolve();
    vi.useRealTimers();
  });

  it("stopping before Execute prevents adapter construction and requests", async () => {
    const fetch = vi.fn(async () => successResponse());
    let factories = 0;
    const state = runtime({ fetch, onFactory: () => { factories += 1; } });
    const auth = await establish(state.runtime);
    await arm(state.runtime, auth);
    const stopped = await state.runtime.handle(request("/stop", {
      csrfToken: auth.csrfToken,
    }, { cookie: auth.cookie }));
    expect(stopped.status).toBe(200);
    expect(factories).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts bounded response parsing when Stop races with the transport", async () => {
    const reading = deferred<void>();
    const cancelled = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve();
      },
      cancel: cancelled,
    }, { highWaterMark: 0 });
    const state = runtime({
      fetch: vi.fn(async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Response(body, { headers: { "content-type": "application/json" } });
      }),
    });
    const auth = await establish(state.runtime);
    const grantId = await arm(state.runtime, auth);
    const pending = state.runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    await reading.promise;

    const stopped = await state.runtime.handle(request("/stop", {
      csrfToken: auth.csrfToken,
    }, { cookie: auth.cookie }));

    expect(stopped.status).toBe(200);
    expect((await pending).status).toBe(410);
    expect(observedSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  });
});

describe("BRICKKEN_READ fail-closed evidence", () => {
  it("rejects wrong-network observations with a stable sanitized code", async () => {
    const executor = createBrickkenReadExecutor({
      adapterFactory: () => fakeAdapter({
        ok: true,
        value: { currencyName: "Ethereum", blockExplorerHost: "etherscan.io" },
      }).adapter,
      now: () => NOW,
    });
    const config = readPhase8HarnessConfig(environment());
    await expect(executor.execute({
      target: config.target,
      allowedEnvironment: config.allowedEnvironment,
    })).rejects.toEqual(new BrickkenReadExecutorError("BRICKKEN_NETWORK_CHAIN_MISMATCH"));
  });

  it.each([
    ["malformed", { ok: true, value: { currencyName: 42, blockExplorerHost: null } }],
    ["oversized", { ok: true, value: { currencyName: "x".repeat(4_097), blockExplorerHost: null } }],
    ["unexpected", {
      ok: true,
      value: {
        currencyName: "Sepolia ETH",
        blockExplorerHost: "sepolia.etherscan.io",
        rawResponse: "forbidden",
      },
    }],
  ])("rejects a %s normalized adapter response", async (_label, result) => {
    const executor = createBrickkenReadExecutor({
      adapterFactory: () => fakeAdapter(result).adapter,
      now: () => NOW,
    });
    const config = readPhase8HarnessConfig(environment());
    await expect(executor.execute({
      target: config.target,
      allowedEnvironment: config.allowedEnvironment,
    })).rejects.toMatchObject({ code: "BRICKKEN_NETWORK_RESPONSE_INVALID" });
  });

  it("rejects cyclic and accessor-backed responses without invoking accessors", async () => {
    let reads = 0;
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.value = cyclic;
    const accessor = { ok: true };
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        reads += 1;
        return { currencyName: "Sepolia ETH", blockExplorerHost: "sepolia.etherscan.io" };
      },
    });
    const config = readPhase8HarnessConfig(environment());

    for (const result of [cyclic, accessor]) {
      const executor = createBrickkenReadExecutor({
        adapterFactory: () => fakeAdapter(result).adapter,
        now: () => NOW,
      });
      await expect(executor.execute({
        target: config.target,
        allowedEnvironment: config.allowedEnvironment,
      })).rejects.toMatchObject({ code: "BRICKKEN_NETWORK_RESPONSE_INVALID" });
    }
    expect(reads).toBe(0);
  });

  it("returns only a generic HTTP failure and emits no sensitive values or logs", async () => {
    const sensitiveValues = [
      API_KEY,
      "tokenizer-sensitive@example.invalid",
      "0x1111111111111111111111111111111111111111",
      "run-capability-sensitive-value",
      "signature-sensitive-value",
      "authorization-sensitive-value",
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const fetch = vi.fn(async () => successResponse({
      rawResponse: sensitiveValues,
      headers: { authorization: sensitiveValues[5] },
    }));
    const state = runtime({ fetch });
    const auth = await establish(state.runtime);
    const grantId = await arm(state.runtime, auth);
    const response = await state.runtime.handle(request("/execute", {
      csrfToken: auth.csrfToken,
      grantId,
      confirmation: "EXECUTE",
    }, { cookie: auth.cookie }));
    const output = await response.text();

    expect(response.status).toBe(502);
    expect(output).toBe('{"ok":false,"error":{"code":"ACTION_FAILED"}}');
    for (const value of sensitiveValues) expect(output).not.toContain(value);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  it("keeps the live smoke excluded and the executor outside production imports", () => {
    const root = path.resolve(__dirname, "../..");
    const vitest = fs.readFileSync(path.join(root, "vitest.config.mts"), "utf8");
    expect(vitest).toContain("**/live-read.smoke.test.ts");

    for (const filename of fs.readdirSync(path.join(root, "src"), { recursive: true })) {
      const relative = String(filename);
      if (!/\.(?:ts|tsx)$/.test(relative)) continue;
      const content = fs.readFileSync(path.join(root, "src", relative), "utf8");
      expect(content, relative).not.toContain("brickken-read-executor");
      expect(content, relative).not.toContain("brickken-read-cli");
    }
  });
});
