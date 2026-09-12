"use client";

import "client-only";

import {
  parsePublicRunMutationResponse,
  publicRunIdSchema,
  type PublicRunProjection,
} from "@/shared/run";
import {
  parseSendAuthorizedEnvelopeV1,
  type SendAuthorizedEnvelopeV1,
} from "@/shared/wallet";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const revisionSchema = z.number().int().safe().positive();
const bindingSchema = z.strictObject({
  expectedRevision: revisionSchema,
  invocationAttemptId: z.string().min(1).max(1024),
  walletIntentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
const hashInputSchema = bindingSchema.extend({
  txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
});
const unknownInputSchema = bindingSchema.extend({
  reason: z.enum([
    "PROVIDER_4001",
    "PROVIDER_TIMEOUT",
    "PROVIDER_ERROR",
    "HASH_PERSISTENCE_UNCONFIRMED",
  ]),
});

export type BrowserBroadcastUnknownReason =
  | "PROVIDER_4001"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "HASH_PERSISTENCE_UNCONFIRMED";

export interface WalletExecutionHttpGateway {
  authorize(runId: string, expectedRevision: number): Promise<SendAuthorizedEnvelopeV1>;
  ingestHash(runId: string, input: {
    readonly expectedRevision: number;
    readonly invocationAttemptId: string;
    readonly walletIntentHash: `sha256:${string}`;
    readonly txHash: string;
  }): Promise<PublicRunProjection>;
  recordUnknown(runId: string, input: {
    readonly expectedRevision: number;
    readonly invocationAttemptId: string;
    readonly walletIntentHash: `sha256:${string}`;
    readonly reason: BrowserBroadcastUnknownReason;
  }): Promise<PublicRunProjection>;
}

export type WalletExecutionHttpTransport = (path: string, options: RequestInit) => Promise<Response>;

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declared = response.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    response.body === null ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
  ) throw new Error("MALFORMED_WALLET_EXECUTION_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* Response is already refused. */ }
        throw new Error("MALFORMED_WALLET_EXECUTION_RESPONSE");
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("MALFORMED_WALLET_EXECUTION_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}

async function post(
  transport: WalletExecutionHttpTransport,
  path: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("WALLET_EXECUTION_TRANSPORT_FAILURE");
  }
  const raw = await readBoundedJson(response);
  if (!response.ok) throw new Error("WALLET_EXECUTION_REQUEST_FAILED");
  return raw;
}

function envelopeFromResponse(raw: unknown): SendAuthorizedEnvelopeV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("MALFORMED_AUTHORIZATION_RESPONSE");
  }
  const object = raw as Record<string, unknown>;
  if (Reflect.ownKeys(object).length !== 2 || object.ok !== true || !("envelope" in object)) {
    throw new Error("MALFORMED_AUTHORIZATION_RESPONSE");
  }
  return parseSendAuthorizedEnvelopeV1(object.envelope);
}

export function createWalletExecutionHttpGateway(
  transport: WalletExecutionHttpTransport = (path, options) => fetch(path, options),
): WalletExecutionHttpGateway {
  return Object.freeze({
    async authorize(runId: string, expectedRevision: number) {
      const parsedRunId = publicRunIdSchema.parse(runId);
      const revision = revisionSchema.parse(expectedRevision);
      return envelopeFromResponse(await post(
        transport,
        `/api/runs/${parsedRunId}/wallet-authorization`,
        { expectedRevision: revision },
      ));
    },
    async ingestHash(runId: string, input: Parameters<WalletExecutionHttpGateway["ingestHash"]>[1]) {
      const parsedRunId = publicRunIdSchema.parse(runId);
      const parsed = hashInputSchema.parse(input);
      return parsePublicRunMutationResponse(await post(
        transport,
        `/api/runs/${parsedRunId}/broadcast-hash`,
        parsed,
      ));
    },
    async recordUnknown(runId: string, input: Parameters<WalletExecutionHttpGateway["recordUnknown"]>[1]) {
      const parsedRunId = publicRunIdSchema.parse(runId);
      const parsed = unknownInputSchema.parse(input);
      return parsePublicRunMutationResponse(await post(
        transport,
        `/api/runs/${parsedRunId}/broadcast-unknown`,
        parsed,
      ));
    },
  });
}
