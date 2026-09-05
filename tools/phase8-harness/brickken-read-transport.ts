import "server-only";

export const BRICKKEN_READ_URL =
  "https://api.sandbox.brickken.com/get-network-info?chainId=11155111";
export const BRICKKEN_READ_RESPONSE_LIMIT_BYTES = 1_048_576;

export type BrickkenReadTransportErrorCode =
  | "BRICKKEN_TRANSPORT_REQUEST_REFUSED"
  | "BRICKKEN_TRANSPORT_REDIRECT_REFUSED"
  | "BRICKKEN_TRANSPORT_RESPONSE_TOO_LARGE"
  | "BRICKKEN_TRANSPORT_RESPONSE_REFUSED"
  | "BRICKKEN_TRANSPORT_ABORTED";

export class BrickkenReadTransportError extends Error {
  readonly code: BrickkenReadTransportErrorCode;

  constructor(code: BrickkenReadTransportErrorCode) {
    super(code);
    this.name = "BrickkenReadTransportError";
    this.code = code;
  }
}

export interface BrickkenReadTransportOptions {
  readonly fetch: typeof fetch;
  readonly apiKey: string;
  readonly signal: AbortSignal;
  readonly allowEmptyResponseUrl?: boolean;
}

function refuse(code: BrickkenReadTransportErrorCode): never {
  throw new BrickkenReadTransportError(code);
}

function requestUrl(input: RequestInfo | URL): URL {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return new URL(input.href);
    if (input instanceof Request) return new URL(input.url);
  } catch {
    return refuse("BRICKKEN_TRANSPORT_REQUEST_REFUSED");
  }
  return refuse("BRICKKEN_TRANSPORT_REQUEST_REFUSED");
}

function validateRequest(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  const url = requestUrl(input);
  const parameters = [...url.searchParams.entries()];
  const method = init?.method ?? (input instanceof Request ? input.method : undefined);
  const requestHasBody = input instanceof Request && input.body !== null;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.sandbox.brickken.com" ||
    url.port !== "" ||
    url.pathname !== "/get-network-info" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    parameters.length !== 1 ||
    parameters[0]?.[0] !== "chainId" ||
    parameters[0]?.[1] !== "11155111" ||
    method !== "GET" ||
    requestHasBody ||
    (init?.body !== undefined && init.body !== null)
  ) {
    return refuse("BRICKKEN_TRANSPORT_REQUEST_REFUSED");
  }
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort after the operation is already terminal.
  }
}

function safeResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "retry-after"] as const) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function boundedResponse(
  response: Response,
  signal: AbortSignal,
  abort: AbortController,
  allowEmptyResponseUrl: boolean,
): Promise<Response> {
  if (signal.aborted) {
    await cancelBody(response);
    return refuse("BRICKKEN_TRANSPORT_ABORTED");
  }
  if (response.status >= 300 && response.status <= 399) {
    abort.abort();
    await cancelBody(response);
    return refuse("BRICKKEN_TRANSPORT_REDIRECT_REFUSED");
  }
  if (response.url !== BRICKKEN_READ_URL && !(allowEmptyResponseUrl && response.url === "")) {
    abort.abort();
    await cancelBody(response);
    return refuse("BRICKKEN_TRANSPORT_RESPONSE_REFUSED");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > BRICKKEN_READ_RESPONSE_LIMIT_BYTES) {
    abort.abort();
    await cancelBody(response);
    return refuse("BRICKKEN_TRANSPORT_RESPONSE_TOO_LARGE");
  }
  if (response.body === null) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: safeResponseHeaders(response),
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const cancelForAbort = () => {
    abort.abort();
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelForAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        return refuse("BRICKKEN_TRANSPORT_ABORTED");
      }
      const chunk = await reader.read();
      if (signal.aborted) return refuse("BRICKKEN_TRANSPORT_ABORTED");
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > BRICKKEN_READ_RESPONSE_LIMIT_BYTES) {
        abort.abort();
        await reader.cancel();
        return refuse("BRICKKEN_TRANSPORT_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof BrickkenReadTransportError) throw error;
    return refuse(signal.aborted ? "BRICKKEN_TRANSPORT_ABORTED" : "BRICKKEN_TRANSPORT_RESPONSE_REFUSED");
  } finally {
    signal.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: safeResponseHeaders(response),
  });
}

export function createBrickkenReadTransport(options: BrickkenReadTransportOptions): typeof fetch {
  let dispatched = false;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (dispatched) return refuse("BRICKKEN_TRANSPORT_REQUEST_REFUSED");
    const requestedHeaders = validateRequest(input, init);
    if (requestedHeaders.get("x-api-key") !== options.apiKey) {
      return refuse("BRICKKEN_TRANSPORT_REQUEST_REFUSED");
    }
    const headers = new Headers();
    headers.set("accept", requestedHeaders.get("accept") ?? "application/json");
    headers.set("x-api-key", options.apiKey);
    const dispatchAbort = new AbortController();
    const signals = [options.signal, dispatchAbort.signal];
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    if (signal.aborted) return refuse("BRICKKEN_TRANSPORT_ABORTED");

    dispatched = true;
    const response = await options.fetch(BRICKKEN_READ_URL, {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
    return boundedResponse(
      response,
      signal,
      dispatchAbort,
      options.allowEmptyResponseUrl === true,
    );
  };
}
