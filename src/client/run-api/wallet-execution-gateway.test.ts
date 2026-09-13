import { describe, expect, it, vi } from "vitest";
import type { SendAuthorizedEnvelopeV1 } from "@/shared/wallet";
import {
  createWalletExecutionHttpGateway,
  WalletExecutionGatewayError,
  type WalletExecutionHttpTransport,
} from "./wallet-execution-gateway";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SIGNER = "0x1111111111111111111111111111111111111111";
const envelope: SendAuthorizedEnvelopeV1 = Object.freeze({
  domain: "edict.send-authorized-envelope.v1",
  expectedRevision: 9,
  invocationAttemptId: "inv-test-1",
  walletIntentHash: `sha256:${"cd".repeat(32)}`,
  requiredSigner: SIGNER,
  chainRequirement: Object.freeze({ decimalChainId: "11155111", rpcChainId: "0xaa36a7" }),
  walletRequest: Object.freeze({
    from: SIGNER,
    to: "0x3333333333333333333333333333333333333333",
    data: "0x12345678",
    value: "0x0",
    nonce: "0x7",
    gas: "0x5208",
    type: "0x2",
    maxFeePerGas: "0x20",
    maxPriorityFeePerGas: "0x2",
  }),
});

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorCode(error: unknown): unknown {
  return error instanceof WalletExecutionGatewayError ? error.code : error;
}

describe("wallet execution HTTP gateway", () => {
  it.each(["promote", "readiness", "track"] as const)(
    "posts one explicit %s action with only the durable revision",
    async (action) => {
      const run = {
        id: RUN_ID,
        schemaVersion: "4.0",
      };
      const transport = vi.fn(async () => json({ ok: true, run }));
      const gateway = createWalletExecutionHttpGateway(transport);
      // This narrow fixture intentionally exercises transport routing; strict
      // public DTO rejection is covered by the malformed-response cases.
      await expect(gateway[action](RUN_ID, 8)).rejects.toMatchObject({
        code: "MALFORMED_RESPONSE",
      });
      expect(transport).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledWith(
        `/api/runs/${RUN_ID}/${action}`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ expectedRevision: 8 }),
        }),
      );
    },
  );

  it("posts one exact authorization request and accepts only the strict envelope response", async () => {
    const transport = vi.fn(async () => json({ ok: true, envelope }));
    const gateway = createWalletExecutionHttpGateway(transport);
    await expect(gateway.authorize(RUN_ID, 8)).resolves.toEqual(envelope);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      `/api/runs/${RUN_ID}/wallet-authorization`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify({ expectedRevision: 8 }),
      }),
    );
  });

  it.each([
    [403, { ok: false, error: { code: "EXECUTION_AUTHORIZATION_UNAVAILABLE" } }, "EXECUTION_AUTHORIZATION_UNAVAILABLE"],
    [409, { ok: false, error: { code: "REVISION_CONFLICT" } }, "REVISION_CONFLICT"],
    [418, { ok: false, error: { code: "TEAPOT" } }, "SERVER_REJECTION"],
    [403, { ok: false, error: { code: "EXECUTION_AUTHORIZATION_UNAVAILABLE", detail: "leak" } }, "SERVER_REJECTION"],
  ] as const)("maps status %s and its strict body to %s", async (status, body, expected) => {
    const transport = vi.fn(async () => json(body, status));
    const gateway = createWalletExecutionHttpGateway(transport);
    await expect(gateway.authorize(RUN_ID, 8)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === expected,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("classifies authorization transport failure as unknown and never retries", async () => {
    const transport = vi.fn(async () => { throw new TypeError("network details must not escape"); });
    const gateway = createWalletExecutionHttpGateway(transport);
    await expect(gateway.authorize(RUN_ID, 8)).rejects.toMatchObject({
      code: "AUTHORIZATION_RESPONSE_UNKNOWN",
      message: "AUTHORIZATION_RESPONSE_UNKNOWN",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["wrong content type", () => new Response("{}", { headers: { "content-type": "text/plain" } })],
    ["oversized declared body", () => json({}, 200, { "content-length": String(128 * 1024 + 1) })],
    ["oversized streamed body", () => new Response("x".repeat(128 * 1024 + 1), { headers: { "content-type": "application/json" } })],
    ["malformed envelope", () => json({ ok: true, envelope: { ...envelope, walletIntentHash: "bad" } })],
  ] as const)("rejects %s as a bounded malformed response", async (_label, response) => {
    const gateway = createWalletExecutionHttpGateway(async () => response());
    await expect(gateway.authorize(RUN_ID, 8)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("rejects a mixed-case hash at the gateway boundary without a request", async () => {
    const transport: WalletExecutionHttpTransport = vi.fn(async () => json({}));
    const gateway = createWalletExecutionHttpGateway(transport);
    await expect(gateway.ingestHash(RUN_ID, {
      expectedRevision: 9,
      invocationAttemptId: envelope.invocationAttemptId,
      walletIntentHash: envelope.walletIntentHash,
      txHash: `0x${"Ab".repeat(32)}`,
    })).rejects.toMatchObject({ code: "MALFORMED_REQUEST" });
    expect(transport).not.toHaveBeenCalled();
  });
});
