import "server-only";

import { z } from "zod";

const encoder = new TextEncoder();
const TOKEN_VERSION = "v1";

export type TokenPurpose = "approval-challenge" | "run-capability";

export interface TokenClock {
  nowEpochSeconds(): number;
}

export interface NonceSource {
  bytes(length: number): Uint8Array;
}

export class SecurityTokenError extends Error {
  readonly code = "SECURITY_TOKEN_INVALID";

  constructor() {
    super("The security token is missing, invalid, or expired.");
    this.name = "SecurityTokenError";
  }
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SecurityTokenError();
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function importHmacKey(value: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    value,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function derivePurposeKey(secret: Uint8Array, purpose: TokenPurpose): Promise<CryptoKey> {
  const root = await importHmacKey(secret);
  const derived = await globalThis.crypto.subtle.sign(
    "HMAC",
    root,
    encoder.encode(`edict:security:v1:${purpose}`),
  );
  return importHmacKey(new Uint8Array(derived));
}

export class DomainSeparatedTokenMac {
  readonly #secret: Uint8Array;

  constructor(secret: Uint8Array) {
    if (secret.byteLength < 32) throw new SecurityTokenError();
    this.#secret = new Uint8Array(secret);
  }

  async sign(purpose: TokenPurpose, payload: unknown): Promise<string> {
    const payloadBytes = encoder.encode(JSON.stringify(payload));
    const key = await derivePurposeKey(this.#secret, purpose);
    const mac = await globalThis.crypto.subtle.sign("HMAC", key, payloadBytes);
    return `${TOKEN_VERSION}.${base64UrlEncode(payloadBytes)}.${base64UrlEncode(new Uint8Array(mac))}`;
  }

  async verify<T>(
    purpose: TokenPurpose,
    token: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) throw new SecurityTokenError();
      const payloadBytes = base64UrlDecode(parts[1]!);
      const suppliedMac = base64UrlDecode(parts[2]!);
      if (suppliedMac.byteLength !== 32) throw new SecurityTokenError();
      const key = await derivePurposeKey(this.#secret, purpose);
      const valid = await globalThis.crypto.subtle.verify("HMAC", key, suppliedMac, payloadBytes);
      if (!valid) throw new SecurityTokenError();
      return schema.parse(JSON.parse(new TextDecoder().decode(payloadBytes)));
    } catch {
      throw new SecurityTokenError();
    }
  }
}

export const systemTokenClock: TokenClock = {
  nowEpochSeconds: () => Math.floor(Date.now() / 1000),
};

export const cryptoNonceSource: NonceSource = {
  bytes(length) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  },
};

export function decodeSecuritySecret(value: string | undefined): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SecurityTokenError();
  }
  const decoded = base64UrlDecode(value);
  if (decoded.byteLength < 32) throw new SecurityTokenError();
  return decoded;
}

export function bytesToHex(value: Uint8Array): `0x${string}` {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
