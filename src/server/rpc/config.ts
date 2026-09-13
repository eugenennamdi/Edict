import "server-only";

import { getServerEnv } from "../env";

export class RpcConfigurationError extends Error {
  readonly code: "EDICT_SEPOLIA_RPC_URL_MISSING" | "EDICT_SEPOLIA_RPC_URL_INVALID";

  constructor(
    code: "EDICT_SEPOLIA_RPC_URL_MISSING" | "EDICT_SEPOLIA_RPC_URL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "RpcConfigurationError";
    this.code = code;
  }
}

export interface SepoliaRpcConfig {
  readonly rpcUrl: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Validates and extracts the trusted Sepolia RPC configuration.
 *
 * Rules:
 * - Server-only.
 * - URL must be parseable.
 * - HTTPS is required in production. HTTP is permitted exclusively on loopback
 *   addresses for testing.
 * - Userinfo (username/password in URL) is strictly forbidden.
 * - Fail closed if missing: no default public/mainnet RPC endpoint.
 */
export function readSepoliaRpcConfig(envUrl?: string): SepoliaRpcConfig {
  const raw = envUrl ?? getServerEnv().EDICT_SEPOLIA_RPC_URL;
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw new RpcConfigurationError(
      "EDICT_SEPOLIA_RPC_URL_MISSING",
      "Trusted Sepolia RPC URL is not configured.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RpcConfigurationError(
      "EDICT_SEPOLIA_RPC_URL_INVALID",
      "Trusted Sepolia RPC URL is malformed.",
    );
  }

  if (parsed.username || parsed.password) {
    throw new RpcConfigurationError(
      "EDICT_SEPOLIA_RPC_URL_INVALID",
      "Trusted Sepolia RPC URL must not embed userinfo credentials.",
    );
  }

  if (parsed.protocol === "https:") {
    if (!parsed.hostname || parsed.hostname.trim().length === 0) {
      throw new RpcConfigurationError(
        "EDICT_SEPOLIA_RPC_URL_INVALID",
        "Trusted Sepolia RPC URL must specify a valid hostname.",
      );
    }
  } else if (parsed.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new RpcConfigurationError(
        "EDICT_SEPOLIA_RPC_URL_INVALID",
        "Trusted Sepolia RPC URL must use HTTPS (HTTP is allowed only on loopback for testing).",
      );
    }
  } else {
    throw new RpcConfigurationError(
      "EDICT_SEPOLIA_RPC_URL_INVALID",
      `Unsupported RPC protocol: ${parsed.protocol}. Only HTTPS is permitted.`,
    );
  }

  return Object.freeze({
    rpcUrl: parsed.toString(),
  });
}
