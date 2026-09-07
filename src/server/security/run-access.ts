import "server-only";

import { z } from "zod";
import type { NonceSource, TokenClock } from "./tokens";
import { bytesToHex, DomainSeparatedTokenMac, SecurityTokenError } from "./tokens";

export const RUN_ACCESS_COOKIE = "__Host-edict_run_access";
export const RUN_ACCESS_DEV_COOKIE = "edict_run_access_dev";
export const RUN_ACCESS_MAX_AGE_SECONDS = 24 * 60 * 60;

const capabilitySchema = z.strictObject({
  version: z.literal("1.0"),
  purpose: z.literal("run-capability"),
  runId: z.string().uuid(),
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});

export interface RunAccessDependencies {
  readonly mac: DomainSeparatedTokenMac;
  readonly clock: TokenClock;
  readonly nonces: NonceSource;
}

export interface VerifiedRunAccess {
  readonly runId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface RunAccessCookiePolicy {
  readonly name: typeof RUN_ACCESS_COOKIE | typeof RUN_ACCESS_DEV_COOKIE;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "strict";
  readonly path: "/";
  readonly maxAge: number;
}

// Select only from explicit server configuration, never request host/forwarding headers.
// Callers must pass the origin gate before issuing or consuming either cookie.
export function runAccessCookieOptions(
  trustedOrigin?: string | null,
  runtimeEnvironment: string | undefined = process.env.NODE_ENV,
): Readonly<RunAccessCookiePolicy> {
  let localHttp = false;
  if (trustedOrigin && (runtimeEnvironment === "development" || runtimeEnvironment === "test")) {
    try {
      const url = new URL(trustedOrigin);
      localHttp = url.origin === trustedOrigin && url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        && url.username === "" && url.password === "";
    } catch { /* Unknown or malformed configuration retains the secure policy. */ }
  }
  return Object.freeze({
    name: localHttp ? RUN_ACCESS_DEV_COOKIE : RUN_ACCESS_COOKIE,
    httpOnly: true,
    secure: !localHttp,
    sameSite: "strict",
    path: "/",
    maxAge: RUN_ACCESS_MAX_AGE_SECONDS,
  });
}

/** A null value clears only the selected cookie, with the same scope and attributes. */
export function serializeRunAccessCookie(policy: RunAccessCookiePolicy, token: string | null): string {
  return `${policy.name}=${token ?? ""}; Path=${policy.path}; Max-Age=${token === null ? 0 : policy.maxAge}; HttpOnly${policy.secure ? "; Secure" : ""}; SameSite=Strict`;
}

export class RunAccessService {
  readonly #deps: RunAccessDependencies;

  constructor(deps: RunAccessDependencies) {
    this.#deps = deps;
  }

  async issue(runId: string): Promise<string> {
    const issuedAt = this.#deps.clock.nowEpochSeconds();
    return this.#deps.mac.sign("run-capability", {
      version: "1.0",
      purpose: "run-capability",
      runId,
      nonce: bytesToHex(this.#deps.nonces.bytes(32)),
      issuedAt,
      expiresAt: issuedAt + RUN_ACCESS_MAX_AGE_SECONDS,
    });
  }

  async verify(token: string | undefined, requestedRunId: string): Promise<VerifiedRunAccess> {
    if (!token) throw new SecurityTokenError();
    const payload = await this.#deps.mac.verify("run-capability", token, capabilitySchema);
    const now = this.#deps.clock.nowEpochSeconds();
    if (
      payload.runId !== requestedRunId ||
      payload.expiresAt <= now ||
      payload.issuedAt > now + 30 ||
      payload.expiresAt - payload.issuedAt !== RUN_ACCESS_MAX_AGE_SECONDS
    ) {
      throw new SecurityTokenError();
    }
    return Object.freeze({
      runId: payload.runId,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    });
  }
}
