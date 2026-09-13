import { getServerEnv } from "../env";
import { z } from "zod";

export const SANDBOX_BASE_URL = "https://api.sandbox.brickken.com";
export const SEPOLIA_CHAIN_ID = "11155111";
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

export function isSandboxBaseUrl(url: string): boolean {
  return url.replace(/\/+$/, "") === SANDBOX_BASE_URL;
}

export interface BrickkenRuntimeConfig {
  readonly apiKey: string | undefined;
  readonly tokenizerEmail?: string;
  readonly baseUrl: string;
  readonly chainId: typeof SEPOLIA_CHAIN_ID;
}

const tokenizerAccountEmailSchema = z.string().email().max(254);

export function parseBrickkenTokenizerEmail(value: string | undefined): string | undefined {
  if (value === undefined || value !== value.trim() || value !== value.toLowerCase()) {
    return undefined;
  }
  const parsed = tokenizerAccountEmailSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function readBrickkenRuntimeConfig(): BrickkenRuntimeConfig {
  const env = getServerEnv();
  return {
    apiKey: env.BRICKKEN_API_KEY,
    tokenizerEmail: parseBrickkenTokenizerEmail(env.BRICKKEN_TOKENIZER_EMAIL),
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
