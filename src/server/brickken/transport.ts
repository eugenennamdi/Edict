import "server-only";

import { assertBoundedWalletValue, WALLET_BOUNDARY_LIMITS } from "@/shared/wallet";
import {
  isSandboxBaseUrl,
  readBrickkenRuntimeConfig,
  SANDBOX_BASE_URL,
  type BrickkenRuntimeConfig,
} from "./config";
import { BrickkenAdapterError, safeErrorMessage } from "./errors";

export const MAX_BRICKKEN_RESPONSE_BYTES = 1_048_576; // 1 MiB stream / body limit
export const DEFAULT_BRICKKEN_DEADLINE_MS = 10_000; // 10s default timeout

export interface BrickkenDirectRequestInput {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  readonly fetch?: typeof fetch;
  readonly runtimeConfig?: BrickkenRuntimeConfig;
  readonly deadlineMs?: number;
  readonly maxResponseSizeBytes?: number;
}

export interface BrickkenDirectResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly bodyText: string;
  readonly json: unknown;
  readonly headers: Headers;
}

export function assertNoSecret(value: unknown, secret?: string): void {
  if (!secret) return;
  let rendered: string;
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    throw safeErrorMessage("INVALID_EXTERNAL_RESPONSE", secret);
  }
  if (rendered.includes(secret)) {
    throw safeErrorMessage("INVALID_EXTERNAL_RESPONSE", secret);
  }
}

export function assertBoundedBrickkenResponse(value: unknown): void {
  assertBoundedWalletValue(value, {
    maxCodeUnits: WALLET_BOUNDARY_LIMITS.brickkenResponseCodeUnits,
    maxArrayLength: 256,
    maxProperties: 128,
  });
}

/**
 * Executes a direct, hardened HTTP request to the Brickken Sandbox API.
 *
 * Enforces:
 * - Sandbox base URL only (throws CONFIGURATION_MISSING if not sandbox)
 * - Server-only x-api-key header (never exposed or logged)
 * - Explicit redirect refusal (`redirect: "error"`)
 * - Bounded response body checking BEFORE and during stream ingestion (<= 1 MiB)
 * - Explicit deadline / timeout via AbortSignal
 * - Content-Type validation
 * - Sanitized errors that never contain API keys or secrets
 */
export async function executeBrickkenDirectRequest(
  input: BrickkenDirectRequestInput,
): Promise<BrickkenDirectResponse> {
  const config = input.runtimeConfig ?? readBrickkenRuntimeConfig();
  if (!config.apiKey) {
    throw safeErrorMessage("CONFIGURATION_MISSING");
  }
  if (!isSandboxBaseUrl(config.baseUrl)) {
    throw safeErrorMessage("CONFIGURATION_MISSING", config.apiKey);
  }

  if (!input.path.startsWith("/")) {
    throw new BrickkenAdapterError("INVALID_REQUEST", "Path must start with a leading slash.");
  }

  const targetUrl = new URL(input.path, SANDBOX_BASE_URL);
  if (targetUrl.origin !== SANDBOX_BASE_URL) {
    throw new BrickkenAdapterError(
      "INVALID_REQUEST",
      "Resolved URL origin does not match the sandbox base URL.",
    );
  }

  const injectedFetch = input.fetch ?? globalThis.fetch.bind(globalThis);
  const maxBytes = input.maxResponseSizeBytes ?? MAX_BRICKKEN_RESPONSE_BYTES;
  const deadlineMs = input.deadlineMs ?? DEFAULT_BRICKKEN_DEADLINE_MS;

  const headers = new Headers();
  headers.set("x-api-key", config.apiKey);
  headers.set("Accept", "application/json");

  let serializedBody: string | undefined;
  if (input.body !== undefined) {
    headers.set("Content-Type", "application/json");
    try {
      serializedBody = JSON.stringify(input.body);
    } catch {
      throw safeErrorMessage("INVALID_REQUEST", config.apiKey);
    }
    assertNoSecret(serializedBody, config.apiKey);
  }

  const requestInit: RequestInit = {
    method: input.method,
    headers,
    redirect: "error", // Refuse redirects strictly
    signal: AbortSignal.timeout(deadlineMs),
  };
  if (serializedBody !== undefined) {
    requestInit.body = serializedBody;
  }

  let response: Response;
  try {
    response = await injectedFetch(targetUrl.toString(), requestInit);
  } catch (error) {
    // Check if error message leaks secret
    const msg = error instanceof Error ? error.message : String(error);
    assertNoSecret(msg, config.apiKey);
    throw error;
  }

  // Refuse redirects explicitly if fetch implementation did not fail them
  if (response.status >= 300 && response.status < 400) {
    throw new BrickkenAdapterError(
      "INVALID_EXTERNAL_RESPONSE",
      `Unexpected redirect response (${response.status}) received and refused.`,
    );
  }

  // Enforce Content-Length pre-check if available
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = parseInt(contentLength, 10);
    if (!Number.isNaN(parsedLength) && parsedLength > maxBytes) {
      throw new BrickkenAdapterError(
        "INVALID_EXTERNAL_RESPONSE",
        `Response body length (${parsedLength} bytes) exceeds limit (${maxBytes} bytes).`,
      );
    }
  }

  // Ingest body with stream/length bound check
  let bodyText: string;
  try {
    if (response.body && "getReader" in response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytesRead = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytesRead += value.byteLength;
            if (bytesRead > maxBytes) {
              await reader.cancel();
              throw new BrickkenAdapterError(
                "INVALID_EXTERNAL_RESPONSE",
                `Response stream exceeded limit (${maxBytes} bytes).`,
              );
            }
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      const combined = new Uint8Array(bytesRead);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      bodyText = new TextDecoder().decode(combined);
    } else {
      bodyText = await response.text();
      if (bodyText.length > maxBytes) {
        throw new BrickkenAdapterError(
          "INVALID_EXTERNAL_RESPONSE",
          `Response text length (${bodyText.length} bytes) exceeds limit (${maxBytes} bytes).`,
        );
      }
    }
  } catch (error) {
    if (error instanceof BrickkenAdapterError) {
      throw error;
    }
    const msg = error instanceof Error ? error.message : String(error);
    assertNoSecret(msg, config.apiKey);
    throw error;
  }

  assertNoSecret(bodyText, config.apiKey);

  const contentType = response.headers.get("content-type");
  let parsedJson: unknown = null;
  let jsonParseError = false;
  if (bodyText.trim().length > 0) {
    try {
      parsedJson = JSON.parse(bodyText);
    } catch {
      jsonParseError = true;
      parsedJson = null;
    }
  }

  if (contentType?.includes("application/json") && jsonParseError) {
    throw new BrickkenAdapterError(
      "INVALID_EXTERNAL_RESPONSE",
      "Response Content-Type is application/json but body failed JSON parsing.",
    );
  }

  if (parsedJson !== null) {
    assertBoundedBrickkenResponse(parsedJson);
    assertNoSecret(parsedJson, config.apiKey);
  }

  return Object.freeze({
    status: response.status,
    ok: response.ok,
    bodyText,
    json: parsedJson,
    headers: response.headers,
  });
}
