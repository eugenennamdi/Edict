import { describe, expect, it } from "vitest";
import { createValidRawManifest } from "@/core/test-fixtures";
import { ExecutionRunService } from "../execution/run-service";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import { DomainSeparatedTokenMac, type NonceSource, type TokenClock } from "../security/tokens";
import { RunAccessService, RUN_ACCESS_COOKIE } from "../security/run-access";
import { WalletApprovalService } from "../security/wallet-approval";
import type { RunApiRuntime } from "./runtime";
import { createRunHandler, getRunHandler } from "./handlers";

const config = { enabled: true, trustedOrigin: "https://edict.example" } as const;

function request(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: config.trustedOrigin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function createRuntime(): RunApiRuntime {
  let id = 0;
  const repository = new InMemoryExecutionRunRepository();
  const clock: Clock = { nowIso: () => "2026-09-04T12:00:00.000Z" };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () => `operation-${id++}`,
    eventId: () => `event-${id++}`,
  };
  const tokenClock: TokenClock = { nowEpochSeconds: () => 1_788_523_200 };
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
