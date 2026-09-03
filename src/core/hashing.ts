import { canonicalizeJson } from "./canonical-json";
import {
  getTrustedManifestSnapshot,
  type NormalizedAssetManifestV1,
} from "./manifest";

declare const sha256DigestBrand: unique symbol;
export type Sha256Digest = `sha256:${string}` & {
  readonly [sha256DigestBrand]: "Sha256Digest";
};

export type CanonicalHash = Readonly<{
  canonicalJson: string;
  hash: Sha256Digest;
}>;

export class CoreHashError extends Error {
  readonly code: "INVALID_NORMALIZED_MANIFEST" | "WEB_CRYPTO_UNAVAILABLE";
  readonly path = "$";

  constructor(code: "INVALID_NORMALIZED_MANIFEST" | "WEB_CRYPTO_UNAVAILABLE") {
    super(
      code === "INVALID_NORMALIZED_MANIFEST"
        ? "A manifest produced by validateAssetManifestV1 is required."
        : "Web Crypto SHA-256 is unavailable in this runtime.",
    );
    this.name = "CoreHashError";
    this.code = code;
  }
}

function toLowercaseHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Utf8(value: string): Promise<Sha256Digest> {
  if (!globalThis.crypto?.subtle) {
    throw new CoreHashError("WEB_CRYPTO_UNAVAILABLE");
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${toLowercaseHex(new Uint8Array(digest))}` as Sha256Digest;
}

export async function hashCanonicalJson(value: unknown): Promise<CanonicalHash> {
  const canonicalJson = canonicalizeJson(value);
  return Object.freeze({ canonicalJson, hash: await sha256Utf8(canonicalJson) });
}

export async function hashAssetManifestV1(
  manifest: NormalizedAssetManifestV1,
): Promise<CanonicalHash> {
  const snapshot = getTrustedManifestSnapshot(manifest);
  if (!snapshot) {
    throw new CoreHashError("INVALID_NORMALIZED_MANIFEST");
  }
  return hashCanonicalJson(snapshot);
}
