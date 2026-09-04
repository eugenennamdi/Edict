import { describe, expect, it, vi } from "vitest";
import { createApprovalRpcMaterial, EDICT_APPROVAL_DOMAIN } from "@/shared/wallet";
import type { AuthorizedRunProjection } from "@/shared/wallet";
import { approveRunFromUserAction, type ApprovalGateway } from "./approval";
import { SelectedWalletSession } from "./session";

const SIGNER = "0xb91155113039693456491ac398614bc81fef5ea7";
const NOW = 1_788_516_000n;
const run: AuthorizedRunProjection = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  manifestHash: "sha256:7db75c525a9757f6297bd2289c17fa36bb017d8a7ccce5f221eadae638c54baf",
  planHash: "sha256:09a1af3868ffc532f845c88f324fc4ce404f85ad2a37641e1777a3ccc79013c7",
  environment: "sandbox",
  chainId: "11155111",
  requiredSigner: { role: "tokenizer" as const, walletAddress: SIGNER },
  phase: "PLAN",
  status: "AWAITING_APPROVAL",
  approved: false,
  revision: 1,
});

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
  const approved = { ...run, approved: true, phase: "TOKENIZATION", status: "PREPARING", revision: 2 };
  const gateway: ApprovalGateway = {
    readRun: vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(approved),
    issueChallenge: vi.fn(async () => challenge()),
    submitApproval: vi.fn(async () => approved),
  };
  return { request, wallet, gateway, signature };
}

describe("browser EIP-712 approval", () => {
  it("passes the exact server-issued string with the exact required signer", async () => {
    const { request, wallet, gateway, signature } = setup();
    const result = await approveRunFromUserAction({
      runId: run.id,
      expectedRevision: 1,
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
    expect(result.approved).toBe(true);
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
        runId: run.id,
        expectedRevision: 1,
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
        runId: run.id,
        expectedRevision: 1,
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
      runId: run.id,
      expectedRevision: 1,
      wallet,
      gateway,
      nowEpochSeconds: () => NOW,
    })).rejects.toMatchObject({ code: "APPROVAL_CHALLENGE_MALFORMED" });
    expect(reads).toBe(0);
    expect(request.mock.calls.some(([value]) => value.method === "eth_signTypedData_v4")).toBe(false);
  });
});
