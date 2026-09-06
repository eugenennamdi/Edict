import { describe, expect, it, vi } from "vitest";
import { createValidRawManifest } from "@/core/test-fixtures";
import { ExecutionRunService } from "../execution/run-service";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import { DomainSeparatedTokenMac, type NonceSource, type TokenClock } from "../security/tokens";
import { RunAccessService, RUN_ACCESS_COOKIE } from "../security/run-access";
import { WalletApprovalService } from "../security/wallet-approval";
import type { RunApiRuntime } from "./runtime";
import { createRunHandler, getRunHandler, approvalChallengeHandler, approveRunHandler, cancelRunHandler } from "./handlers";

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
    expect(text).not.toContain("publicSignature");
    expect(text).not.toContain("challengeNonce");
  });

  it("rejects an absent capability before revealing whether a run exists", async () => {
    const api = createRuntime();
    const result = await getRunHandler(new Request("https://edict.example/api/runs/11111111-1111-4111-8111-111111111111", { headers: { origin: config.trustedOrigin } }), "11111111-1111-4111-8111-111111111111", { config, runtime: () => api });
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
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

  it.each([createRunHandler, approvalChallengeHandler, approveRunHandler, cancelRunHandler])("retains exact origin validation for mutation handler %s", async (handler) => {
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
