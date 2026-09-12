import { describe, expect, it, vi } from "vitest";
import {
  createTrustedSepoliaRpcClient,
  TrustedSepoliaRpcClientImpl,
} from "./client";
import { readSepoliaRpcConfig, RpcConfigurationError } from "./config";
import {
  createProductionSepoliaRpcTransport,
  HttpRpcTransport,
  MAX_RPC_RESPONSE_BYTES,
  RpcJsonRpcError,
  RpcTransportError,
} from "./http-transport";

function createStreamResponse(
  chunks: Uint8Array[],
  status = 200,
  headersInit: Record<string, string> = { "content-type": "application/json" },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: new Headers(headersInit),
  });
}

function createJsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  const text = JSON.stringify(data);
  const chunk = new TextEncoder().encode(text);
  return createStreamResponse([chunk], status, {
    "content-type": "application/json",
    ...extraHeaders,
  });
}

describe("HttpRpcTransport", () => {
  const TEST_RPC_URL = "https://sepolia.example.com/rpc/v1/secret-key-12345";

  it("successfully executes valid Sepolia eth_chainId request and parses result", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      const bodyObj = JSON.parse(String(init?.body)) as { id: number };
      return createJsonResponse({
        jsonrpc: "2.0",
        id: bodyObj.id,
        result: "0xaa36a7",
      });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    const client = createTrustedSepoliaRpcClient(transport);
    await client.verifyChain();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe(TEST_RPC_URL);
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("error");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("throws RpcTransportError on malformed JSON response", async () => {
    const mockFetch = vi.fn(async () => {
      const chunk = new TextEncoder().encode("<html>not json at all</html>");
      return createStreamResponse([chunk], 200, { "content-type": "application/json" });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_INVALID_JSON",
      }),
    );
  });

  it("throws RpcJsonRpcError on JSON-RPC error response and sanitizes error message", async () => {
    const mockFetch = vi.fn(async (_: unknown, init?: RequestInit) => {
      const bodyObj = JSON.parse(String(init?.body)) as { id: number };
      return createJsonResponse({
        jsonrpc: "2.0",
        id: bodyObj.id,
        error: {
          code: -32600,
          message: `Invalid Request to ${TEST_RPC_URL} with secret-token`,
        },
      });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    try {
      await transport.request("eth_getBalance", ["0x123"]);
      expect.unreachable("Should have thrown RpcJsonRpcError");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcJsonRpcError);
      const rpcErr = err as RpcJsonRpcError;
      expect(rpcErr.rpcCode).toBe(-32600);
      expect(rpcErr.message).toContain("RPC error (-32600):");
      expect(rpcErr.message).not.toContain("secret-key-12345");
      expect(rpcErr.message).not.toContain(TEST_RPC_URL);
    }
  });

  it("throws RpcTransportError on mismatched response id", async () => {
    const mockFetch = vi.fn(async () => {
      return createJsonResponse({
        jsonrpc: "2.0",
        id: 999999, // Mismatched id
        result: "0x1",
      });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_ID_MISMATCH",
      }),
    );
  });

  it("rejects oversized response early via Content-Length header", async () => {
    const mockFetch = vi.fn(async () => {
      const chunk = new TextEncoder().encode("{\"result\":\"huge\"}");
      return createStreamResponse([chunk], 200, {
        "content-type": "application/json",
        "content-length": String(MAX_RPC_RESPONSE_BYTES + 100),
      });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_RESPONSE_SIZE_EXCEEDED",
      }),
    );
  });

  it("enforces stream size limit WHILE reading chunks and cancels reader", async () => {
    let readerCancelled = false;
    const mockFetch = vi.fn(async () => {
      // Chunks of 400 KiB each; 3 chunks = 1.2 MiB (> 1 MiB limit)
      const chunk = new Uint8Array(400 * 1024);
      chunk.fill(65); // 'A'
      let count = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (count++ < 10) {
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
        cancel() {
          readerCancelled = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
      });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_RESPONSE_SIZE_EXCEEDED",
      }),
    );
    expect(readerCancelled).toBe(true);
  });

  it("fails closed if response provides no readable body stream", async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: null, // No stream
      } as unknown as Response;
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_NETWORK_ERROR",
        message: expect.stringContaining("readable stream"),
      }),
    );
  });

  it("rejects redirect status codes explicitly", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(null, { status: 302, headers: { Location: "https://evil.com" } });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_REDIRECT_REFUSED",
        httpStatus: 302,
      }),
    );
  });

  it("rejects non-JSON response Content-Type", async () => {
    const mockFetch = vi.fn(async () => {
      const chunk = new TextEncoder().encode("ok");
      return createStreamResponse([chunk], 200, { "content-type": "text/html" });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_INVALID_CONTENT_TYPE",
      }),
    );
  });

  it("rejects HTTP non-2xx status codes", async () => {
    const mockFetch = vi.fn(async () => {
      const chunk = new TextEncoder().encode("{\"error\":\"unauthorized\"}");
      return createStreamResponse([chunk], 401, { "content-type": "application/json" });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_HTTP_ERROR",
        httpStatus: 401,
      }),
    );
  });

  it("handles timeout cleanly and does not leak secrets", async () => {
    const mockFetch = vi.fn(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
      deadlineMs: 50,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(
      expect.objectContaining({
        name: "RpcTransportError",
        code: "RPC_TIMEOUT",
        message: expect.stringContaining("50ms"),
      }),
    );
  });

  it("never includes RPC URL or credentials in network error messages", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error(`Connection failed to ${TEST_RPC_URL} with secret params`);
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    try {
      await transport.request("eth_blockNumber");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcTransportError);
      const msg = (err as Error).message;
      expect(msg).not.toContain("secret-key-12345");
      expect(msg).not.toContain(TEST_RPC_URL);
    }
  });

  it("performs exactly zero automatic retries on failure", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("Network drop");
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.request("eth_blockNumber")).rejects.toThrow(RpcTransportError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-Sepolia chain ID when consumed by TrustedSepoliaRpcClient", async () => {
    const mockFetch = vi.fn(async (_: unknown, init?: RequestInit) => {
      const bodyObj = JSON.parse(String(init?.body)) as { id: number };
      return createJsonResponse({
        jsonrpc: "2.0",
        id: bodyObj.id,
        result: "0x1", // Mainnet
      });
    });

    const transport = new HttpRpcTransport({
      rpcUrl: TEST_RPC_URL,
      fetch: mockFetch as unknown as typeof fetch,
    });

    const client = new TrustedSepoliaRpcClientImpl(transport);
    await expect(client.verifyChain()).rejects.toThrow(/Unsupported chain ID.*expected 11155111/);
  });
});

describe("readSepoliaRpcConfig", () => {
  it("validates HTTPS Sepolia URL successfully", () => {
    const config = readSepoliaRpcConfig("https://sepolia.infura.io/v3/key");
    expect(config.rpcUrl).toBe("https://sepolia.infura.io/v3/key");
  });

  it("permits loopback HTTP exclusively for testing", () => {
    const config1 = readSepoliaRpcConfig("http://127.0.0.1:8545");
    expect(config1.rpcUrl).toBe("http://127.0.0.1:8545/");
    const config2 = readSepoliaRpcConfig("http://localhost:8545");
    expect(config2.rpcUrl).toBe("http://localhost:8545/");
  });

  it("rejects non-loopback HTTP", () => {
    expect(() => readSepoliaRpcConfig("http://sepolia.infura.io")).toThrow(
      RpcConfigurationError,
    );
  });

  it("rejects URLs with userinfo credentials", () => {
    expect(() => readSepoliaRpcConfig("https://user:pass@sepolia.example.com")).toThrow(
      /must not embed userinfo credentials/,
    );
  });

  it("fails closed on missing or empty URL", () => {
    expect(() => readSepoliaRpcConfig("")).toThrow(RpcConfigurationError);
    expect(() => readSepoliaRpcConfig(undefined)).toThrow(RpcConfigurationError);
  });

  it("rejects invalid URLs", () => {
    expect(() => readSepoliaRpcConfig("not a url")).toThrow(RpcConfigurationError);
  });
});

describe("createProductionSepoliaRpcTransport factory", () => {
  it("does not make network calls on instantiation and fails closed lazily if env is unset", async () => {
    // When EDICT_SEPOLIA_RPC_URL is not set in env
    const transport = createProductionSepoliaRpcTransport();
    expect(transport).toBeDefined();

    // Only fails when request() is called
    await expect(transport.request("eth_chainId")).rejects.toThrow(RpcConfigurationError);
  });
});
