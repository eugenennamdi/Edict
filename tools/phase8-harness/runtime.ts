import {
  SESSION_TTL_MS,
  matchesTokenDigest,
  randomOpaqueToken,
  tokenDigest,
  type HarnessClock,
  type OneTimeBootstrapVerifier,
} from "./auth";
import { expectedHarnessOrigin } from "./config";
import { validatePhase8ActionEvidenceV1 } from "./evidence";
import type { Phase8ActionExecutor, Phase8HarnessConfig } from "./types";

export const HARNESS_BODY_LIMIT_BYTES = 65_536;
const COOKIE_NAME = "edict_phase8_session";

interface SessionRecord {
  readonly sessionDigest: string;
  readonly csrfDigest: string;
  readonly expiresAt: number;
}

interface Grant {
  readonly idDigest: string;
  readonly sessionDigest: string;
}

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(status: number, code: string): Response {
  return json(status, { ok: false, error: { code } });
}

function cookieValue(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (cookie === null || cookie.length > 4_096) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type") !== "application/json") throw new Error("BAD_BODY");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > HARNESS_BODY_LIMIT_BYTES)) {
    throw new Error("BAD_BODY");
  }
  if (request.body === null) throw new Error("BAD_BODY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > HARNESS_BODY_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error("BAD_BODY");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
      throw new Error("BAD_BODY");
    }
    return parsed as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export class Phase8HarnessRuntime {
  readonly #config: Phase8HarnessConfig;
  readonly #bootstrap: OneTimeBootstrapVerifier;
  readonly #executorFactory: () => Phase8ActionExecutor;
  readonly #clock: HarnessClock;
  #session: SessionRecord | null = null;
  #grant: Grant | null = null;
  #executionStarted = false;
  #stopped = false;

  constructor(input: {
    readonly config: Phase8HarnessConfig;
    readonly bootstrap: OneTimeBootstrapVerifier;
    readonly executorFactory: () => Phase8ActionExecutor;
    readonly clock: HarnessClock;
  }) {
    this.#config = input.config;
    this.#bootstrap = input.bootstrap;
    this.#executorFactory = input.executorFactory;
    this.#clock = input.clock;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  async handle(request: Request): Promise<Response> {
    try {
      if (this.#stopped) return fail(410, "HARNESS_STOPPED");
      const origin = expectedHarnessOrigin(this.#config);
      const expectedHost = new URL(origin).host;
      if (request.headers.get("host") !== expectedHost) return fail(403, "HOST_REFUSED");
      const requestOrigin = request.headers.get("origin");
      if ((request.method === "GET" && requestOrigin !== null && requestOrigin !== origin) ||
          (request.method !== "GET" && requestOrigin !== origin)) {
        return fail(403, "ORIGIN_REFUSED");
      }
      const url = new URL(request.url);
      if (url.origin !== origin) return fail(403, "ORIGIN_REFUSED");
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(renderHarnessPage(this.#config.target), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (request.method !== "POST") return fail(404, "NOT_FOUND");
      const parsed = await body(request);
      if (url.pathname === "/session") return this.#establish(parsed);
      const authenticated = this.#authenticate(request, parsed);
      if (authenticated === null) return fail(403, "SESSION_REFUSED");
      if (url.pathname === "/arm") return this.#arm(parsed, authenticated);
      if (url.pathname === "/execute") return this.#execute(parsed, authenticated);
      if (url.pathname === "/stop") {
        if (!exactKeys(parsed, ["csrfToken"])) return fail(400, "BAD_REQUEST");
        this.#stopped = true;
        this.#grant = null;
        return json(200, { ok: true, category: "HARNESS_STOPPED" });
      }
      return fail(404, "NOT_FOUND");
    } catch {
      return fail(400, "BAD_REQUEST");
    }
  }

  #establish(parsed: Record<string, unknown>): Response {
    if (!exactKeys(parsed, ["bootstrapSecret"]) || this.#session !== null ||
        !this.#bootstrap.consume(parsed.bootstrapSecret)) {
      return fail(403, "BOOTSTRAP_REFUSED");
    }
    const sessionToken = randomOpaqueToken();
    const csrfToken = randomOpaqueToken();
    this.#session = {
      sessionDigest: tokenDigest(sessionToken),
      csrfDigest: tokenDigest(csrfToken),
      expiresAt: this.#clock.nowMs() + SESSION_TTL_MS,
    };
    return json(200, { ok: true, csrfToken, target: this.#config.target }, {
      "set-cookie": `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1_000}`,
    });
  }

  #authenticate(request: Request, parsed: Record<string, unknown>): SessionRecord | null {
    const token = cookieValue(request);
    const csrf = parsed.csrfToken;
    if (this.#session === null || this.#clock.nowMs() > this.#session.expiresAt ||
        typeof token !== "string" || typeof csrf !== "string" ||
        token.length > 256 || csrf.length > 256 ||
        !matchesTokenDigest(token, this.#session.sessionDigest) ||
        !matchesTokenDigest(csrf, this.#session.csrfDigest)) return null;
    return this.#session;
  }

  #arm(parsed: Record<string, unknown>, session: SessionRecord): Response {
    if (!exactKeys(parsed, ["action", "csrfToken", "operation", "runId", "walletRequestHash"]) ||
        this.#grant !== null || this.#executionStarted ||
        parsed.action !== this.#config.target.action || parsed.runId !== this.#config.target.runId ||
        parsed.operation !== this.#config.target.operation ||
        parsed.walletRequestHash !== this.#config.target.walletRequestHash) {
      return fail(409, "ARM_REFUSED");
    }
    const id = randomOpaqueToken();
    this.#grant = { idDigest: tokenDigest(id), sessionDigest: session.sessionDigest };
    return json(200, { ok: true, grantId: id, target: this.#config.target });
  }

  async #execute(parsed: Record<string, unknown>, session: SessionRecord): Promise<Response> {
    if (!exactKeys(parsed, ["confirmation", "csrfToken", "grantId"]) ||
        parsed.confirmation !== "EXECUTE" || typeof parsed.grantId !== "string" ||
        this.#grant === null || this.#executionStarted ||
        this.#grant.sessionDigest !== session.sessionDigest ||
        !matchesTokenDigest(parsed.grantId, this.#grant.idDigest)) {
      return fail(409, "EXECUTE_REFUSED");
    }
    this.#executionStarted = true;
    this.#grant = null;
    try {
      const executor = this.#executorFactory();
      const rawEvidence = await executor.execute({
        target: this.#config.target,
        allowedEnvironment: this.#config.allowedEnvironment,
      });
      const evidence = validatePhase8ActionEvidenceV1(
        rawEvidence,
        this.#config.target,
        Object.values(this.#config.allowedEnvironment),
      );
      this.#stopped = true;
      return json(200, { ok: true, category: this.#config.target.action, evidence });
    } catch {
      this.#stopped = true;
      return fail(502, "ACTION_FAILED");
    }
  }
}

export function renderHarnessPage(target: Phase8HarnessConfig["target"]): string {
  const publicTarget = JSON.stringify(target).replaceAll("<", "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>Edict Phase 8 Harness</title>
<style>body{font:16px system-ui;max-width:52rem;margin:3rem auto;padding:0 1rem}button,input{font:inherit;margin:.4rem;padding:.6rem}pre{white-space:pre-wrap}</style>
<h1>Edict Phase 8 one-action harness</h1><p id="target"></p>
<label>One-time bootstrap secret <input id="secret" type="password" autocomplete="off" maxlength="256"></label>
<button id="login">Establish session</button><button id="arm" disabled>Arm exact action</button>
<button id="execute" disabled>Execute once</button><button id="stop" disabled>Stop</button><pre id="status"></pre>
<script>'use strict';const target=${publicTarget};let csrfToken=null,grantId=null;
const status=document.getElementById('status');document.getElementById('target').textContent=JSON.stringify(target);
async function post(path,value){const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(value)});const result=await response.json();status.textContent=JSON.stringify(result);return result}
document.getElementById('login').onclick=async()=>{const input=document.getElementById('secret');const result=await post('/session',{bootstrapSecret:input.value});input.value='';if(result.ok){csrfToken=result.csrfToken;document.getElementById('arm').disabled=false;document.getElementById('stop').disabled=false}};
document.getElementById('arm').onclick=async()=>{const result=await post('/arm',{csrfToken,...target});if(result.ok){grantId=result.grantId;document.getElementById('execute').disabled=false;document.getElementById('arm').disabled=true}};
document.getElementById('execute').onclick=async()=>{document.getElementById('execute').disabled=true;await post('/execute',{csrfToken,grantId,confirmation:'EXECUTE'})};
document.getElementById('stop').onclick=async()=>{await post('/stop',{csrfToken})};</script>`;
}
