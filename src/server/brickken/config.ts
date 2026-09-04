import { getServerEnv } from "../env";

export const SANDBOX_BASE_URL = "https://api.sandbox.brickken.com";
export const SEPOLIA_CHAIN_ID = "11155111";
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

export function isSandboxBaseUrl(url: string): boolean {
  return url.replace(/\/+$/, "") === SANDBOX_BASE_URL;
}

export interface BrickkenRuntimeConfig {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly chainId: typeof SEPOLIA_CHAIN_ID;
}

export function readBrickkenRuntimeConfig(): BrickkenRuntimeConfig {
  const env = getServerEnv();
  return {
    apiKey: env.BRICKKEN_API_KEY,
    baseUrl: env.BRICKKEN_BASE_URL,
    chainId: SEPOLIA_CHAIN_ID,
  };
}

export function getBrickkenServerConfig(): {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly chainId: number;
} {
  const runtime = readBrickkenRuntimeConfig();
  return {
    apiKey: runtime.apiKey,
    baseUrl: isSandboxBaseUrl(runtime.baseUrl) ? SANDBOX_BASE_URL : runtime.baseUrl,
    chainId: 11155111,
  };
}
