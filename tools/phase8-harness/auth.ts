import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const BOOTSTRAP_SECRET_TTL_MS = 5 * 60 * 1_000;
export const SESSION_TTL_MS = 15 * 60 * 1_000;

export interface HarnessClock {
  nowMs(): number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class OneTimeBootstrapVerifier {
  readonly #digest: Buffer;
  readonly #expiresAt: number;
  readonly #clock: HarnessClock;
  #consumed = false;

  constructor(secret: string, clock: HarnessClock, ttlMs = BOOTSTRAP_SECRET_TTL_MS) {
    if (secret.length < 32 || secret.length > 256 || ttlMs <= 0) {
      throw new Error("PHASE8_BOOTSTRAP_INVALID");
    }
    this.#digest = digest(secret);
    this.#expiresAt = clock.nowMs() + ttlMs;
    this.#clock = clock;
  }

  consume(candidate: unknown): boolean {
    if (this.#consumed || this.#clock.nowMs() > this.#expiresAt ||
        typeof candidate !== "string" || candidate.length < 32 || candidate.length > 256) {
      return false;
    }
    const candidateDigest = digest(candidate);
    const matches = timingSafeEqual(this.#digest, candidateDigest);
    candidateDigest.fill(0);
    if (!matches) return false;
    this.#consumed = true;
    this.#digest.fill(0);
    return true;
  }
}

export function createBootstrapSecret(clock: HarnessClock): {
  readonly secret: string;
  readonly verifier: OneTimeBootstrapVerifier;
} {
  const bytes = randomBytes(32);
  const secret = bytes.toString("base64url");
  bytes.fill(0);
  return { secret, verifier: new OneTimeBootstrapVerifier(secret, clock) };
}

export function randomOpaqueToken(): string {
  const bytes = randomBytes(32);
  const token = bytes.toString("base64url");
  bytes.fill(0);
  return token;
}

export function tokenDigest(token: string): string {
  return digest(token).toString("hex");
}

export function matchesTokenDigest(token: string, expectedHex: string): boolean {
  const actual = digest(token);
  const expected = Buffer.from(expectedHex, "hex");
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
  actual.fill(0);
  expected.fill(0);
  return matches;
}
