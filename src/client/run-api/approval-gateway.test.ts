import { describe, expect, it, vi } from "vitest";
import { buildExecutionPlanV1, validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import { createApprovalRpcMaterial, EDICT_APPROVAL_DOMAIN } from "@/shared/wallet";
import type { PublicPlanningRecord, PublicRunProjection } from "@/shared/run";
import { ApprovalGatewayError } from "../wallet/approval";
import { createApprovalHttpGateway, type ApprovalHttpTransport } from "./approval-gateway";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOW = 1_788_516_000n;
const SIGNATURE = `0x${"12".repeat(65)}`;

async function planningRecord(): Promise<PublicPlanningRecord> {
  const validated = validateAssetManifestV1(createValidRawManifest());
  if (!validated.ok) throw new Error("Invalid fixture");
  const plan = await buildExecutionPlanV1(validated.value);
  return {
    run: {
      id: RUN_ID,
      schemaVersion: "2.0",
      manifestHash: plan.manifestHash,
      planHash: plan.planHash,
      environment: "sandbox",
      chainId: "11155111",
      requiredSigner: plan.requiredSigner,
      phase: "PLAN",
      status: "AWAITING_APPROVAL",
      terminalOutcome: null,
      approved: false,
      execution: null,
      operations: [
        { id: "operation-1", kind: "TOKENIZE", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "operation-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "operation-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
      receiptEligible: false,
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
      revision: 1,
    },
    manifest: validated.value,
    plan,
  };
}

function challenge(run: PublicRunProjection, serializedOverride?: string) {
  const material = createApprovalRpcMaterial({
    domain: EDICT_APPROVAL_DOMAIN,
    primaryType: "ApproveExecutionPlan",
    message: {
      runId: run.id,
      manifestHash: `0x${run.manifestHash.slice(7)}`,
      planHash: `0x${run.planHash.slice(7)}`,
      environment: run.environment,
      chainId: run.chainId,
      approvalVersion: "1.0",
      approvalRevision: String(run.revision),
      requiredSigner: run.requiredSigner.walletAddress,
      issuedAt: NOW.toString(),
      expiresAt: (NOW + 300n).toString(),
      nonce: `0x${"11".repeat(32)}`,
    },
  });
  return {
    ok: true,
    challengeToken: "opaque.challenge.token",
    typedData: material.typedData,
    typedDataDigest: material.typedDataDigest,
    signingRequest: {
      method: "eth_signTypedData_v4" as const,
      params: [run.requiredSigner.walletAddress, serializedOverride ?? material.serialized] as [string, string],
    },
  };
}

function exactRequest(options: RequestInit) {
  const { signal, ...request } = options;
  expect(signal).toBeInstanceOf(AbortSignal);
  return request;
}

describe("production approval HTTP gateway", () => {
  it("uses the exact read path and safe browser request options", async () => {
    const record = await planningRecord();
    const transport: ApprovalHttpTransport = vi.fn(async () => Response.json({ ok: true, ...record }));
    const result = await createApprovalHttpGateway(transport).readRun(RUN_ID);
    expect(result).toEqual(record.run);
    expect(transport).toHaveBeenCalledTimes(1);
    const [path, options] = vi.mocked(transport).mock.calls[0]!;
    expect(path).toBe(`/api/runs/${RUN_ID}`);
    expect(exactRequest(options)).toEqual({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
    });
  });

  it("posts only the exact expected revision to the challenge route", async () => {
    const record = await planningRecord();
    const transport: ApprovalHttpTransport = vi.fn(async () => Response.json(challenge(record.run)));
    await createApprovalHttpGateway(transport).issueChallenge({ runId: RUN_ID, expectedRevision: 1 });
    const [path, options] = vi.mocked(transport).mock.calls[0]!;
    expect(path).toBe(`/api/runs/${RUN_ID}/approval-challenges`);
    expect(exactRequest(options)).toEqual({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
  });

  it("posts only the exact approval proof fields and strictly parses the non-authoritative response", async () => {
    const record = await planningRecord();
    const approved = {
      ...record.run,
      approved: true,
      phase: "TOKENIZATION",
      status: "PREPARING",
      execution: {
        projectionVersion: "1.0",
        nextOperation: { id: "operation-1", kind: "TOKENIZE", sequence: 1, name: "Create tokenization" },
        preparationStatus: "READY_FOR_PREPARATION",
        transactionReview: null,
      },
      revision: 2,
    } as PublicRunProjection;
    const transport: ApprovalHttpTransport = vi.fn(async () => Response.json({ ok: true, run: approved }));
    const result = await createApprovalHttpGateway(transport).submitApproval({
      runId: RUN_ID,
      expectedRevision: 1,
      challengeToken: "opaque.challenge.token",
      signature: SIGNATURE,
    });
    expect(result).toEqual(approved);
    const [path, options] = vi.mocked(transport).mock.calls[0]!;
    expect(path).toBe(`/api/runs/${RUN_ID}/approval`);
    expect(exactRequest(options)).toEqual({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        challengeToken: "opaque.challenge.token",
        signature: SIGNATURE,
      }),
    });
  });

  it("preserves the server-issued serialized typed data byte-for-byte", async () => {
    const record = await planningRecord();
    const material = challenge(record.run);
    const exact = ` \n${material.signingRequest.params[1]}\n `;
    const transport: ApprovalHttpTransport = vi.fn(async () => Response.json(challenge(record.run, exact)));
    const result = await createApprovalHttpGateway(transport).issueChallenge({ runId: RUN_ID, expectedRevision: 1 });
    expect(result.signingRequest.params[1]).toBe(exact);
  });

  it.each([
    async (gateway: ReturnType<typeof createApprovalHttpGateway>) => gateway.readRun(RUN_ID),
    async (gateway: ReturnType<typeof createApprovalHttpGateway>) => gateway.issueChallenge({ runId: RUN_ID, expectedRevision: 1 }),
    async (gateway: ReturnType<typeof createApprovalHttpGateway>) => gateway.submitApproval({ runId: RUN_ID, expectedRevision: 1, challengeToken: "opaque.challenge.token", signature: SIGNATURE }),
  ])("rejects unknown or malformed successful envelopes without retry %#", async (invoke) => {
    const transport: ApprovalHttpTransport = vi.fn(async () => Response.json({ ok: true, unknown: true }));
    await expect(invoke(createApprovalHttpGateway(transport))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized JSON before parsing and never retries", async () => {
    const transport: ApprovalHttpTransport = vi.fn(async () => new Response("{}", {
      headers: { "content-type": "application/json", "content-length": String(512 * 1024 + 1) },
    }));
    await expect(createApprovalHttpGateway(transport).readRun(RUN_ID)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, "FORBIDDEN", "ACCESS_UNAVAILABLE"],
    [409, "REVISION_CONFLICT", "STALE_OR_STATE_CONFLICT"],
    [409, "STATE_CONFLICT", "STALE_OR_STATE_CONFLICT"],
    [404, "NOT_FOUND", "RUN_UNAVAILABLE"],
    [404, "API_DISABLED", "SERVICE_UNAVAILABLE"],
    [503, "SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE"],
    [400, "BAD_REQUEST", "REQUEST_REFUSED"],
  ])("maps HTTP %s/%s to only the safe %s class", async (status, serverCode, safeCode) => {
    const transport: ApprovalHttpTransport = vi.fn(async () => Response.json(
      { ok: false, error: { code: serverCode } },
      { status: Number(status) },
    ));
    await expect(createApprovalHttpGateway(transport).submitApproval({
      runId: RUN_ID,
      expectedRevision: 1,
      challengeToken: "opaque.challenge.token",
      signature: SIGNATURE,
    })).rejects.toMatchObject({ code: safeCode });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("never propagates a raw forbidden response or transport error", async () => {
    const forbidden: ApprovalHttpTransport = vi.fn(async () => Response.json(
      { ok: false, error: { code: "FORBIDDEN" }, privateReason: "invalid challenge mac" },
      { status: 403 },
    ));
    const malformed = await createApprovalHttpGateway(forbidden).submitApproval({
      runId: RUN_ID,
      expectedRevision: 1,
      challengeToken: "opaque.challenge.token",
      signature: SIGNATURE,
    }).catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(ApprovalGatewayError);
    expect(String(malformed)).not.toContain("challenge mac");

    const failed: ApprovalHttpTransport = vi.fn(async () => { throw new Error("private network diagnosis"); });
    const unavailable = await createApprovalHttpGateway(failed).readRun(RUN_ID).catch((error: unknown) => error);
    expect(unavailable).toMatchObject({ code: "TRANSPORT_FAILURE" });
    expect(String(unavailable)).not.toContain("private network diagnosis");
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-run reads and semantically invalid successful approval responses", async () => {
    const record = await planningRecord();
    const otherRun = { ...record.run, id: "22222222-2222-4222-8222-222222222222" };
    const readTransport: ApprovalHttpTransport = vi.fn(async () => Response.json({
      ok: true,
      ...record,
      run: otherRun,
    }));
    await expect(createApprovalHttpGateway(readTransport).readRun(RUN_ID)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });

    const submitTransport: ApprovalHttpTransport = vi.fn(async () => Response.json({ ok: true, run: record.run }));
    await expect(createApprovalHttpGateway(submitTransport).submitApproval({
      runId: RUN_ID,
      expectedRevision: 1,
      challengeToken: "opaque.challenge.token",
      signature: SIGNATURE,
    })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(readTransport).toHaveBeenCalledTimes(1);
    expect(submitTransport).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed arguments before transport and exposes no capability parameter", async () => {
    const transport: ApprovalHttpTransport = vi.fn();
    const gateway = createApprovalHttpGateway(transport);
    await expect(gateway.readRun("not-a-run")).rejects.toMatchObject({ code: "MALFORMED_REQUEST" });
    await expect(gateway.issueChallenge({ runId: RUN_ID, expectedRevision: 0 })).rejects.toMatchObject({ code: "MALFORMED_REQUEST" });
    expect(Object.keys(gateway)).toEqual(["readRun", "issueChallenge", "submitApproval"]);
    expect(transport).not.toHaveBeenCalled();
  });
});
