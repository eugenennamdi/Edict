import { describe, expect, it, vi } from "vitest";
import { createValidRawManifest, TOKENIZER_ADDRESS } from "@/core/test-fixtures";
import type { BrickkenServerAdapter, PreparedOperation } from "../brickken/types";
import { BrickkenAdapterError } from "../brickken/errors";
import { ExecutionRunService } from "../execution/run-service";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { RepositoryRevisionConflictError } from "../execution/errors";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import { DomainSeparatedTokenMac, type NonceSource, type TokenClock } from "../security/tokens";
import { RunAccessService, RUN_ACCESS_COOKIE } from "../security/run-access";
import { WalletApprovalService } from "../security/wallet-approval";
import { ExecutionOrchestrator } from "../orchestration/service";
import { createPreparationOnlyBrickkenWriteGate } from "../orchestration/write-gate";
import type { RunApiRuntime } from "./runtime";
import { ExecutionV4Orchestrator } from "../orchestration";
import { createTrustedSepoliaRpcClient } from "../rpc";
import {
  createRunHandler,
  getRunHandler,
  approvalChallengeHandler,
  approveRunHandler,
  cancelRunHandler,
  prepareNextOperationHandler,
  walletAuthorizationHandler,
  ingestBroadcastHashHandler,
  recordBroadcastUnknownHandler,
} from "./handlers";

const config = { enabled: true, trustedOrigin: "https://edict.example" } as const;

function request(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: config.trustedOrigin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function createRuntime(tokenClock: TokenClock = { nowEpochSeconds: () => 1_788_523_200 }, repository = new InMemoryExecutionRunRepository()): RunApiRuntime {
  let id = 0;
  const clock: Clock = { nowIso: () => "2026-09-04T12:00:00.000Z" };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () => `operation-${id++}`,
    eventId: () => `event-${id++}`,
  };
  const nonces: NonceSource = { bytes: (length) => new Uint8Array(length).fill(7) };
  const mac = new DomainSeparatedTokenMac(new Uint8Array(32).fill(9));
  return {
    runs: new ExecutionRunService({ repository, clock, ids }),
    access: new RunAccessService({ mac, clock: tokenClock, nonces }),
    approvals: new WalletApprovalService({ mac, clock: tokenClock, nonces }),
    nowIso: clock.nowIso,
  };
}

describe("run API HTTP boundaries", () => {
  it("checks the deployment gate before reading a body or constructing runtime dependencies", async () => {
    let constructed = 0;
    const body = new ReadableStream({ pull() { throw new Error("body must not be read"); } });
    const result = await createRunHandler(new Request("https://edict.example/api/runs", { method: "POST", body, duplex: "half" } as RequestInit), {
      config: { enabled: false, trustedOrigin: null },
      runtime: () => { constructed += 1; throw new Error("must not construct"); },
    });
    expect(result.status).toBe(404);
    expect(constructed).toBe(0);
  });

  it("enforces exact origin, JSON content type, and the bounded creation body", async () => {
    const api = createRuntime();
    const wrongOrigin = request("https://edict.example/api/runs", { manifest: createValidRawManifest() }, { origin: "https://evil.example" });
    expect((await createRunHandler(wrongOrigin, { config, runtime: () => api })).status).toBe(403);
    const wrongType = request("https://edict.example/api/runs", { manifest: createValidRawManifest() }, { "content-type": "application/json; charset=utf-8" });
    expect((await createRunHandler(wrongType, { config, runtime: () => api })).status).toBe(400);
    const tooLarge = request("https://edict.example/api/runs", { manifest: createValidRawManifest() }, { "content-length": "20000" });
    expect((await createRunHandler(tooLarge, { config, runtime: () => api })).status).toBe(400);
  });

  it("creates a durable run, issues a hardened capability cookie, and omits approval proof fields", async () => {
    const api = createRuntime();
    const created = await createRunHandler(request("https://edict.example/api/runs", { manifest: createValidRawManifest() }), { config, runtime: () => api });
    expect(created.status).toBe(201);
    const cookie = created.headers.get("set-cookie")!;
    expect(cookie).toContain(`${RUN_ACCESS_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const token = cookie.split(";")[0]!.split("=").slice(1).join("=");
    const fetched = await getRunHandler(new Request("https://edict.example/api/runs/11111111-1111-4111-8111-111111111111", { headers: { origin: config.trustedOrigin, cookie: `${RUN_ACCESS_COOKIE}=${token}` } }), "11111111-1111-4111-8111-111111111111", { config, runtime: () => api });
    expect(fetched.status).toBe(200);
    const text = await fetched.text();
    const body = JSON.parse(text);
    expect(body.manifest.asset.name).toBe("Café Receivables");
    expect(body.plan.operations.map((operation: { id: string }) => operation.id)).toEqual([
      "tokenize",
      "confirm-tokenization",
      "whitelist-investor",
      "confirm-whitelist",
      "mint",
      "confirm-mint",
      "verify-deployment",
    ]);
    expect(body.run.revision).toBe(1);
    expect(text).not.toContain("publicSignature");
    expect(text).not.toContain("challengeNonce");
    expect(text).not.toContain("unsignedTransaction");
    expect(text).not.toContain('"events"');
    expect(text).not.toContain('"observations"');
  });

  it("returns independently complete and equivalent create and read planning records", async () => {
    const api = createRuntime();
    const created = await createRunHandler(request("https://edict.example/api/runs", { manifest: createValidRawManifest() }), { config, runtime: () => api });
    const createdBody = await created.clone().json();
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    const fetched = await getRunHandler(new Request(`https://edict.example/api/runs/${createdBody.run.id}`, { headers: { cookie } }), createdBody.run.id, { config, runtime: () => api });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(createdBody);
  });

  it("rejects an absent capability before revealing whether a run exists", async () => {
    const api = createRuntime();
    const result = await getRunHandler(new Request("https://edict.example/api/runs/11111111-1111-4111-8111-111111111111", { headers: { origin: config.trustedOrigin } }), "11111111-1111-4111-8111-111111111111", { config, runtime: () => api });
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("maps an unsafe server reconstruction to service unavailable without partial data", async () => {
    const api = createRuntime();
    const created = await createRunHandler(request("https://edict.example/api/runs", { manifest: createValidRawManifest() }), { config, runtime: () => api });
    const createdBody = await created.clone().json();
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    const durable = await api.runs.getRun(createdBody.run.id);
    vi.spyOn(api.runs, "getRun").mockResolvedValue({
      ...durable,
      planHash: `sha256:${"0".repeat(64)}`,
    });
    const fetched = await getRunHandler(new Request(`https://edict.example/api/runs/${durable.id}`, { headers: { cookie } }), durable.id, { config, runtime: () => api });
    expect(fetched.status).toBe(503);
    expect(await fetched.json()).toEqual({ ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
  });

  it("projects operation state without persisted approval, event, observation, or unsigned-transaction details", async () => {
    const api = createRuntime();
    const created = await createRunHandler(request("https://edict.example/api/runs", { manifest: createValidRawManifest() }), { config, runtime: () => api });
    const createdBody = await created.clone().json();
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    const initial = await api.runs.getRun(createdBody.run.id);
    const proof = createApprovalProofFixture(initial, "2026-09-04T12:00:00.000Z");
    const approved = await api.runs.approvePlan(initial.id, initial.revision, {
      planHash: initial.planHash,
      approvedByWallet: initial.requiredSigner.walletAddress,
      proof,
    });
    const preparing = await api.runs.beginPrepare(approved.id, approved.revision, "TOKENIZE");
    await api.runs.recordPrepared(preparing.id, preparing.revision, "TOKENIZE", {
      txId: "prepared-id",
      unsignedTransaction: {
        from: initial.requiredSigner.walletAddress,
        to: "0x3333333333333333333333333333333333333333",
        data: "0x1234",
        value: "0x0",
        nonce: "0x1",
        chainId: "0xaa36a7",
        type: "0x2",
        gasLimit: "0x5208",
        maxFeePerGas: "0x10",
        maxPriorityFeePerGas: "0x1",
      },
    });

    const fetched = await getRunHandler(new Request(`https://edict.example/api/runs/${initial.id}`, { headers: { cookie } }), initial.id, { config, runtime: () => api });
    expect(fetched.status).toBe(200);
    const text = await fetched.text();
    const body = JSON.parse(text);
    expect(body.run.approved).toBe(true);
    expect(body.run.operations[0].preparedTxId).toBe("prepared-id");
    expect(body.run.execution.preparationStatus).toBe("PREPARED_FOR_REVIEW");
    expect(body.run.execution.transactionReview).toMatchObject({
      preparedTransactionId: "prepared-id",
      walletConfirmation: "NOT_REQUESTED",
      calldataSemantics: "OPAQUE_SERVER_PREPARED",
      walletRequest: { data: "0x1234", to: "0x3333333333333333333333333333333333333333" },
    });
    expect(text).not.toContain("unsignedTransaction");
    expect(text).not.toContain("publicSignature");
    expect(text).not.toContain("challengeNonce");
    expect(text).not.toContain('"events"');
    expect(text).not.toContain('"observations"');
  });
});

describe("browser run reads", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  async function setup() {
    let now = 1_788_523_200;
    const repository = new InMemoryExecutionRunRepository();
    const api = createRuntime({ nowEpochSeconds: () => now }, repository);
    const options = { config, runtime: () => api };
    const created = await createRunHandler(request(`${config.trustedOrigin}/api/runs`, { manifest: createValidRawManifest() }), options);
    expect(created.status).toBe(201);
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    return { api, repository, options, cookie, expire: () => { now += 86400; } };
  }

  it.each<Record<string, string>>([
    {},
    { "sec-fetch-site": "same-origin", "content-type": "application/json" },
    { origin: config.trustedOrigin },
    { origin: config.trustedOrigin, "sec-fetch-site": "same-origin" },
  ])("accepts an authorized browser GET with headers %j without mutations", async (headers) => {
    const { api, repository, options, cookie } = await setup();
    const before = await api.runs.getRun(runId);
    const insert = vi.spyOn(repository, "create");
    const update = vi.spyOn(repository, "update");
    const response = await getRunHandler(new Request(`${config.trustedOrigin}/api/runs/${runId}`, { headers: { ...headers, cookie } as Record<string, string> }), runId, options);
    expect(response.status).toBe(200);
    expect((await response.json()).run.id).toBe(runId);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await api.runs.getRun(runId)).toEqual(before);
  });

  it.each<Record<string, string>>([
    { origin: "https://other.example" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { origin: config.trustedOrigin, "sec-fetch-site": "cross-site" },
  ])("refuses incompatible GET origin metadata %j before lookup", async (headers) => {
    const { api, options, cookie } = await setup();
    const lookup = vi.spyOn(api.runs, "getRun");
    const response = await getRunHandler(new Request(`${config.trustedOrigin}/api/runs/${runId}`, { headers: { ...headers, cookie } as Record<string, string> }), runId, options);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed", "expired", "cross-run"])("refuses %s capability before lookup even with claimed origin headers", async (kind) => {
    const { api, options, cookie, expire } = await setup();
    const lookup = vi.spyOn(api.runs, "getRun");
    if (kind === "expired") expire();
    const target = kind === "cross-run" ? "22222222-2222-4222-8222-222222222222" : runId;
    const headers = new Headers({ host: "edict.example", forwarded: "host=edict.example", "x-forwarded-host": "edict.example", referer: `${config.trustedOrigin}/` });
    if (kind !== "missing") headers.set("cookie", kind === "malformed" ? `${RUN_ACCESS_COOKIE}=invalid` : cookie);
    const response = await getRunHandler(new Request(`${config.trustedOrigin}/api/runs/${target}`, { headers }), target, options);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a malformed run locator before repository lookup", async () => {
    const { api, options, cookie } = await setup();
    const lookup = vi.spyOn(api.runs, "getRun");
    const response = await getRunHandler(new Request(`${config.trustedOrigin}/api/runs/not-a-run`, { headers: { cookie } }), "not-a-run", options);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([createRunHandler, approvalChallengeHandler, approveRunHandler, cancelRunHandler, prepareNextOperationHandler, walletAuthorizationHandler, ingestBroadcastHashHandler, recordBroadcastUnknownHandler])("retains exact origin validation for mutation handler %s", async (handler) => {
    let constructed = 0;
    const options = { config, runtime: () => { constructed++; throw new Error("Unexpected runtime"); } };
    for (const origin of [null, "https://other.example", "null", `${config.trustedOrigin}/`]) {
      const headers = new Headers({ "content-type": "application/json", "sec-fetch-site": "same-origin" });
      if (origin !== null) headers.set("origin", origin);
      const input = new Request(`${config.trustedOrigin}/api/runs/${runId}`, { method: "POST", headers, body: "{}" });
      const response = handler === createRunHandler ? await createRunHandler(input, options) : await (handler as typeof cancelRunHandler)(input, runId, options);
      expect(response.status).toBe(403);
    }
    expect(constructed).toBe(0);
  });
});

describe("V4 browser wallet run routes", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const walletIntentHash = `sha256:${"ab".repeat(32)}` as const;
  const txHash = `0x${"cd".repeat(32)}`;
  const envelope = {
    domain: "edict.send-authorized-envelope.v1" as const,
    expectedRevision: 9,
    invocationAttemptId: "inv-server-generated",
    walletIntentHash,
    requiredSigner: TOKENIZER_ADDRESS,
    chainRequirement: { decimalChainId: "11155111" as const, rpcChainId: "0xaa36a7" as const },
    walletRequest: {
      from: TOKENIZER_ADDRESS,
      to: "0x3333333333333333333333333333333333333333",
      data: "0x12345678",
      value: "0x0",
      nonce: "0x1",
      gas: "0x5208",
      type: "0x2" as const,
      maxFeePerGas: "0x10",
      maxPriorityFeePerGas: "0x1",
    },
  };

  async function setup() {
    const api = createRuntime();
    const created = await createRunHandler(
      request(`${config.trustedOrigin}/api/runs`, { manifest: createValidRawManifest() }),
      { config, runtime: () => api },
    );
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    const durable = await api.runs.getRun(runId);
    const walletExecution = {
      releaseSendAuthority: vi.fn(async () => ({ envelope, run: durable as never })),
      ingestBroadcastHash: vi.fn(async () => durable as never),
      recordBrowserBroadcastUnknown: vi.fn(async () => durable as never),
    };
    const runtime: RunApiRuntime = { ...api, walletExecution };
    const options = { config, runtime: () => runtime };
    const call = (
      handler: typeof walletAuthorizationHandler,
      suffix: string,
      body: unknown,
      suppliedCookie = cookie,
      headers: Record<string, string> = {},
    ) => handler(
      request(`${config.trustedOrigin}/api/runs/${runId}/${suffix}`, body, {
        cookie: suppliedCookie,
        "sec-fetch-site": "same-origin",
        ...headers,
      }),
      runId,
      options,
    );
    return { api, durable, cookie, walletExecution, runtime, options, call };
  }

  it("keeps production semantic authorization deny-all and returns no envelope", async () => {
    const value = await setup();
    const repository = new InMemoryExecutionRunRepository();
    const denied = new ExecutionV4Orchestrator({
      repository,
      clock: { nowIso: () => "2026-09-12T12:00:00.000Z" },
      ids: {
        runId: () => runId,
        operationId: () => "operation",
        eventId: () => "event",
        invocationAttemptId: () => "must-not-be-used",
      },
      rpc: createTrustedSepoliaRpcClient({ request: async () => { throw new Error("must not call RPC"); } }),
    });
    const response = await walletAuthorizationHandler(
      request(`${config.trustedOrigin}/api/runs/${runId}/wallet-authorization`, { expectedRevision: 1 }, {
        cookie: value.cookie,
        "sec-fetch-site": "same-origin",
      }),
      runId,
      { config, runtime: () => ({ ...value.api, walletExecution: denied }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "EXECUTION_AUTHORIZATION_UNAVAILABLE" },
    });
  });

  it("accepts only expectedRevision and never accepts browser-selected authority fields", async () => {
    const value = await setup();
    const success = await value.call(walletAuthorizationHandler, "wallet-authorization", { expectedRevision: 8 });
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ ok: true, envelope });
    expect(value.walletExecution.releaseSendAuthority).toHaveBeenCalledWith(runId, 8);

    for (const extra of ["invocationAttemptId", "operation", "to", "from", "data", "nonce", "gas", "chainId"]) {
      const response = await value.call(walletAuthorizationHandler, "wallet-authorization", {
        expectedRevision: 8,
        [extra]: "browser-selected",
      });
      expect(response.status, extra).toBe(400);
    }
    expect(value.walletExecution.releaseSendAuthority).toHaveBeenCalledTimes(1);
  });

  it("rejects missing/wrong capability, untrusted origin, malformed bodies, and stale revisions", async () => {
    const value = await setup();
    expect((await value.call(walletAuthorizationHandler, "wallet-authorization", { expectedRevision: 8 }, "")).status).toBe(403);
    expect((await value.call(walletAuthorizationHandler, "wallet-authorization", { expectedRevision: 8 }, `${RUN_ACCESS_COOKIE}=wrong`)).status).toBe(403);
    expect((await value.call(walletAuthorizationHandler, "wallet-authorization", { expectedRevision: 8 }, value.cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect((await value.call(walletAuthorizationHandler, "wallet-authorization", { expectedRevision: 0 })).status).toBe(400);
    vi.mocked(value.walletExecution.releaseSendAuthority).mockRejectedValueOnce(new RepositoryRevisionConflictError());
    expect((await value.call(walletAuthorizationHandler, "wallet-authorization", { expectedRevision: 7 })).status).toBe(409);
  });

  it("ingests exactly the four permitted hash fields and invokes no RPC or Brickken service", async () => {
    const value = await setup();
    const body = {
      expectedRevision: 9,
      invocationAttemptId: "inv-server-generated",
      walletIntentHash,
      txHash,
    };
    const response = await value.call(ingestBroadcastHashHandler, "broadcast-hash", body);
    expect(response.status).toBe(200);
    expect(value.walletExecution.ingestBroadcastHash).toHaveBeenCalledWith(runId, body);
    for (const extra of ["to", "from", "data", "nonce", "gas", "kind"]) {
      expect((await value.call(ingestBroadcastHashHandler, "broadcast-hash", { ...body, [extra]: "x" })).status).toBe(400);
    }
    expect((await value.call(ingestBroadcastHashHandler, "broadcast-hash", { ...body, txHash: "0x0" })).status).toBe(400);
  });

  it("accepts only bound browser ambiguity fields and a bounded reason enum", async () => {
    const value = await setup();
    const body = {
      expectedRevision: 9,
      invocationAttemptId: "inv-server-generated",
      walletIntentHash,
      reason: "PROVIDER_4001" as const,
    };
    expect((await value.call(recordBroadcastUnknownHandler, "broadcast-unknown", body)).status).toBe(200);
    expect(value.walletExecution.recordBrowserBroadcastUnknown).toHaveBeenCalledWith(runId, body);
    expect((await value.call(recordBroadcastUnknownHandler, "broadcast-unknown", { ...body, reason: "raw provider detail" })).status).toBe(400);
    expect((await value.call(recordBroadcastUnknownHandler, "broadcast-unknown", { ...body, error: { message: "secret" } })).status).toBe(400);
  });
});

const preparedOperation: PreparedOperation = {
  txId: "prepared-1",
  executionMode: "client-broadcast",
  transaction: {
    from: TOKENIZER_ADDRESS,
    to: "0x3333333333333333333333333333333333333333",
    data: "0x1234",
    value: "0x0",
    nonce: "0x1",
    chainId: "0xaa36a7",
    type: "0x2",
    gasLimit: "0x5208",
    maxFeePerGas: "0x10",
    maxPriorityFeePerGas: "0x1",
    gasPrice: null,
    normalizedChainId: "11155111",
    rawUnsigned: {
      from: TOKENIZER_ADDRESS,
      to: "0x3333333333333333333333333333333333333333",
      data: "0x1234",
      value: "0x0",
      nonce: "0x1",
      chainId: "0xaa36a7",
      type: "0x2",
      gasLimit: "0x5208",
      maxFeePerGas: "0x10",
      maxPriorityFeePerGas: "0x1",
    },
  },
};

function preparingAdapter(result: Awaited<ReturnType<BrickkenServerAdapter["prepareTokenization"]>> = { ok: true, value: preparedOperation }) {
  const prepareTokenization = vi.fn(async () => result);
  const unused = async () => { throw new Error("unused"); };
  return {
    prepareTokenization,
    value: {
      prepareTokenization,
      prepareWhitelist: unused,
      prepareMint: unused,
      confirmBroadcast: unused,
      getTransactionStatus: unused,
      getTokenInfo: unused,
      getTokenizerInfo: unused,
      getWhitelistStatus: unused,
      getBalanceAndWhitelist: unused,
      getNetworkInfo: unused,
    } as unknown as BrickkenServerAdapter,
  };
}

describe("explicit next-operation preparation API", () => {
  async function setup(input: { enabled?: boolean; adapter?: ReturnType<typeof preparingAdapter> } = {}) {
    const repository = new InMemoryExecutionRunRepository();
    const api = createRuntime(undefined, repository);
    const createdResponse = await createRunHandler(request(`${config.trustedOrigin}/api/runs`, { manifest: createValidRawManifest() }), { config, runtime: () => api });
    const cookie = createdResponse.headers.get("set-cookie")!.split(";")[0]!;
    const created = await api.runs.getRun("11111111-1111-4111-8111-111111111111");
    const approved = await api.runs.approvePlan(created.id, created.revision, {
      planHash: created.planHash,
      approvedByWallet: created.requiredSigner.walletAddress,
      proof: createApprovalProofFixture(created, "2026-09-04T12:00:00.000Z"),
    });
    const brickken = input.adapter ?? preparingAdapter();
    const runtime: RunApiRuntime = {
      ...api,
      execution: new ExecutionOrchestrator({
        repository,
        runs: api.runs,
        brickken: brickken.value,
        writeGate: createPreparationOnlyBrickkenWriteGate(input.enabled ?? true),
      }),
    };
    const options = { config, runtime: () => runtime };
    const prepare = (body: unknown, suppliedCookie = cookie) => prepareNextOperationHandler(
      request(`${config.trustedOrigin}/api/runs/${approved.id}/prepare`, body, { cookie: suppliedCookie }),
      approved.id,
      options,
    );
    return { repository, approved, brickken, prepare };
  }

  it("accepts only expectedRevision, advances exactly two revisions, and returns an immutable review without prompting", async () => {
    const value = await setup();
    const response = await value.prepare({ expectedRevision: value.approved.revision });
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.run.revision).toBe(value.approved.revision + 2);
    expect(body.run.execution).toMatchObject({
      preparationStatus: "PREPARED_FOR_REVIEW",
      transactionReview: {
        walletConfirmation: "NOT_REQUESTED",
        calldataSemantics: "OPAQUE_SERVER_PREPARED",
        walletRequest: { from: TOKENIZER_ADDRESS, to: "0x3333333333333333333333333333333333333333", data: "0x1234" },
      },
    });
    expect(body.run.operations[0].stage).toBe("PREPARED");
    expect(text).not.toMatch(/unsignedTransaction|rawUnsigned|publicSignature|challengeNonce|events|observations/);
    expect(value.brickken.prepareTokenization).toHaveBeenCalledOnce();
  });

  it("authorizes before body parsing and does not let the browser choose an operation", async () => {
    const value = await setup();
    expect((await value.prepare({ expectedRevision: value.approved.revision }, "")).status).toBe(403);
    expect((await value.prepare({ expectedRevision: value.approved.revision, operation: "MINT" })).status).toBe(400);
    expect(value.brickken.prepareTokenization).not.toHaveBeenCalled();
  });

  it("allows one CAS winner and one Brickken call for concurrent submissions", async () => {
    const value = await setup();
    const responses = await Promise.all([
      value.prepare({ expectedRevision: value.approved.revision }),
      value.prepare({ expectedRevision: value.approved.revision }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(value.brickken.prepareTokenization).toHaveBeenCalledOnce();
  });

  it("fails closed before mutation when preparation is disabled", async () => {
    const value = await setup({ enabled: false });
    const before = await value.repository.getById(value.approved.id);
    const response = await value.prepare({ expectedRevision: value.approved.revision });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: { code: "PREPARATION_DISABLED" } });
    expect(await value.repository.getById(value.approved.id)).toEqual(before);
    expect(value.brickken.prepareTokenization).not.toHaveBeenCalled();
  });

  it("turns an ambiguous adapter result into durable reconciliation without leaking upstream detail", async () => {
    const sensitive = "credential-shaped upstream detail";
    const adapter = preparingAdapter({ ok: false, error: new BrickkenAdapterError("INVALID_EXTERNAL_RESPONSE", sensitive) });
    const value = await setup({ adapter });
    const response = await value.prepare({ expectedRevision: value.approved.revision });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(sensitive);
    const durable = await value.repository.getById(value.approved.id);
    expect(durable).toMatchObject({ status: "RECONCILIATION_REQUIRED" });
    expect(durable.operations[0].stage).toBe("PREPARE_UNKNOWN");
    expect(adapter.prepareTokenization).toHaveBeenCalledOnce();
  });
});
