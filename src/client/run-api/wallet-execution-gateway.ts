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

export type WalletExecutionGatewayErrorCode =
  | "EXECUTION_AUTHORIZATION_UNAVAILABLE"
  | "REVISION_CONFLICT"
  | "AUTHORIZATION_RESPONSE_UNKNOWN"
  | "MALFORMED_RESPONSE"
  | "SERVER_REJECTION"
  | "MALFORMED_REQUEST";

export class WalletExecutionGatewayError extends Error {
  constructor(readonly code: WalletExecutionGatewayErrorCode) {
    super(code);
    this.name = "WalletExecutionGatewayError";
  }
}

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
  ) throw new WalletExecutionGatewayError("MALFORMED_RESPONSE");
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
        throw new WalletExecutionGatewayError("MALFORMED_RESPONSE");
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
  } catch (error) {
    if (error instanceof WalletExecutionGatewayError) throw error;
    throw new WalletExecutionGatewayError("MALFORMED_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}

async function post(
  transport: WalletExecutionHttpTransport,
  path: string,
  body: unknown,
  authorizationRequest = false,
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
    throw new WalletExecutionGatewayError(
      authorizationRequest ? "AUTHORIZATION_RESPONSE_UNKNOWN" : "SERVER_REJECTION",
    );
  }
  const raw = await readBoundedJson(response);
  if (!response.ok) {
    if (
      authorizationRequest &&
      response.status === 403 &&
      isErrorCode(raw, "EXECUTION_AUTHORIZATION_UNAVAILABLE")
    ) throw new WalletExecutionGatewayError("EXECUTION_AUTHORIZATION_UNAVAILABLE");
    if (response.status === 409 && isErrorCode(raw, "REVISION_CONFLICT")) {
      throw new WalletExecutionGatewayError("REVISION_CONFLICT");
    }
    throw new WalletExecutionGatewayError("SERVER_REJECTION");
  }
  return raw;
}

function isErrorCode(raw: unknown, code: string): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const outer = raw as Record<string, unknown>;
  if (Reflect.ownKeys(outer).length !== 2 || outer.ok !== false) return false;
  const error = outer.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
  const inner = error as Record<string, unknown>;
  return Reflect.ownKeys(inner).length === 1 && inner.code === code;
}

function envelopeFromResponse(raw: unknown): SendAuthorizedEnvelopeV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WalletExecutionGatewayError("MALFORMED_RESPONSE");
  }
  const object = raw as Record<string, unknown>;
  if (Reflect.ownKeys(object).length !== 2 || object.ok !== true || !("envelope" in object)) {
    throw new WalletExecutionGatewayError("MALFORMED_RESPONSE");
  }
  try {
    return parseSendAuthorizedEnvelopeV1(object.envelope);
  } catch {
    throw new WalletExecutionGatewayError("MALFORMED_RESPONSE");
  }
}

function runFromResponse(raw: unknown): PublicRunProjection {
  try {
    return parsePublicRunMutationResponse(raw);
  } catch {
    throw new WalletExecutionGatewayError("MALFORMED_RESPONSE");
  }
}

export function createWalletExecutionHttpGateway(
  transport: WalletExecutionHttpTransport = (path, options) => fetch(path, options),
): WalletExecutionHttpGateway {
  return Object.freeze({
    async authorize(runId: string, expectedRevision: number) {
      const parsedRunId = publicRunIdSchema.safeParse(runId);
      const revision = revisionSchema.safeParse(expectedRevision);
      if (!parsedRunId.success || !revision.success) {
        throw new WalletExecutionGatewayError("MALFORMED_REQUEST");
      }
      return envelopeFromResponse(await post(
        transport,
        `/api/runs/${parsedRunId.data}/wallet-authorization`,
        { expectedRevision: revision.data },
        true,
      ));
    },
    async ingestHash(runId: string, input: Parameters<WalletExecutionHttpGateway["ingestHash"]>[1]) {
      const parsedRunId = publicRunIdSchema.safeParse(runId);
      const parsed = hashInputSchema.safeParse(input);
      if (!parsedRunId.success || !parsed.success) {
        throw new WalletExecutionGatewayError("MALFORMED_REQUEST");
      }
      return runFromResponse(await post(
        transport,
        `/api/runs/${parsedRunId.data}/broadcast-hash`,
        parsed.data,
      ));
    },
    async recordUnknown(runId: string, input: Parameters<WalletExecutionHttpGateway["recordUnknown"]>[1]) {
      const parsedRunId = publicRunIdSchema.safeParse(runId);
      const parsed = unknownInputSchema.safeParse(input);
      if (!parsedRunId.success || !parsed.success) {
        throw new WalletExecutionGatewayError("MALFORMED_REQUEST");
      }
      return runFromResponse(await post(
        transport,
        `/api/runs/${parsedRunId.data}/broadcast-unknown`,
        parsed.data,
      ));
    },
  });
}
