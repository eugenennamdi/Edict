import { afterEach, describe, expect, it, vi } from "vitest";
import { createValidRawManifest } from "@/core/test-fixtures";
import { ExecutionRunService } from "../execution/run-service";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { DomainSeparatedTokenMac, SecurityTokenError } from "../security/tokens";
import { RunAccessService, RUN_ACCESS_COOKIE, RUN_ACCESS_DEV_COOKIE, runAccessCookieOptions, serializeRunAccessCookie } from "../security/run-access";
import { WalletApprovalService } from "../security/wallet-approval";
import { createRunHandler, getRunHandler, cancelRunHandler, type RunApiHandlerOptions } from "./handlers";
import { readRunApiDeploymentConfig } from "./config";

const localOrigin = "http://localhost:3000";
const httpsOrigin = "https://edict.example";

function setup(origin = localOrigin, nodeEnv = "development") {
  let now = 1788740000, nextRun = 0, nextOperation = 0;
  const repository = new InMemoryExecutionRunRepository();
  const clock = { nowEpochSeconds: () => now };
  const nonces = { bytes: (length: number) => new Uint8Array(length).fill(7) };
  const access = (fill: number) => new RunAccessService({ mac: new DomainSeparatedTokenMac(new Uint8Array(32).fill(fill)), clock, nonces });
  const api = {
    runs: new ExecutionRunService({ repository, clock: { nowIso: () => "2026-09-07T12:00:00.000Z" }, ids: {
      runId: () => `${String(++nextRun).padStart(8, "0")}-1111-4111-8111-111111111111`,
      operationId: () => `operation-${++nextOperation}`, eventId: () => `event-${++nextOperation}`,
    } }),
    access: access(9), approvals: new WalletApprovalService({ mac: new DomainSeparatedTokenMac(new Uint8Array(32).fill(9)), clock, nonces }),
    nowIso: () => "2026-09-07T12:00:00.000Z",
  };
  const options: RunApiHandlerOptions = { config: readRunApiDeploymentConfig({ EDICT_RUN_API_ENABLED: "1", EDICT_TRUSTED_ORIGIN: origin }), nodeEnv, runtime: () => api };
  const post = (path: string, body: unknown, cookie?: string, requestOrigin: string | null = origin) => new Request(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...(requestOrigin === null ? {} : { origin: requestOrigin }), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  return { origin, api, options, post, repository,
    expire: () => { now += 86400; }, rotate: () => { api.access = access(8); },
    create: () => createRunHandler(post("/api/runs", { manifest: createValidRawManifest() }), options),
    get: (id: string, cookie?: string, overrides?: Partial<RunApiHandlerOptions>) => getRunHandler(new Request(`${origin}/api/runs/${id}`, { headers: { "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) } }), id, { ...options, ...overrides }),
  };
}

// Deliberately models a user agent without an HTTP-loopback Secure-cookie exception.
// This checks portable HTTP behavior; it is not a claim about a particular Chrome version.
function acceptCookie(header: string, origin: string): string | undefined {
  const parts = header.split("; ");
  const secure = parts.includes("Secure");
  if (secure && new URL(origin).protocol !== "https:") return undefined;
  if (parts[0].startsWith("__Host-") && (!secure || !parts.includes("Path=/") || parts.some((part) => part.startsWith("Domain=")))) return undefined;
  if (parts.includes("Max-Age=0")) return undefined;
  return parts[0];
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("run capability cookie policy", () => {
  it.each(["production", "development", "test"])("retains every HTTPS cookie protection in %s", (mode) => {
    const policy = runAccessCookieOptions(httpsOrigin, mode);
    expect(policy).toEqual({ name: RUN_ACCESS_COOKIE, httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 86400 });
    expect(serializeRunAccessCookie(policy, "synthetic")).toBe("__Host-edict_run_access=synthetic; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict");
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])("uses a distinct HTTP cookie only for explicit loopback configuration %s", (origin) => {
    const policy = runAccessCookieOptions(origin, "development");
    expect(policy).toEqual({ name: RUN_ACCESS_DEV_COOKIE, httpOnly: true, secure: false, sameSite: "strict", path: "/", maxAge: 86400 });
    expect(serializeRunAccessCookie(policy, "synthetic")).toBe("edict_run_access_dev=synthetic; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict");
  });

  it.each([undefined, null, "http://localhost:3000/", "http://localhost.evil.example", "http://example.com", "http://user:pass@localhost:3000", "not-an-origin"])("never derives the exception from missing or invalid configuration %#", (origin) => {
    expect(runAccessCookieOptions(origin, "development").secure).toBe(true);
  });

  it.each(["production", "unknown"])("never issues an insecure cookie in %s even for HTTP localhost", (mode) => {
    expect(runAccessCookieOptions(localOrigin, mode).name).toBe(RUN_ACCESS_COOKIE);
    expect(runAccessCookieOptions(localOrigin, mode).secure).toBe(true);
  });

  it.each([[localOrigin, "development", RUN_ACCESS_DEV_COOKIE], [httpsOrigin, "production", RUN_ACCESS_COOKIE]])("clears exactly the selected cookie with matching scope %#", (origin, mode, name) => {
    const header = serializeRunAccessCookie(runAccessCookieOptions(origin, mode), null);
    expect(header.startsWith(`${name}=;`)).toBe(true);
    expect(header).toContain("Max-Age=0; HttpOnly");
    expect(header.includes("; Secure")).toBe(mode === "production");
    expect(header).toContain("Path=/"); expect(header).toContain("SameSite=Strict");
    expect(header).not.toContain("Domain=");
    expect(acceptCookie(header, origin)).toBeUndefined();
  });
});

describe("offline browser create → immediate read contract", () => {
  it("reproduces strict HTTP cookie rejection and fixes create → immediate GET → cancel without network or logs", async () => {
    const network = vi.fn(() => { throw new Error("Unexpected network"); }); vi.stubGlobal("fetch", network);
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    expect(acceptCookie(serializeRunAccessCookie(runAccessCookieOptions(), "synthetic"), localOrigin)).toBeUndefined();
    const h = setup();
    const insert = vi.spyOn(h.repository, "create");
    const created = await h.create();
    expect(created.status).toBe(201); expect(insert).toHaveBeenCalledTimes(1);
    const header = created.headers.get("set-cookie")!;
    const cookie = acceptCookie(header, h.origin);
    expect(Boolean(cookie)).toBe(true);
    expect(cookie?.startsWith(`${RUN_ACCESS_DEV_COOKIE}=`)).toBe(true);
    const bodyText = await created.text(); const body = JSON.parse(bodyText);
    const value = cookie!.slice(cookie!.indexOf("=") + 1);
    expect(bodyText.includes(value)).toBe(false);
    const fetched = await h.get(body.run.id, cookie);
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).run.id).toBe(body.run.id);
    expect(fetched.headers.get("cache-control")).toContain("no-store");
    expect(fetched.headers.has("access-control-allow-origin")).toBe(false);
    const canceled = await cancelRunHandler(h.post(`/api/runs/${body.run.id}/cancel`, { expectedRevision: body.run.revision }, cookie), body.run.id, h.options);
    expect(canceled.status).toBe(200);
    const canceledText = await canceled.text(); expect(canceledText.includes(value)).toBe(false);
    expect(JSON.parse(canceledText).run.terminalOutcome).toBe("CANCELLED");
    expect((await h.get(body.run.id, cookie)).status).toBe(200);
    expect(network).not.toHaveBeenCalled(); logs.forEach((log) => expect(log).not.toHaveBeenCalled());
  });

  it("supports refresh and a second-tab-equivalent read without mutating revision", async () => {
    const h = setup();
    const created = await h.create();
    const body = await created.json();
    const cookie = acceptCookie(created.headers.get("set-cookie")!, h.origin);
    const update = vi.spyOn(h.repository, "update");
    const firstRead = await h.get(body.run.id, cookie);
    const secondRead = await h.get(body.run.id, cookie);
    expect(firstRead.status).toBe(200);
    expect(secondRead.status).toBe(200);
    const firstBody = await firstRead.json();
    const secondBody = await secondRead.json();
    expect(firstBody).toEqual(secondBody);
    expect(firstBody.manifest).toEqual(body.manifest);
    expect(firstBody.plan.operations).toHaveLength(7);
    expect(firstBody.run.revision).toBe(body.run.revision);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([[httpsOrigin, "production"], [localOrigin, "production"], [httpsOrigin, "development"], [localOrigin, "development"]])("reads only its selected name with no alternate-name fallback %#", async (origin, mode) => {
    const h = setup(origin, mode); const response = await h.create();
    expect(response.status).toBe(201);
    const id = (await response.json()).run.id;
    const selected = runAccessCookieOptions(origin, mode).name;
    const pair = response.headers.get("set-cookie")!.split(";")[0];
    const alternate = selected === RUN_ACCESS_COOKIE ? RUN_ACCESS_DEV_COOKIE : RUN_ACCESS_COOKIE;
    const wrong = alternate + pair.slice(pair.indexOf("="));
    expect((await h.get(id, wrong)).status).toBe(403);
    expect((await h.get(id, `${selected}=invalid; ${wrong}`)).status).toBe(403);
    expect((await h.get(id, pair)).status).toBe(200);
  });

  it.each(["expired", "malformed", "rotated", "cross-run"])("refuses %s local capabilities before repository lookup", async (kind) => {
    const h = setup(); const created = await h.create();
    let cookie = created.headers.get("set-cookie")!.split(";")[0];
    let id = (await created.json()).run.id;
    if (kind === "expired") h.expire();
    if (kind === "rotated") h.rotate();
    if (kind === "malformed") cookie = `${RUN_ACCESS_DEV_COOKIE}=invalid`;
    if (kind === "cross-run") id = "22222222-2222-4222-8222-222222222222";
    const lookup = vi.spyOn(h.repository, "getById");
    expect((await h.get(id, cookie)).status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([null, "http://localhost:3001", "https://evil.example"])("refuses a missing or wrong mutation origin before issuing any cookie %#", async (origin) => {
    const h = setup(); const create = vi.spyOn(h.repository, "create");
    const response = await createRunHandler(h.post("/api/runs", { manifest: createValidRawManifest() }, undefined, origin), h.options);
    expect(response.status).toBe(403); expect(response.headers.has("set-cookie")).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("replaces the single active browser cookie when creating another run", async () => {
    const h = setup(); const first = await h.create(); const firstId = (await first.json()).run.id;
    const second = await h.create(); const secondId = (await second.json()).run.id;
    const cookie = acceptCookie(second.headers.get("set-cookie")!, h.origin);
    expect((await h.get(firstId, cookie)).status).toBe(403);
    expect((await h.get(secondId, cookie)).status).toBe(200);
  });

  it("distinguishes a pre-creation security failure from browser cookie rejection", async () => {
    const h = setup(); const insert = vi.spyOn(h.repository, "create");
    const response = await createRunHandler(h.post("/api/runs", { manifest: createValidRawManifest() }), { ...h.options, runtime: () => { throw new SecurityTokenError(); } });
    expect(response.status).toBe(403); expect(response.headers.has("set-cookie")).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});
