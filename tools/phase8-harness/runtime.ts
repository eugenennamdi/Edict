import {
  SESSION_TTL_MS,
  matchesTokenDigest,
  randomOpaqueToken,
  tokenDigest,
  type HarnessClock,
  type OneTimeBootstrapVerifier,
} from "./auth";
import {
  assertNoSensitiveOutputCollision,
  assertPhase8PublicMetadataSafe,
  expectedHarnessOrigin,
} from "./config";
import { validatePhase8ActionEvidenceV1 } from "./evidence";
import {
  PHASE8_STATIC_PUBLIC_OUTPUTS, renderHarnessPage, PHASE8_COOKIE_NAME,
  PHASE8_JSON_HEADERS, PHASE8_HTML_HEADERS, phase8SessionHeaders, phase8Bodies,
  phase8Response, phase8PublicOutputsForTarget, type Phase8PublicError,
} from "./public-output";
import { Phase8OutputCollisionError } from "./safe-terminal";
import type { Phase8ActionExecutor, Phase8HarnessConfig } from "./types";

export { renderHarnessPage } from "./public-output";

export const HARNESS_BODY_LIMIT_BYTES = 65_536;
export const HARNESS_EXECUTION_DEADLINE_MS = 30_000;
const COOKIE_NAME = PHASE8_COOKIE_NAME;

export interface Phase8HarnessTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMERS: Phase8HarnessTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

interface SessionRecord {
  readonly sessionDigest: string;
  readonly csrfDigest: string;
  readonly expiresAt: number;
}

interface Grant {
  readonly idDigest: string;
  readonly sessionDigest: string;
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
  readonly #executorFactory: () => Phase8ActionExecutor | Promise<Phase8ActionExecutor>;
  readonly #clock: HarnessClock;
  readonly #timers: Phase8HarnessTimers;
  readonly #executionDeadlineMs: number;
  readonly #evidenceValidator: typeof validatePhase8ActionEvidenceV1;
  #session: SessionRecord | null = null;
  #grant: Grant | null = null;
  #executionStarted = false;
  #stopped = false;
  #generation = 0;
  #activeAbort: AbortController | null = null;
  #terminalReason: "STOPPED" | "DEADLINE" | "FAILED" | "SUCCEEDED" | null = null;

  constructor(input: {
    readonly config: Phase8HarnessConfig;
    readonly bootstrap: OneTimeBootstrapVerifier;
    readonly executorFactory: () => Phase8ActionExecutor | Promise<Phase8ActionExecutor>;
    readonly clock: HarnessClock;
    readonly timers?: Phase8HarnessTimers;
    readonly executionDeadlineMs?: number;
    readonly evidenceValidator?: typeof validatePhase8ActionEvidenceV1;
  }) {
    assertPhase8PublicMetadataSafe(input.config);
    assertNoSensitiveOutputCollision(
      [...PHASE8_STATIC_PUBLIC_OUTPUTS, ...phase8PublicOutputsForTarget(input.config.target)],
      Object.values(input.config.allowedEnvironment),
    );
    const deadline = input.executionDeadlineMs ?? HARNESS_EXECUTION_DEADLINE_MS;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 300_000) {
      throw new Error("PHASE8_CONFIGURATION_INVALID");
    }
    this.#config = input.config;
    this.#bootstrap = input.bootstrap;
    this.#executorFactory = input.executorFactory;
    this.#clock = input.clock;
    this.#timers = input.timers ?? DEFAULT_TIMERS;
    this.#executionDeadlineMs = deadline;
    this.#evidenceValidator = input.evidenceValidator ?? validatePhase8ActionEvidenceV1;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  #response(status: number, body: string, headers: HeadersInit): Response {
    try {
      return phase8Response(status, body, headers, Object.values(this.#config.allowedEnvironment));
    } catch (error) {
      if (error instanceof Phase8OutputCollisionError) this.#terminate("FAILED");
      throw error;
    }
  }

  #json(status: number, responseBody: unknown, headers: HeadersInit = {}): Response {
    const merged = new Headers(PHASE8_JSON_HEADERS);
    new Headers(headers).forEach((value, name) => merged.set(name, value));
    return this.#response(status, JSON.stringify(responseBody), merged);
  }

  #fail(status: number, code: Phase8PublicError): Response {
    return this.#json(status, phase8Bodies.error(code));
  }

  badRequestResponse(): Response {
    return this.#fail(400, "BAD_REQUEST");
  }

  async handle(request: Request): Promise<Response> {
    try {
      if (this.#stopped) return this.#fail(410, "HARNESS_STOPPED");
      const origin = expectedHarnessOrigin(this.#config);
      const expectedHost = new URL(origin).host;
      if (request.headers.get("host") !== expectedHost) return this.#fail(403, "HOST_REFUSED");
      const requestOrigin = request.headers.get("origin");
      if ((request.method === "GET" && requestOrigin !== null && requestOrigin !== origin) ||
          (request.method !== "GET" && requestOrigin !== origin)) {
        return this.#fail(403, "ORIGIN_REFUSED");
      }
      const url = new URL(request.url);
      if (url.origin !== origin) return this.#fail(403, "ORIGIN_REFUSED");
      if (request.method === "GET" && url.pathname === "/") {
        return this.#response(200, renderHarnessPage(), PHASE8_HTML_HEADERS);
      }
      if (request.method !== "POST") return this.#fail(404, "NOT_FOUND");
      const parsed = await body(request);
      if (this.#stopped) return this.#fail(410, "HARNESS_STOPPED");
      if (url.pathname === "/session") return this.#establish(parsed);
      const authenticated = this.#authenticate(request, parsed);
      if (authenticated === null) return this.#fail(403, "SESSION_REFUSED");
      if (this.#stopped) return this.#fail(410, "HARNESS_STOPPED");
      if (url.pathname === "/arm") return this.#arm(parsed, authenticated);
      if (url.pathname === "/execute") return this.#execute(parsed, authenticated);
      if (url.pathname === "/stop") {
        if (!exactKeys(parsed, ["csrfToken"])) return this.#fail(400, "BAD_REQUEST");
        this.#terminate("STOPPED");
        return this.#json(200, phase8Bodies.stopped());
      }
      return this.#fail(404, "NOT_FOUND");
    } catch (error) {
      if (error instanceof Phase8OutputCollisionError) throw error;
      return this.#fail(400, "BAD_REQUEST");
    }
  }

  #establish(parsed: Record<string, unknown>): Response {
    if (!exactKeys(parsed, ["bootstrapSecret"]) || this.#session !== null ||
        !this.#bootstrap.consume(parsed.bootstrapSecret)) {
      return this.#fail(403, "BOOTSTRAP_REFUSED");
    }
    const sessionToken = randomOpaqueToken();
    const csrfToken = randomOpaqueToken();
    this.#session = {
      sessionDigest: tokenDigest(sessionToken),
      csrfDigest: tokenDigest(csrfToken),
      expiresAt: this.#clock.nowMs() + SESSION_TTL_MS,
    };
    return this.#json(200, phase8Bodies.session(csrfToken, this.#config.target), phase8SessionHeaders(sessionToken));
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
      return this.#fail(409, "ARM_REFUSED");
    }
    const id = randomOpaqueToken();
    this.#grant = { idDigest: tokenDigest(id), sessionDigest: session.sessionDigest };
    if (this.#stopped) return this.#fail(410, "HARNESS_STOPPED");
    return this.#json(200, phase8Bodies.arm(id, this.#config.target));
  }

  #terminate(reason: "STOPPED" | "DEADLINE" | "FAILED" | "SUCCEEDED"): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#terminalReason = reason;
    this.#grant = null;
    this.#generation += 1;
    this.#activeAbort?.abort();
    this.#activeAbort = null;
  }

  #assertActive(generation: number): void {
    if (this.#stopped || this.#generation !== generation) {
      throw new Error("PHASE8_EXECUTION_TERMINATED");
    }
  }

  async #awaitActive<T>(
    promise: Promise<T>,
    generation: number,
    signal: AbortSignal,
  ): Promise<T> {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("PHASE8_EXECUTION_TERMINATED"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([promise, aborted]);
      this.#assertActive(generation);
      return result;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #execute(parsed: Record<string, unknown>, session: SessionRecord): Promise<Response> {
    if (!exactKeys(parsed, ["confirmation", "csrfToken", "grantId"]) ||
        parsed.confirmation !== "EXECUTE" || typeof parsed.grantId !== "string" ||
        this.#grant === null || this.#executionStarted ||
        this.#grant.sessionDigest !== session.sessionDigest ||
        !matchesTokenDigest(parsed.grantId, this.#grant.idDigest)) {
      return this.#fail(409, "EXECUTE_REFUSED");
    }
    this.#executionStarted = true;
    this.#grant = null;
    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#activeAbort = abort;
    const deadline = this.#timers.setTimeout(() => {
      if (!this.#stopped && this.#generation === generation) this.#terminate("DEADLINE");
    }, this.#executionDeadlineMs);
    let executor: Phase8ActionExecutor | undefined;
    try {
      const factoryPromise = Promise.resolve().then(() => this.#executorFactory());
      try {
        executor = await this.#awaitActive(factoryPromise, generation, abort.signal);
      } catch (error) {
        void factoryPromise.then((lateExecutor) => lateExecutor.cleanup?.()).catch(() => undefined);
        throw error;
      }
      this.#assertActive(generation);
      let evidence;
      try {
        const rawEvidence = await this.#awaitActive(executor.execute({
          target: this.#config.target,
          allowedEnvironment: this.#config.allowedEnvironment,
          signal: abort.signal,
        }), generation, abort.signal);
        this.#assertActive(generation);
        evidence = await this.#awaitActive(this.#evidenceValidator(
          rawEvidence,
          this.#config.target,
          Object.values(this.#config.allowedEnvironment),
        ), generation, abort.signal);
        this.#assertActive(generation);
      } finally {
        await this.#awaitActive(
          Promise.resolve().then(() => executor?.cleanup?.()),
          generation,
          abort.signal,
        );
      }
      this.#assertActive(generation);
      const result = phase8Bodies.execute(this.#config.target.action, evidence);
      this.#assertActive(generation);
      this.#terminate("SUCCEEDED");
      return this.#json(200, result);
    } catch (error) {
      if (error instanceof Phase8OutputCollisionError) throw error;
      const reason = this.#terminalReason;
      if (!this.#stopped) this.#terminate("FAILED");
      if (reason === "STOPPED") return this.#fail(410, "HARNESS_STOPPED");
      if (reason === "DEADLINE") return this.#fail(504, "ACTION_DEADLINE_EXCEEDED");
      return this.#fail(502, "ACTION_FAILED");
    } finally {
      this.#timers.clearTimeout(deadline);
      if (this.#activeAbort === abort) this.#activeAbort = null;
    }
  }
}
