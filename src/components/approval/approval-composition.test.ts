import { describe, expect, it, vi } from "vitest";
import type { PublicRunProjection } from "@/shared/run";
import { createApprovalRpcMaterial, EDICT_APPROVAL_DOMAIN, type WalletReadiness } from "@/shared/wallet";
import { ApprovalGatewayError, type ApprovalGateway } from "@/client/wallet/approval";
import { WalletBoundaryError } from "@/client/wallet/errors";
import {
  createApprovalReadinessController,
  type ApprovalReadinessTarget,
} from "./approval-controller";

const SIGNER = "0xb91155113039693456491ac398614bc81fef5ea7";
const NOW = 1_788_516_000n;
const SIGNATURE = `0x${"12".repeat(65)}`;

const run: PublicRunProjection = Object.freeze<PublicRunProjection>({
  id: "11111111-1111-4111-8111-111111111111",
  schemaVersion: "2.0",
  manifestHash: `sha256:${"1".repeat(64)}`,
  planHash: `sha256:${"2".repeat(64)}`,
  environment: "sandbox",
  chainId: "11155111",
  requiredSigner: { role: "tokenizer", walletAddress: SIGNER },
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
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:00:00.000Z",
  revision: 1,
});

const target: ApprovalReadinessTarget = run;
const approved: PublicRunProjection = Object.freeze({
  ...run,
  approved: true,
  phase: "TOKENIZATION",
  status: "PREPARING",
  execution: Object.freeze({
    projectionVersion: "1.0",
    nextOperation: Object.freeze({ id: "operation-1", kind: "TOKENIZE", sequence: 1, name: "Create tokenization" }),
    preparationStatus: "READY_FOR_PREPARATION",
    transactionReview: null,
  }),
  updatedAt: "2026-09-08T12:00:01.000Z",
  revision: 2,
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
  let generation = 0;
  let listener: (() => void) | null = null;
  const readiness = (): WalletReadiness => Object.freeze({
    state: "READY",
    accounts: Object.freeze(["0x1111111111111111111111111111111111111111", SIGNER]),
    chainId: "0xaa36a7",
    requiredSigner: SIGNER,
    generation,
  });
  const session = {
    selectionId: "wallet-1",
    source: "EIP6963" as const,
    get generation() { return generation; },
    inspect: vi.fn(async () => readiness()),
    requestAccountsFromUserAction: vi.fn(async () => readiness()),
    switchToSepoliaFromUserAction: vi.fn(async () => readiness()),
    requestExplicit: vi.fn(async () => SIGNATURE),
    assertGeneration: vi.fn((expected: number) => {
      if (expected !== generation) throw new WalletBoundaryError("ATTEMPT_INVALIDATED");
    }),
    subscribe: vi.fn((next: () => void) => {
      listener = next;
      return () => { listener = null; };
    }),
    dispose: vi.fn(),
    invalidate() {
      generation += 1;
      listener?.();
    },
  };
  const provider = Object.freeze({
    selectionId: "wallet-1",
    source: "EIP6963" as const,
    displayName: "Test Wallet",
    rdns: "com.example.wallet",
    iconDataUri: "data:image/png;base64,AA==",
    metadataTrusted: false as const,
    status: "AVAILABLE" as const,
    capability: "STRUCTURALLY_ELIGIBLE" as const,
  });
  const discovery = {
    start: vi.fn(),
    list: vi.fn(() => [provider]),
    selectFromUserAction: vi.fn(() => session),
    selectLegacyProviderFromUserAction: vi.fn(() => session),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };
  const gateway: ApprovalGateway = {
    readRun: vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(approved),
    issueChallenge: vi.fn(async () => challenge()),
    submitApproval: vi.fn(async () => approved),
  };
  const accepted: PublicRunProjection[] = [];
  const controller = createApprovalReadinessController({
    target,
    publish: vi.fn(),
    discovery,
    approvalGateway: gateway,
    nowEpochSeconds: () => NOW,
    acceptDurableRun: (next) => {
      if (
        next.id !== run.id ||
        next.manifestHash !== run.manifestHash ||
        next.planHash !== run.planHash ||
        next.requiredSigner.walletAddress !== run.requiredSigner.walletAddress ||
        next.environment !== run.environment ||
        next.chainId !== run.chainId
      ) return false;
      accepted.push(next);
      return true;
    },
    timers: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() },
  });
  const ready = async () => {
    controller.start();
    controller.chooseProvider("wallet-1");
    await controller.selectWallet();
    expect(controller.getState().status).toBe("READY");
  };
  return { controller, session, gateway, accepted, ready };
}

describe("Phase E approval composition", () => {
  it("never approves on mount or READY transition and serializes two explicit clicks", async () => {
    const h = setup();
    h.controller.start();
    expect(h.gateway.readRun).not.toHaveBeenCalled();
    h.controller.chooseProvider("wallet-1");
    await h.controller.selectWallet();
    expect(h.gateway.readRun).not.toHaveBeenCalled();
    await Promise.all([h.controller.approvePlan(), h.controller.approvePlan()]);
    expect(h.gateway.readRun).toHaveBeenCalledTimes(2);
    expect(h.gateway.issueChallenge).toHaveBeenCalledTimes(1);
    expect(h.session.requestExplicit).toHaveBeenCalledTimes(1);
    expect(h.gateway.submitApproval).toHaveBeenCalledTimes(1);
  });

  it("uses the exact signer and serialized challenge, exact proof body, and durable N+1 authority", async () => {
    const h = setup();
    await h.ready();
    await h.controller.approvePlan();
    const issued = challenge();
    expect(h.session.requestExplicit).toHaveBeenCalledWith(
      "eth_signTypedData_v4",
      [SIGNER, issued.signingRequest.params[1]],
    );
    expect(h.gateway.submitApproval).toHaveBeenCalledWith({
      runId: run.id,
      expectedRevision: 1,
      challengeToken: "opaque.challenge.token",
      signature: SIGNATURE,
    });
    expect(h.accepted).toEqual([approved]);
    expect(h.controller.getState()).toMatchObject({
      status: "APPROVAL_RECORDED",
      approvalStatus: "RECORDED",
      selectedProviderId: null,
    });
    h.session.invalidate();
    expect(h.gateway.issueChallenge).toHaveBeenCalledTimes(1);
    expect(h.session.requestExplicit).toHaveBeenCalledTimes(1);
    expect(h.gateway.submitApproval).toHaveBeenCalledTimes(1);
  });

  it("stops a changed preflight authority before challenge or signing", async () => {
    const h = setup();
    await h.ready();
    vi.mocked(h.gateway.readRun).mockReset().mockResolvedValue({
      ...run,
      planHash: `sha256:${"3".repeat(64)}`,
    });
    await h.controller.approvePlan();
    expect(h.gateway.readRun).toHaveBeenCalledTimes(1);
    expect(h.gateway.issueChallenge).not.toHaveBeenCalled();
    expect(h.session.requestExplicit).not.toHaveBeenCalled();
    expect(h.gateway.submitApproval).not.toHaveBeenCalled();
    expect(h.controller.getState().approvalStatus).toBe("UNCONFIRMED");
  });

  it.each([
    [4001, "SIGNATURE_REJECTED"],
    [4200, "SIGNING_UNSUPPORTED"],
  ] as const)("maps signing error %s without proof submission or fallback", async (code, status) => {
    const h = setup();
    await h.ready();
    h.session.requestExplicit.mockRejectedValueOnce(Object.assign(new Error("private"), { code }));
    await h.controller.approvePlan();
    expect(h.controller.getState().approvalStatus).toBe(status);
    expect(h.session.requestExplicit).toHaveBeenCalledTimes(1);
    expect(h.gateway.submitApproval).not.toHaveBeenCalled();
  });

  it("rejects a malformed signature before proof submission", async () => {
    const h = setup();
    await h.ready();
    h.session.requestExplicit.mockResolvedValueOnce("0x12");
    await h.controller.approvePlan();
    expect(h.controller.getState().approvalStatus).toBe("REQUEST_FAILED");
    expect(h.gateway.submitApproval).not.toHaveBeenCalled();
  });

  it("blocks signing when the mandatory pre-sign readiness inspection is invalidated", async () => {
    const h = setup();
    await h.ready();
    h.session.inspect.mockImplementationOnce(async () => {
      h.session.invalidate();
      throw new WalletBoundaryError("ATTEMPT_INVALIDATED");
    });
    await h.controller.approvePlan();
    expect(h.controller.getState()).toMatchObject({
      status: "READINESS_INVALIDATED",
      approvalStatus: "REQUEST_FAILED",
    });
    expect(h.session.requestExplicit).not.toHaveBeenCalled();
    expect(h.gateway.submitApproval).not.toHaveBeenCalled();
  });

  it("locks an uncertain submission to one-read refresh without another challenge, signature, or POST", async () => {
    const h = setup();
    await h.ready();
    vi.mocked(h.gateway.submitApproval).mockRejectedValueOnce(new ApprovalGatewayError("TRANSPORT_FAILURE"));
    vi.mocked(h.gateway.readRun)
      .mockReset()
      .mockResolvedValueOnce(run)
      .mockRejectedValueOnce(new ApprovalGatewayError("SERVICE_UNAVAILABLE"))
      .mockResolvedValueOnce(approved);
    await h.controller.approvePlan();
    expect(h.controller.getState().approvalStatus).toBe("UNCONFIRMED");
    await h.controller.approvePlan();
    expect(h.gateway.issueChallenge).toHaveBeenCalledTimes(1);
    expect(h.session.requestExplicit).toHaveBeenCalledTimes(1);
    expect(h.gateway.submitApproval).toHaveBeenCalledTimes(1);
    await h.controller.refreshApprovalStatus();
    expect(h.gateway.readRun).toHaveBeenCalledTimes(3);
    expect(h.controller.getState().approvalStatus).toBe("RECORDED");
  });

  it("rejects an approved durable state at the wrong revision", async () => {
    const h = setup();
    await h.ready();
    vi.mocked(h.gateway.readRun).mockReset().mockResolvedValueOnce(run).mockResolvedValueOnce({
      ...approved,
      revision: 3,
    });
    await h.controller.approvePlan();
    expect(h.accepted).toHaveLength(0);
    expect(h.controller.getState().approvalStatus).toBe("UNCONFIRMED");
  });

  it("cannot approve a cancelled, terminal, or otherwise ineligible target", async () => {
    const ineligible: ApprovalReadinessTarget[] = [
      { ...target, terminalOutcome: "CANCELLED", status: "FAILED" },
      { ...target, terminalOutcome: "FAILED", status: "FAILED" },
      { ...target, phase: "TOKENIZATION", status: "PREPARING" },
    ];
    for (const initialTarget of ineligible) {
      const h = setup();
      h.controller.updateTarget(initialTarget);
      await h.controller.approvePlan();
      expect(h.gateway.readRun).not.toHaveBeenCalled();
      expect(h.session.requestExplicit).not.toHaveBeenCalled();
    }
  });
});
