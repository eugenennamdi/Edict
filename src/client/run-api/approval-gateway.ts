"use client";

import "client-only";

import { parsePublicPlanningRecordResponse, parsePublicRunMutationResponse, publicRunIdSchema } from "@/shared/run";
import { approvalChallengeEnvelopeSchema, type ApprovalChallengeEnvelopeV1 } from "@/shared/wallet";
import { z } from "zod";
import {
  ApprovalGatewayError,
  type ApprovalGateway,
  type ApprovalGatewayErrorCode,
} from "../wallet/approval";

const GET_RESPONSE_BYTES = 512 * 1024;
const CHALLENGE_RESPONSE_BYTES = 256 * 1024;
const MUTATION_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const revisionSchema = z.number().int().safe().positive();
const challengeInputSchema = z.strictObject({
  runId: publicRunIdSchema,
  expectedRevision: revisionSchema,
});
const approvalInputSchema = challengeInputSchema.extend({
  challengeToken: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/),
});
const challengeResponseSchema = approvalChallengeEnvelopeSchema.extend({ ok: z.literal(true) });
const errorResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.enum([
      "API_DISABLED",
      "BAD_REQUEST",
      "FORBIDDEN",
      "NOT_FOUND",
      "REVISION_CONFLICT",
      "STATE_CONFLICT",
      "SERVICE_UNAVAILABLE",
    ]),
  }),
});

export type ApprovalHttpTransport = (path: string, options: RequestInit) => Promise<Response>;

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredLength = response.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) ||
    response.body === null
  ) {
    throw new ApprovalGatewayError("MALFORMED_RESPONSE");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        try { await reader.cancel(); } catch { /* The response is already refused. */ }
        throw new ApprovalGatewayError("MALFORMED_RESPONSE");
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
    if (error instanceof ApprovalGatewayError) throw error;
    throw new ApprovalGatewayError("MALFORMED_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}

function responseError(status: number, raw: unknown): ApprovalGatewayError {
  const parsed = errorResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return new ApprovalGatewayError("MALFORMED_RESPONSE");
  }
  let code: ApprovalGatewayErrorCode;
  if (status === 403 && parsed.data.error.code === "FORBIDDEN") code = "ACCESS_UNAVAILABLE";
  else if (status === 409 && ["REVISION_CONFLICT", "STATE_CONFLICT"].includes(parsed.data.error.code)) code = "STALE_OR_STATE_CONFLICT";
  else if (status === 404 && parsed.data.error.code === "NOT_FOUND") code = "RUN_UNAVAILABLE";
  else if (
    (status === 503 && parsed.data.error.code === "SERVICE_UNAVAILABLE") ||
    (status === 404 && parsed.data.error.code === "API_DISABLED")
  ) code = "SERVICE_UNAVAILABLE";
  else if ((status === 400 || status === 422) && parsed.data.error.code === "BAD_REQUEST") code = "REQUEST_REFUSED";
  else code = "MALFORMED_RESPONSE";
  return new ApprovalGatewayError(code);
}

async function send(
  transport: ApprovalHttpTransport,
  path: string,
  body: unknown | undefined,
  maximumResponseBytes: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApprovalGatewayError("TRANSPORT_FAILURE");
  }

  const raw = await readBoundedJson(response, maximumResponseBytes);
  if (!response.ok) throw responseError(response.status, raw);
  return raw;
}

export function createApprovalHttpGateway(
  transport: ApprovalHttpTransport = (path, options) => fetch(path, options),
): ApprovalGateway {
  const gateway: ApprovalGateway = {
    async readRun(runId) {
      const parsedRunId = publicRunIdSchema.safeParse(runId);
      if (!parsedRunId.success) throw new ApprovalGatewayError("MALFORMED_REQUEST");
      const raw = await send(
        transport,
        `/api/runs/${parsedRunId.data}`,
        undefined,
        GET_RESPONSE_BYTES,
      );
      try {
        const run = parsePublicPlanningRecordResponse(raw).run;
        if (run.id !== parsedRunId.data) throw new Error("RUN_ID_MISMATCH");
        return run;
      } catch {
        throw new ApprovalGatewayError("MALFORMED_RESPONSE");
      }
    },

    async issueChallenge(input) {
      const parsed = challengeInputSchema.safeParse(input);
      if (!parsed.success) throw new ApprovalGatewayError("MALFORMED_REQUEST");
      const raw = await send(
        transport,
        `/api/runs/${parsed.data.runId}/approval-challenges`,
        { expectedRevision: parsed.data.expectedRevision },
        CHALLENGE_RESPONSE_BYTES,
      );
      const envelope = challengeResponseSchema.safeParse(raw);
      if (!envelope.success) throw new ApprovalGatewayError("MALFORMED_RESPONSE");
      return Object.freeze({
        challengeToken: envelope.data.challengeToken,
        typedData: envelope.data.typedData,
        typedDataDigest: envelope.data.typedDataDigest,
        signingRequest: envelope.data.signingRequest,
      }) satisfies ApprovalChallengeEnvelopeV1;
    },

    async submitApproval(input) {
      const parsed = approvalInputSchema.safeParse(input);
      if (!parsed.success) throw new ApprovalGatewayError("MALFORMED_REQUEST");
      const raw = await send(
        transport,
        `/api/runs/${parsed.data.runId}/approval`,
        {
          expectedRevision: parsed.data.expectedRevision,
          challengeToken: parsed.data.challengeToken,
          signature: parsed.data.signature,
        },
        MUTATION_RESPONSE_BYTES,
      );
      try {
        const run = parsePublicRunMutationResponse(raw);
        if (
          run.id !== parsed.data.runId ||
          !run.approved ||
          run.revision !== parsed.data.expectedRevision + 1 ||
          run.phase !== "TOKENIZATION" ||
          run.status !== "PREPARING" ||
          run.terminalOutcome !== null
        ) throw new Error("APPROVAL_RESPONSE_MISMATCH");
        return run;
      } catch {
        throw new ApprovalGatewayError("MALFORMED_RESPONSE");
      }
    },
  };
  return Object.freeze(gateway);
}
