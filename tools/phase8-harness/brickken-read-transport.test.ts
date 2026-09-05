import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRICKKEN_READ_RESPONSE_LIMIT_BYTES,
  BRICKKEN_READ_URL,
  createBrickkenReadTransport,
} from "./brickken-read-transport";

const API_KEY = "synthetic-visible-ascii-test-key";

function response(
  body: BodyInit | null,
  init: ResponseInit = {},
  url = BRICKKEN_READ_URL,
): Response {
  const value = new Response(body, init);
  Object.defineProperty(value, "url", { configurable: true, value: url });
  return value;
}

function transport(
  underlying: typeof fetch,
  signal = new AbortController().signal,
) {
  return createBrickkenReadTransport({ fetch: underlying, apiKey: API_KEY, signal });
}

function validInit(patch: RequestInit = {}): RequestInit {
  return {
    method: "GET",
    headers: { accept: "application/json", "x-api-key": API_KEY },
    ...patch,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BRICKKEN_READ request and redirect confinement", () => {
  it("dispatches exactly the fixed GET without a body and forces manual redirects", async () => {
    const underlying = vi.fn(async (_input, init) => {
      void _input;
      void init;
      return response("{}", { status: 200 });
    });
    const constrained = transport(underlying);

    await constrained(BRICKKEN_READ_URL, validInit({ redirect: "follow" }));

    expect(underlying).toHaveBeenCalledOnce();
    expect(underlying.mock.calls[0]?.[0]).toBe(BRICKKEN_READ_URL);
    expect(underlying.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
    expect(underlying.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(new Headers(underlying.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe(API_KEY);
  });

  it.each([
    "http://api.sandbox.brickken.com/get-network-info?chainId=11155111",
    "https://api.sandbox.brickken.com.evil.invalid/get-network-info?chainId=11155111",
    "https://user:password@api.sandbox.brickken.com/get-network-info?chainId=11155111",
    "https://api.sandbox.brickken.com:444/get-network-info?chainId=11155111",
    "https://api.sandbox.brickken.com/get-network-info/extra?chainId=11155111",
    "https://api.sandbox.brickken.com/get-network-info?chainId=1",
    "https://api.sandbox.brickken.com/get-network-info?chainId=11155111&extra=1",
    "https://api.sandbox.brickken.com/get-network-info?chainId=11155111#fragment",
  ])("refuses structurally invalid target %s before dispatch", async (url) => {
    const underlying = vi.fn(async () => response("{}"));
    await expect(transport(underlying)(url, validInit())).rejects.toMatchObject({
      code: "BRICKKEN_TRANSPORT_REQUEST_REFUSED",
    });
    expect(underlying).not.toHaveBeenCalled();
  });

  it("refuses method and body mutations before dispatch", async () => {
    const underlying = vi.fn(async () => response("{}"));
    await expect(transport(underlying)(BRICKKEN_READ_URL, validInit({ method: "POST" })))
      .rejects.toMatchObject({ code: "BRICKKEN_TRANSPORT_REQUEST_REFUSED" });
    await expect(transport(underlying)(BRICKKEN_READ_URL, validInit({ body: "{}" })))
      .rejects.toMatchObject({ code: "BRICKKEN_TRANSPORT_REQUEST_REFUSED" });
    expect(underlying).not.toHaveBeenCalled();
  });

  it.each([
    ["same-origin", `${BRICKKEN_READ_URL}&redirected=1`],
    ["cross-origin", "https://attacker.invalid/collect"],
  ])("refuses %s redirect responses without reading their bodies", async (_label, location) => {
    const pulled = vi.fn();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled();
        controller.enqueue(new TextEncoder().encode("redirect-body"));
      },
      cancel: cancelled,
    }, { highWaterMark: 0 });
    const underlying = vi.fn(async () => response(body, {
      status: 302,
      headers: [["location", location], ["location", "https://second.invalid/"]],
    }));
    const constrained = transport(underlying);

    await expect(constrained(BRICKKEN_READ_URL, validInit())).rejects.toMatchObject({
      code: "BRICKKEN_TRANSPORT_REDIRECT_REFUSED",
    });
    expect(underlying).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(pulled).not.toHaveBeenCalled();
  });

  it("rejects a fetch implementation that reports a followed final URL", async () => {
    const underlying = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return response(
        "redirected",
        { status: 200 },
        "https://attacker.invalid/collect",
      );
    });
    await expect(transport(underlying)(BRICKKEN_READ_URL, validInit({ redirect: "follow" })))
      .rejects.toMatchObject({ code: "BRICKKEN_TRANSPORT_RESPONSE_REFUSED" });
    expect(underlying).toHaveBeenCalledOnce();
    expect(underlying.mock.calls[0]?.[0]).toBe(BRICKKEN_READ_URL);
    expect(underlying.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("permits only one underlying dispatch even if called again", async () => {
    const underlying = vi.fn(async () => response("{}"));
    const constrained = transport(underlying);
    await constrained(BRICKKEN_READ_URL, validInit());
    await expect(constrained(BRICKKEN_READ_URL, validInit())).rejects.toMatchObject({
      code: "BRICKKEN_TRANSPORT_REQUEST_REFUSED",
    });
    expect(underlying).toHaveBeenCalledOnce();
  });
});

describe("BRICKKEN_READ bounded response streaming", () => {
  it("rejects oversized valid Content-Length before consuming and cancels", async () => {
    const pulled = vi.fn();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: pulled,
      cancel: cancelled,
    }, { highWaterMark: 0 });
    const underlying = vi.fn(async () => response(body, {
      headers: { "content-length": String(BRICKKEN_READ_RESPONSE_LIMIT_BYTES + 1) },
    }));
    await expect(transport(underlying)(BRICKKEN_READ_URL, validInit())).rejects.toMatchObject({
      code: "BRICKKEN_TRANSPORT_RESPONSE_TOO_LARGE",
    });
    expect(pulled).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([undefined, "false", "1"])(
    "counts actual bytes when Content-Length is %s",
    async (contentLength) => {
      const cancelled = vi.fn();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return;
          sent = true;
          controller.enqueue(new Uint8Array(BRICKKEN_READ_RESPONSE_LIMIT_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel: cancelled,
      });
      const headers: Record<string, string> = contentLength === undefined
        ? {}
        : { "content-length": contentLength };
      const underlying = vi.fn(async () => response(body, { headers }));
      await expect(transport(underlying)(BRICKKEN_READ_URL, validInit())).rejects.toMatchObject({
        code: "BRICKKEN_TRANSPORT_RESPONSE_TOO_LARGE",
      });
      expect(cancelled).toHaveBeenCalledOnce();
    },
  );

  it("bounds both success and error responses without calling unbounded body helpers", async () => {
    for (const status of [200, 500]) {
      const original = response('{"ok":true}', {
        status,
        headers: {
          "content-type": "application/json",
          "x-api-key": "must-not-copy",
          authorization: "must-not-copy",
        },
      });
      const text = vi.spyOn(original, "text");
      const json = vi.spyOn(original, "json");
      const arrayBuffer = vi.spyOn(original, "arrayBuffer");
      const rebuilt = await transport(vi.fn(async () => original))(
        BRICKKEN_READ_URL,
        validInit(),
      );
      expect(await rebuilt.text()).toBe('{"ok":true}');
      expect(rebuilt.status).toBe(status);
      expect(rebuilt.headers.get("content-type")).toBe("application/json");
      expect(rebuilt.headers.has("x-api-key")).toBe(false);
      expect(rebuilt.headers.has("authorization")).toBe(false);
      expect(text).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
      expect(arrayBuffer).not.toHaveBeenCalled();
    }
  });

  it("composes caller and harness cancellation signals", async () => {
    for (const source of ["harness", "caller"] as const) {
      const harness = new AbortController();
      const caller = new AbortController();
      let observed: AbortSignal | undefined;
      const underlying = vi.fn(async (_input, init) => {
        observed = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          observed?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      });
      const pending = transport(underlying, harness.signal)(
        BRICKKEN_READ_URL,
        validInit({ signal: caller.signal }),
      );
      if (source === "harness") harness.abort();
      else caller.abort();
      await expect(pending).rejects.toThrow();
      expect(observed?.aborted).toBe(true);
      expect(underlying).toHaveBeenCalledOnce();
    }
  });
});
