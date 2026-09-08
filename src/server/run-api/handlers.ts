import "server-only";

import { validateAssetManifestV1 } from "@/core";
import { publicRunIdSchema } from "@/shared/run";
import { z } from "zod";
import {
  ExecutionError,
  RepositoryRevisionConflictError,
  type ExecutionRun,
} from "../execution";
import { SecurityTokenError } from "../security";
import { runAccessCookieOptions, serializeRunAccessCookie } from "../security/run-access";
import { readRunApiDeploymentConfig, type RunApiDeploymentConfig } from "./config";
import { projectPublicPlanningRecord } from "./projection";
import { createRunApiRuntime, type RunApiRuntime } from "./runtime";

const revisionSchema = z.number().int().positive();
const createSchema = z.strictObject({ manifest: z.unknown() });
const revisionBodySchema = z.strictObject({ expectedRevision: revisionSchema });
const approvalSchema = z.strictObject({
  expectedRevision: revisionSchema,
  challengeToken: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/),
});

export interface RunApiHandlerOptions {
  readonly config?: RunApiDeploymentConfig;
  readonly runtime?: () => RunApiRuntime;
  readonly nodeEnv?: string;
}

type ErrorCode =
  | "API_DISABLED"
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "STATE_CONFLICT"
  | "SERVICE_UNAVAILABLE";

function response(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function failure(status: number, code: ErrorCode): Response {
  return response(status, { ok: false, error: { code } });
}

function deployment(options?: RunApiHandlerOptions): RunApiDeploymentConfig {
  return options?.config ?? readRunApiDeploymentConfig();
}

function runtime(options?: RunApiHandlerOptions): RunApiRuntime {
  return (options?.runtime ?? createRunApiRuntime)();
}

function guardedConfig(request: Request, options?: RunApiHandlerOptions, allowOriginlessGet = false): RunApiDeploymentConfig | Response {
  const config = deployment(options);
  if (!config.enabled || config.trustedOrigin === null) return failure(404, "API_DISABLED");
  const browserRead = allowOriginlessGet && request.method === "GET";
  const origin = request.headers.get("origin");
  if (!(browserRead && origin === null) && origin !== config.trustedOrigin) return failure(403, "FORBIDDEN");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (browserRead ? fetchSite === "cross-site" : fetchSite !== null && fetchSite !== "same-origin") return failure(403, "FORBIDDEN");
  return config;
}

function cookieValue(request: Request, cookieName: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null || header.length > 8192) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === cookieName) {
      const value = part.slice(separator + 1).trim();
      return value.length <= 8192 ? value : undefined;
    }
  }
  return undefined;
}

async function readJson(request: Request, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (contentType !== "application/json") throw new Error("BAD_REQUEST");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("BAD_REQUEST");
  }
  if (request.body === null) throw new Error("BAD_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("BAD_REQUEST");
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
    throw new Error("BAD_REQUEST");
  } finally {
    reader.releaseLock();
  }
}

function projectRun(run: ExecutionRun) {
  return {
    id: run.id,
    schemaVersion: run.schemaVersion,
    manifestHash: run.manifestHash,
    planHash: run.planHash,
    environment: run.environment,
    chainId: run.chainId,
    requiredSigner: run.requiredSigner,
    phase: run.phase,
    status: run.status,
    terminalOutcome: run.terminalOutcome,
    approved: run.approval !== null,
    operations: run.operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      stage: operation.stage,
      preparedTxId: operation.preparedTxId,
      blockchainTxHash: operation.blockchainTxHash,
      brickkenStatus: operation.brickkenStatus,
      timeout: operation.timeout,
    })),
    receiptEligible: run.receiptEligible,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    revision: run.revision,
  };
}

function mapError(error: unknown): Response {
  if (error instanceof SecurityTokenError) return failure(403, "FORBIDDEN");
  if (error instanceof RepositoryRevisionConflictError) return failure(409, "REVISION_CONFLICT");
  if (error instanceof ExecutionError) {
    if (error.code === "REPOSITORY_NOT_FOUND") return failure(404, "NOT_FOUND");
    if (error.code === "ILLEGAL_STATE_TRANSITION" || error.code === "INVALID_APPROVAL") {
      return failure(409, "STATE_CONFLICT");
    }
    return failure(503, "SERVICE_UNAVAILABLE");
  }
  return failure(400, "BAD_REQUEST");
}

async function authorize(request: Request, runId: string, api: RunApiRuntime, cookieName: string): Promise<void> {
  if (!publicRunIdSchema.safeParse(runId).success) throw new SecurityTokenError();
  await api.access.verify(cookieValue(request, cookieName), runId);
}

export async function createRunHandler(request: Request, options?: RunApiHandlerOptions): Promise<Response> {
  const guard = guardedConfig(request, options);
  if (guard instanceof Response) return guard;
  try {
    const raw = createSchema.parse(await readJson(request, 16 * 1024));
    const validated = validateAssetManifestV1(raw.manifest);
    if (!validated.ok) return response(422, { ok: false, error: { code: "BAD_REQUEST", issues: validated.errors.map(({ code, path }) => ({ code, path })) } });
    const api = runtime(options);
    const run = await api.runs.createRun(validated.value);
    const token = await api.access.issue(run.id);
    const record = await projectPublicPlanningRecord(run);
    const cookie = runAccessCookieOptions(guard.trustedOrigin, options?.nodeEnv);
    return response(201, { ok: true, ...record }, {
      "set-cookie": serializeRunAccessCookie(cookie, token),
    });
  } catch (error) {
    return mapError(error);
  }
}

export async function getRunHandler(request: Request, runId: string, options?: RunApiHandlerOptions): Promise<Response> {
  const guard = guardedConfig(request, options, true);
  if (guard instanceof Response) return guard;
  try {
    const api = runtime(options);
    await authorize(request, runId, api, runAccessCookieOptions(guard.trustedOrigin, options?.nodeEnv).name);
    const run = await api.runs.getRun(runId);
    const record = await projectPublicPlanningRecord(run);
    return response(200, { ok: true, ...record });
  } catch (error) {
    return mapError(error);
  }
}

export async function approvalChallengeHandler(request: Request, runId: string, options?: RunApiHandlerOptions): Promise<Response> {
  const guard = guardedConfig(request, options);
  if (guard instanceof Response) return guard;
  try {
    const api = runtime(options);
    await authorize(request, runId, api, runAccessCookieOptions(guard.trustedOrigin, options?.nodeEnv).name);
    const body = revisionBodySchema.parse(await readJson(request, 1024));
    const run = await api.runs.getRun(runId);
    if (run.revision !== body.expectedRevision) throw new RepositoryRevisionConflictError();
    const challenge = await api.approvals.issueChallenge(run, body.expectedRevision);
    return response(200, { ok: true, ...challenge });
  } catch (error) {
    return mapError(error);
  }
}

export async function approveRunHandler(request: Request, runId: string, options?: RunApiHandlerOptions): Promise<Response> {
  const guard = guardedConfig(request, options);
  if (guard instanceof Response) return guard;
  try {
    const api = runtime(options);
    await authorize(request, runId, api, runAccessCookieOptions(guard.trustedOrigin, options?.nodeEnv).name);
    const body = approvalSchema.parse(await readJson(request, 8 * 1024));
    const run = await api.runs.getRun(runId);
    if (run.revision !== body.expectedRevision) throw new RepositoryRevisionConflictError();
    const proof = await api.approvals.verify(run, body.expectedRevision, body.challengeToken, body.signature, api.nowIso());
    const approved = await api.runs.approvePlan(runId, body.expectedRevision, {
      planHash: run.planHash,
      approvedByWallet: proof.recoveredSigner,
      proof,
    });
    return response(200, { ok: true, run: projectRun(approved) });
  } catch (error) {
    return mapError(error);
  }
}

export async function cancelRunHandler(request: Request, runId: string, options?: RunApiHandlerOptions): Promise<Response> {
  const guard = guardedConfig(request, options);
  if (guard instanceof Response) return guard;
  try {
    const api = runtime(options);
    await authorize(request, runId, api, runAccessCookieOptions(guard.trustedOrigin, options?.nodeEnv).name);
    const body = revisionBodySchema.parse(await readJson(request, 1024));
    const cancelled = await api.runs.cancelRun(runId, body.expectedRevision);
    return response(200, { ok: true, run: projectRun(cancelled) });
  } catch (error) {
    return mapError(error);
  }
}
