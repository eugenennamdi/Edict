import "server-only";

import { WALLET_BOUNDARY_LIMITS, WALLET_PROVIDER_DEADLINES_MS } from "@/shared/wallet";
import { readSepoliaRpcConfig } from "./config";
import type { RpcTransport } from "./types";

export const MAX_RPC_RESPONSE_BYTES = WALLET_BOUNDARY_LIMITS.rpcResponseCodeUnits; // 1,048,576 bytes (1 MiB)
export const DEFAULT_RPC_DEADLINE_MS = WALLET_PROVIDER_DEADLINES_MS.passiveRead; // 10,000 ms (10s)

export type RpcTransportErrorCode =
  | "RPC_CONFIGURATION_MISSING"
  | "RPC_RESPONSE_SIZE_EXCEEDED"
  | "RPC_INVALID_CONTENT_TYPE"
  | "RPC_INVALID_JSON"
  | "RPC_ID_MISMATCH"
  | "RPC_INVALID_RESPONSE"
  | "RPC_HTTP_ERROR"
  | "RPC_REDIRECT_REFUSED"
  | "RPC_TIMEOUT"
  | "RPC_NETWORK_ERROR";

export class RpcTransportError extends Error {
  readonly code: RpcTransportErrorCode;
  readonly httpStatus?: number;

  constructor(code: RpcTransportErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "RpcTransportError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class RpcJsonRpcError extends Error {
  readonly rpcCode: number;

  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "RpcJsonRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface HttpRpcTransportOptions {
  readonly rpcUrl: string;
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
  readonly maxResponseSizeBytes?: number;
}

/**
 * Strips URLs, tokens, and control characters from untrusted upstream error strings,
 * ensuring sensitive endpoints and credentials are never leaked.
 */
function sanitizeText(raw: string, sensitiveSubstrings: readonly string[] = []): string {
  let text = raw;
  for (const sensitive of sensitiveSubstrings) {
    if (sensitive && sensitive.length > 0) {
      text = text.replaceAll(sensitive, "[REDACTED]");
    }
  }
  // Strip any URL-like strings
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]");
  // Remove control characters except standard space
  text = text.replace(/[\x00-\x1F\x7F]/g, " ");
  // Bound to a reasonable length for error display
  if (text.length > 256) {
    text = `${text.slice(0, 253)}...`;
  }
  return text.trim();
}

/**
 * Hardened production HTTP JSON-RPC transport for Sepolia RPC.
 *
 * Implements:
 * - Strict POST JSON-RPC 2.0 only.
 * - Redirect refusal (`redirect: "error"`).
 * - Streaming response body size limiting <= 1 MiB *while* reading chunks.
 * - Fail-closed if no stream reader is available.
 * - Strict JSON Content-Type validation.
 * - Strict response id matching.
 * - Sanitized upstream JSON-RPC errors and network errors (no credential/URL leakage).
 * - AbortSignal / deadline timeout.
 * - Zero automatic retries.
 */
export class HttpRpcTransport implements RpcTransport {
  readonly #rpcUrl: string;
  readonly #fetch: typeof fetch;
  readonly #deadlineMs: number;
  readonly #maxResponseSizeBytes: number;
  #requestId = 0;

  constructor(options: HttpRpcTransportOptions) {
    this.#rpcUrl = options.rpcUrl;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_RPC_DEADLINE_MS;
    this.#maxResponseSizeBytes = options.maxResponseSizeBytes ?? MAX_RPC_RESPONSE_BYTES;
  }

  async request(method: string, params?: readonly unknown[]): Promise<unknown> {
    const id = ++this.#requestId;
    const requestPayload = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? [],
    };

    let serializedBody: string;
    try {
      serializedBody = JSON.stringify(requestPayload);
    } catch {
      throw new RpcTransportError("RPC_NETWORK_ERROR", "Failed to serialize RPC request body.");
    }

    if (serializedBody.length > this.#maxResponseSizeBytes) {
      throw new RpcTransportError(
        "RPC_NETWORK_ERROR",
        "RPC request payload exceeds maximum allowable size.",
      );
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");

    let response: Response;
    try {
      response = await this.#fetch(this.#rpcUrl, {
        method: "POST",
        headers,
        body: serializedBody,
        redirect: "error",
        signal: AbortSignal.timeout(this.#deadlineMs),
      });
    } catch (err: unknown) {
      const sensitiveList = [this.#rpcUrl];
      try {
        const urlObj = new URL(this.#rpcUrl);
        sensitiveList.push(urlObj.origin, urlObj.pathname, urlObj.search);
      } catch {
        // ignore
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new RpcTransportError(
          "RPC_TIMEOUT",
          `RPC request timed out after ${this.#deadlineMs}ms.`,
        );
      }
      throw new RpcTransportError(
        "RPC_NETWORK_ERROR",
        `RPC transport request failed: ${sanitizeText(errMsg, sensitiveList)}`,
      );
    }

    // Explicit check for redirect status if fetch implementation did not reject
    if (response.status >= 300 && response.status < 400) {
      throw new RpcTransportError(
        "RPC_REDIRECT_REFUSED",
        `RPC redirected with status ${response.status}; redirects are strictly prohibited.`,
        response.status,
      );
    }

    // Fast-path early rejection if Content-Length header is reported as oversized
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const parsedLength = parseInt(contentLength, 10);
      if (!Number.isNaN(parsedLength) && parsedLength > this.#maxResponseSizeBytes) {
        throw new RpcTransportError(
          "RPC_RESPONSE_SIZE_EXCEEDED",
          `RPC response content-length (${parsedLength} bytes) exceeds limit of ${this.#maxResponseSizeBytes} bytes.`,
          response.status,
        );
      }
    }

    // Stream reading: enforce size limit WHILE reading chunks
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new RpcTransportError(
        "RPC_NETWORK_ERROR",
        "RPC response does not provide a readable stream.",
        response.status,
      );
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesRead += value.byteLength;
          if (bytesRead > this.#maxResponseSizeBytes) {
            await reader.cancel();
            throw new RpcTransportError(
              "RPC_RESPONSE_SIZE_EXCEEDED",
              `RPC response body exceeded maximum limit of ${this.#maxResponseSizeBytes} bytes while reading stream.`,
              response.status,
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Check HTTP status code (2xx only)
    if (!response.ok) {
      throw new RpcTransportError(
        "RPC_HTTP_ERROR",
        `RPC server responded with HTTP status ${response.status}.`,
        response.status,
      );
    }

    // Validate Content-Type
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.toLowerCase().includes("application/json")) {
      throw new RpcTransportError(
        "RPC_INVALID_CONTENT_TYPE",
        `Expected application/json Content-Type, got ${sanitizeText(contentType ?? "none")}.`,
        response.status,
      );
    }

    // Combine chunks and decode UTF-8 text
    const combined = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const bodyText = new TextDecoder("utf-8").decode(combined);

    // Parse JSON
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new RpcTransportError(
        "RPC_INVALID_JSON",
        "RPC response body failed JSON parsing.",
        response.status,
      );
    }

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new RpcTransportError(
        "RPC_INVALID_RESPONSE",
        "Expected JSON-RPC response to be an object.",
        response.status,
      );
    }

    const record = json as Record<string, unknown>;

    if (record.jsonrpc !== "2.0") {
      throw new RpcTransportError(
        "RPC_INVALID_RESPONSE",
        `Expected jsonrpc 2.0 version, got ${String(record.jsonrpc)}.`,
        response.status,
      );
    }

    if (record.id !== id) {
      throw new RpcTransportError(
        "RPC_ID_MISMATCH",
        `RPC response ID mismatch: expected ${id}, received ${String(record.id)}.`,
        response.status,
      );
    }

    if ("error" in record && record.error !== null && record.error !== undefined) {
      const errObj = record.error as { code?: unknown; message?: unknown };
      const errCode = typeof errObj.code === "number" ? errObj.code : -32603;
      const rawErrMsg = typeof errObj.message === "string" ? errObj.message : "RPC returned error";

      const sensitiveList = [this.#rpcUrl];
      try {
        const urlObj = new URL(this.#rpcUrl);
        sensitiveList.push(urlObj.origin, urlObj.pathname, urlObj.search);
      } catch {
        // ignore
      }

      const sanitizedMsg = sanitizeText(rawErrMsg, sensitiveList);
      throw new RpcJsonRpcError(errCode, `RPC error (${errCode}): ${sanitizedMsg}`);
    }

    if (!("result" in record)) {
      throw new RpcTransportError(
        "RPC_INVALID_RESPONSE",
        "RPC response payload missing result property.",
        response.status,
      );
    }

    return record.result;
  }
}

/**
 * Production Sepolia RPC transport factory.
 *
 * Requirements:
 * - URL obtained ONLY from private server configuration. Normal production
 *   callers cannot supply an arbitrary rpcUrl.
 * - Runtime construction MUST NOT perform a network request.
 * - If EDICT_SEPOLIA_RPC_URL is missing, returns a lazy transport that fails
 *   closed on execution `request()`, allowing non-execution runtime initialization.
 */
export function createProductionSepoliaRpcTransport(): RpcTransport {
  let cachedTransport: HttpRpcTransport | null = null;

  return {
    async request(method: string, params?: readonly unknown[]): Promise<unknown> {
      if (!cachedTransport) {
        const config = readSepoliaRpcConfig();
        cachedTransport = new HttpRpcTransport({ rpcUrl: config.rpcUrl });
      }
      return cachedTransport.request(method, params);
    },
  };
}
