import "server-only";

/**
 * Server-only Brickken boundary module.
 *
 * This module is reserved for the future Edict-owned Brickken server adapter.
 *
 * Architecture constraints:
 * - Direct SDK imports and Brickken network requests exist solely behind this adapter.
 * - Application and orchestration logic do not depend directly on SDK behavior.
 * - BRICKKEN_API_KEY remains server-only and is never exposed to client bundles.
 * - No SDK instantiation with dummy or placeholder credentials occurs here.
 * - Missing credentials do not fail the build or application initialization.
 */

export interface BrickkenServerAdapterConfig {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly chainId: number;
}

/**
 * Safe accessor for Brickken adapter configuration.
 * Returns undefined apiKey when not configured in the environment.
 */
export function getBrickkenServerConfig(): BrickkenServerAdapterConfig {
  const apiKey = process.env.BRICKKEN_API_KEY;
  const baseUrl = process.env.BRICKKEN_BASE_URL || "https://api.sandbox.brickken.com";
  const chainIdStr = process.env.BRICKKEN_CHAIN_ID || "11155111";
  const chainId = parseInt(chainIdStr, 10);

  return {
    apiKey: apiKey && apiKey.trim().length > 0 ? apiKey : undefined,
    baseUrl,
    chainId: Number.isNaN(chainId) ? 11155111 : chainId,
  };
}
