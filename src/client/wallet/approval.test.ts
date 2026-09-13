import { describe, expect, it, vi } from "vitest";
import { createApprovalRpcMaterial, EDICT_APPROVAL_DOMAIN } from "@/shared/wallet";
import type { PublicRunProjection } from "@/shared/run";
import {
  ApprovalGatewayError,
  approveRunFromUserAction,
  type ApprovalGateway,
} from "./approval";
import { SelectedWalletSession } from "./session";

const SIGNER = "0xb91155113039693456491ac398614bc81fef5ea7";
const NOW = 1_788_516_000n;
const run: PublicRunProjection = {
  id: "11111111-1111-4111-8111-111111111111",
  schemaVersion: "2.0",
  manifestHash: "sha256:7db75c525a9757f6297bd2289c17fa36bb017d8a7ccce5f221eadae638c54baf",
  planHash: "sha256:09a1af3868ffc532f845c88f324fc4ce404f85ad2a37641e1777a3ccc79013c7",
  environment: "sandbox",
  chainId: "11155111",
  requiredSigner: { role: "tokenizer" as const, walletAddress: SIGNER },
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
  updatedAt: "2026-09-04T12:00:01.000Z",
  revision: 1,
};

function challenge() {
  const material = createApprovalRpcMaterial({
    domain: EDICT_APPROVAL_DOMAIN,
    primaryType: "ApproveExecutionPlan",
    message: {
      runId: run.id,
      manifestHash: `0x${run.manifestHash.slice(7)}`,
      planHash: `0x${run.planHash.slice(7)}`,
      environment: "sandbox",
      chainId: "11155111",
      approvalVersion: "1.0",
      approvalRevision: "1",
      requiredSigner: SIGNER,
      issuedAt: NOW.toString(),
      expiresAt: (NOW + 300n).toString(),
      nonce: `0x${"11".repeat(32)}`,
    },
  });
  return {
    challengeToken: "opaque.challenge.token",
    typedData: material.typedData,
    typedDataDigest: material.typedDataDigest,
    signingRequest: {
      method: "eth_signTypedData_v4" as const,
      params: [SIGNER, material.serialized] as [string, string],
    },
  };
}

function setup() {
  const signature = `0x${"12".repeat(65)}`;
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_accounts") return ["0x1111111111111111111111111111111111111111", SIGNER];
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_signTypedData_v4") return signature;
    return null;
  });
  const wallet = new SelectedWalletSession("wallet-1", "EIP6963", { request });
  const approved: PublicRunProjection = {
    ...run,
    approved: true,
    phase: "TOKENIZATION",
    status: "PREPARING",
    updatedAt: "2026-09-04T12:00:02.000Z",
    revision: 2,
  };
  const gateway: ApprovalGateway = {
    readRun: vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(approved),
    issueChallenge: vi.fn(async () => challenge()),
    submitApproval: vi.fn(async () => approved),
  };
  return { request, wallet, gateway, signature, approved };
}

describe("browser EIP-712 approval", () => {
  it("passes the exact server-issued string with the exact required signer", async () => {
    const { request, wallet, gateway, signature } = setup();
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    const issued = challenge();
    expect(request).toHaveBeenCalledWith({
      method: "eth_signTypedData_v4",
      params: [SIGNER, issued.signingRequest.params[1]],
    });
    expect(gateway.submitApproval).toHaveBeenCalledWith({
      runId: run.id,
      expectedRevision: 1,
      challengeToken: "opaque.challenge.token",
      signature,
    });
    expect(result).toMatchObject({ outcome: "APPROVAL_RECORDED", run: { approved: true, revision: 2 } });
  });

  it("rejects changed structured data before signing", async () => {
    const { request, wallet, gateway } = setup();
    const original = challenge();
    const changed = {
      ...original,
      typedData: {
        ...original.typedData,
        message: { ...original.typedData.message, planHash: `0x${"00".repeat(32)}` },
      },
    };
    vi.mocked(gateway.issueChallenge).mockResolvedValue(changed);
    await expect(
      approveRunFromUserAction({
        authority: run,
        wallet,
        gateway,
        nowEpochSeconds: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "TYPED_DATA_MISMATCH" });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "eth_signTypedData_v4" }));
  });

  it("never falls back after a clear signature rejection", async () => {
    const { request, wallet, gateway } = setup();
    request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [SIGNER];
      if (method === "eth_chainId") return "0xaa36a7";
      throw Object.assign(new Error("private provider message"), { code: 4001 });
    });
    await expect(
      approveRunFromUserAction({
        authority: run,
        wallet,
        gateway,
        nowEpochSeconds: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "SIGNATURE_REJECTED" });
    expect(request.mock.calls.filter(([value]) => value.method.startsWith("eth_sign"))).toHaveLength(1);
    expect(gateway.submitApproval).not.toHaveBeenCalled();
  });

  it("rejects an accessor-backed challenge without invoking the getter", async () => {
    const { request, wallet, gateway } = setup();
    const hostile = challenge();
    let reads = 0;
    Object.defineProperty(hostile, "typedData", {
      enumerable: true,
      get: () => {
        reads += 1;
        return challenge().typedData;
      },
    });
    vi.mocked(gateway.issueChallenge).mockResolvedValue(hostile);
    await expect(approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    })).rejects.toMatchObject({ code: "APPROVAL_CHALLENGE_MALFORMED" });
    expect(reads).toBe(0);
    expect(request.mock.calls.some(([value]) => value.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("does not treat a signature or successful approval response as durable approval", async () => {
    const { wallet, gateway } = setup();
    vi.mocked(gateway.readRun).mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce(run);
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toEqual({
      outcome: "APPROVAL_NOT_RECORDED",
      run,
      reason: "REFUSED_OR_UNRECORDED",
    });
    expect(gateway.submitApproval).toHaveBeenCalledTimes(1);
    expect(gateway.readRun).toHaveBeenCalledTimes(2);
  });

  it("reconciles one lost submission response from durable approved state without retrying", async () => {
    const { wallet, gateway } = setup();
    vi.mocked(gateway.submitApproval).mockRejectedValueOnce(new ApprovalGatewayError("TRANSPORT_FAILURE"));
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toMatchObject({ outcome: "APPROVAL_RECORDED", run: { revision: 2 } });
    expect(gateway.submitApproval).toHaveBeenCalledTimes(1);
    expect(gateway.issueChallenge).toHaveBeenCalledTimes(1);
    expect(gateway.readRun).toHaveBeenCalledTimes(2);
  });

  it("publishes durable unapproved state after a lost response and never retries", async () => {
    const { wallet, gateway } = setup();
    vi.mocked(gateway.submitApproval).mockRejectedValueOnce(new ApprovalGatewayError("TRANSPORT_FAILURE"));
    vi.mocked(gateway.readRun).mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce(run);
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toMatchObject({ outcome: "APPROVAL_NOT_RECORDED", reason: "REFUSED_OR_UNRECORDED" });
    expect(gateway.submitApproval).toHaveBeenCalledTimes(1);
    expect(gateway.readRun).toHaveBeenCalledTimes(2);
  });

  it("returns approval unconfirmed when the single reconciliation read fails", async () => {
    const { wallet, gateway } = setup();
    vi.mocked(gateway.submitApproval).mockRejectedValueOnce(new ApprovalGatewayError("TRANSPORT_FAILURE"));
    vi.mocked(gateway.readRun)
      .mockReset()
      .mockResolvedValueOnce(run)
      .mockRejectedValueOnce(new ApprovalGatewayError("SERVICE_UNAVAILABLE"));
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toEqual({ outcome: "APPROVAL_UNCONFIRMED", reason: "SERVICE_UNAVAILABLE" });
    expect(gateway.readRun).toHaveBeenCalledTimes(2);
    expect(gateway.submitApproval).toHaveBeenCalledTimes(1);
  });

  it("does not trust a successful approval POST when the final durable GET fails", async () => {
    const { wallet, gateway } = setup();
    vi.mocked(gateway.readRun)
      .mockReset()
      .mockResolvedValueOnce(run)
      .mockRejectedValueOnce(new ApprovalGatewayError("TRANSPORT_FAILURE"));
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toEqual({ outcome: "APPROVAL_UNCONFIRMED", reason: "TRANSPORT_FAILURE" });
    expect(gateway.submitApproval).toHaveBeenCalledTimes(1);
    expect(gateway.readRun).toHaveBeenCalledTimes(2);
  });

  it("stops on a stale preflight read without challenge, signature, mutation, or reread", async () => {
    const { request, wallet, gateway } = setup();
    const stale = { ...run, revision: 2 } as PublicRunProjection;
    vi.mocked(gateway.readRun).mockReset().mockResolvedValue(stale);
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toMatchObject({ outcome: "APPROVAL_NOT_RECORDED", reason: "STALE_OR_CHANGED" });
    expect(gateway.readRun).toHaveBeenCalledTimes(1);
    expect(gateway.issueChallenge).not.toHaveBeenCalled();
    expect(gateway.submitApproval).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([value]) => value.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("reconciles a stale challenge response with one GET and no signature or mutation", async () => {
    const { request, wallet, gateway } = setup();
    vi.mocked(gateway.issueChallenge).mockRejectedValueOnce(new ApprovalGatewayError("STALE_OR_STATE_CONFLICT"));
    vi.mocked(gateway.readRun).mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, revision: 2 });
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toMatchObject({ outcome: "APPROVAL_NOT_RECORDED", reason: "STALE_OR_CHANGED" });
    expect(gateway.readRun).toHaveBeenCalledTimes(2);
    expect(gateway.issueChallenge).toHaveBeenCalledTimes(1);
    expect(gateway.submitApproval).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([value]) => value.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("does not repeat an approval mutation after a stale revision response", async () => {
    const { wallet, gateway } = setup();
    vi.mocked(gateway.submitApproval).mockRejectedValueOnce(new ApprovalGatewayError("STALE_OR_STATE_CONFLICT"));
    vi.mocked(gateway.readRun).mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, revision: 2 });
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toMatchObject({ outcome: "APPROVAL_NOT_RECORDED", reason: "STALE_OR_CHANGED" });
    expect(gateway.submitApproval).toHaveBeenCalledTimes(1);
    expect(gateway.issueChallenge).toHaveBeenCalledTimes(1);
    expect(gateway.readRun).toHaveBeenCalledTimes(2);
  });

  it("uses the reconciliation GET to distinguish refusal from unavailable access", async () => {
    const { wallet, gateway } = setup();
    vi.mocked(gateway.submitApproval).mockRejectedValueOnce(new ApprovalGatewayError("ACCESS_UNAVAILABLE"));
    vi.mocked(gateway.readRun)
      .mockReset()
      .mockResolvedValueOnce(run)
      .mockRejectedValueOnce(new ApprovalGatewayError("ACCESS_UNAVAILABLE"));
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toEqual({ outcome: "ACCESS_UNAVAILABLE" });
    expect(gateway.submitApproval).toHaveBeenCalledTimes(1);
    expect(gateway.readRun).toHaveBeenCalledTimes(2);
  });

  it("does not establish approval from an unexpected durable approved revision or state", async () => {
    const { wallet, gateway } = setup();
    vi.mocked(gateway.readRun).mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce({
      ...run,
      approved: true,
      phase: "TOKENIZATION",
      status: "PREPARING",
      revision: 3,
    });
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toEqual({ outcome: "APPROVAL_UNCONFIRMED", reason: "UNSAFE_DURABLE_STATE" });
  });

  it.each([
    ["run", { id: "22222222-2222-4222-8222-222222222222" }],
    ["manifest", { manifestHash: `sha256:${"3".repeat(64)}` }],
    ["plan", { planHash: `sha256:${"4".repeat(64)}` }],
    ["signer", { requiredSigner: { role: "tokenizer" as const, walletAddress: "0x1111111111111111111111111111111111111111" } }],
    ["environment", { environment: "production" } as unknown as Partial<PublicRunProjection>],
    ["chain", { chainId: "1" } as unknown as Partial<PublicRunProjection>],
    ["terminal", { terminalOutcome: "FAILED" as const, status: "FAILED" as const }],
  ])("does not establish approval from changed %s authority", async (_label, change) => {
    const { wallet, gateway, approved } = setup();
    vi.mocked(gateway.readRun).mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce({
      ...approved,
      ...change,
    });
    const result = await approveRunFromUserAction({
      authority: run,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    });
    expect(result).toEqual({ outcome: "APPROVAL_UNCONFIRMED", reason: "UNSAFE_DURABLE_STATE" });
  });
});
