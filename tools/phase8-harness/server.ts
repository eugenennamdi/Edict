import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HARNESS_BODY_LIMIT_BYTES, Phase8HarnessRuntime } from "./runtime";

async function requestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    length += bytes.byteLength;
    if (length > HARNESS_BODY_LIMIT_BYTES) throw new Error("BODY_LIMIT");
    chunks.push(bytes);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function send(response: ServerResponse, web: Response): Promise<void> {
  response.statusCode = web.status;
  web.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await web.arrayBuffer()));
}

export function startPhase8HarnessServer(runtime: Phase8HarnessRuntime, input: {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
}) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const authority = input.host === "::1" ? `[::1]:${input.port}` : `${input.host}:${input.port}`;
      const bytes = incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : await requestBody(incoming);
      const request = new Request(`http://${authority}${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers: incoming.headers as HeadersInit,
        ...(bytes === undefined ? {} : { body: bytes }),
      });
      await send(outgoing, await runtime.handle(request));
      if (runtime.stopped) server.close();
    } catch {
      await send(outgoing, new Response('{"ok":false,"error":{"code":"BAD_REQUEST"}}', {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      }));
    }
  });
  return new Promise<{ readonly close: () => Promise<void>; readonly address: AddressInfo }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host, () => {
      server.off("error", reject);
      resolve({
        address: server.address() as AddressInfo,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}
