import "server-only";

import { z } from "zod";
import type { NonceSource, TokenClock } from "./tokens";
import { bytesToHex, DomainSeparatedTokenMac, SecurityTokenError } from "./tokens";

export const RUN_ACCESS_COOKIE = "__Host-edict_run_access";
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

export function runAccessCookieOptions(): Readonly<{
  httpOnly: true;
  secure: true;
  sameSite: "strict";
  path: "/";
  maxAge: number;
}> {
  return Object.freeze({
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: RUN_ACCESS_MAX_AGE_SECONDS,
  });
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
