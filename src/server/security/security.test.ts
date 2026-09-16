import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildExecutionPlanV1, validateAssetManifestV1 } from "@/core";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import type { ExecutionRun } from "../execution/types";
import { APPROVAL_SIGNATURE_VECTOR as vector } from "./public-signature-vector";
import { RUN_ACCESS_COOKIE, RunAccessService, runAccessCookieOptions } from "./run-access";
import {
  cryptoNonceSource,
  DomainSeparatedTokenMac,
  SecurityTokenError,
  type NonceSource,
} from "./tokens";
import { WALLET_APPROVAL_LIMITATIONS, WalletApprovalService } from "./wallet-approval";

const secret = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const fixedNonce: NonceSource = { bytes: (length) => new Uint8Array(length).fill(0x11) };

async function vectorRun(): Promise<ExecutionRun> {
  const validation = validateAssetManifestV1({
    schemaVersion: "1.0",
    environment: "sandbox",
    chainId: "11155111",
    tokenizer: { email: "tokenizer@example.com", walletAddress: vector.signer },
    asset: {
      name: "Approval Test Asset",
      symbol: "APV",
      tokenType: "RWA_TOKEN",
      supplyCap: "1000",
      documentationUrl: "https://docs.example.com/approval",
    },
    investor: {
      email: "investor@example.com",
      walletAddress: "0x2222222222222222222222222222222222222222",
      mintAmount: "25",
    },
  });
  if (!validation.ok) throw new Error("The public signature manifest must validate.");
  const plan = await buildExecutionPlanV1(validation.value);
  expect(plan.manifestHash).toBe(vector.manifestHash);
  expect(plan.planHash).toBe(vector.planHash);
  const service = new ExecutionRunService({
    repository: new InMemoryExecutionRunRepository(),
    clock: { nowIso: () => "2026-09-04T10:00:00.000Z" },
    ids: {
      runId: () => vector.runId,
      operationId: () => globalThis.crypto.randomUUID(),
      eventId: () => globalThis.crypto.randomUUID(),
    },
  });
  return service.createRun(validation.value);
}

describe("run capability security", () => {
  it("issues one secure host cookie and verifies only the bound run", async () => {
    const clock = { nowEpochSeconds: () => vector.issuedAt };
    const service = new RunAccessService({
      mac: new DomainSeparatedTokenMac(secret),
      clock,
      nonces: fixedNonce,
    });
    const token = await service.issue(vector.runId);
    await expect(service.verify(token, vector.runId)).resolves.toMatchObject({ runId: vector.runId });
    await expect(
      service.verify(token, "22222222-2222-4222-8222-222222222222"),
    ).rejects.toBeInstanceOf(SecurityTokenError);
    expect(RUN_ACCESS_COOKIE).toBe("__Host-edict_run_access");
    expect(runAccessCookieOptions()).toEqual({
      name: RUN_ACCESS_COOKIE,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 86400,
    });
  });

  it("refuses expired, malformed and forged capabilities", async () => {
    let now = vector.issuedAt;
    const service = new RunAccessService({
      mac: new DomainSeparatedTokenMac(secret),
      clock: { nowEpochSeconds: () => now },
      nonces: cryptoNonceSource,
    });
    const token = await service.issue(vector.runId);
    now += 86400;
    await expect(service.verify(token, vector.runId)).rejects.toBeInstanceOf(SecurityTokenError);
    await expect(service.verify("v1.invalid.invalid", vector.runId)).rejects.toBeInstanceOf(
      SecurityTokenError,
    );
    await expect(service.verify(`${token}x`, vector.runId)).rejects.toBeInstanceOf(
      SecurityTokenError,
    );
  });

  it("domain-separates capability and challenge MACs", async () => {
    const mac = new DomainSeparatedTokenMac(secret);
    const payload = { purpose: "test" };
    const capability = await mac.sign("run-capability", payload);
    await expect(mac.verify("approval-challenge", capability, z.unknown())).rejects.toBeInstanceOf(
      SecurityTokenError,
    );
  });
});

describe("EOA wallet approval", () => {
  it("reconstructs the historical public signature without authorizing its disabled plan", async () => {
    const current = await vectorRun();
    const wallet = new WalletApprovalService({ mac: new DomainSeparatedTokenMac(secret),
      clock: { nowEpochSeconds: () => vector.issuedAt }, nonces: fixedNonce });
    const historical = { ...current, planHash: vector.planHash,
      plan: { ...current.plan, executionScope: undefined, planHash: vector.planHash } };
    await expect(wallet.issueChallenge(historical, historical.revision)).rejects.toThrow();
    const proof = {
      scheme: "EIP712_EOA" as const, proofVersion: "1.0" as const, domainVersion: "1" as const,
      runId: vector.runId, manifestHash: vector.manifestHash, planHash: vector.planHash,
      environment: "sandbox" as const, chainId: "11155111" as const, approvalRevision: 1,
      requiredSigner: vector.signer, recoveredSigner: vector.signer, challengeNonce: vector.nonce,
      issuedAt: new Date(vector.issuedAt * 1000).toISOString(), expiresAt: new Date(vector.expiresAt * 1000).toISOString(),
      verifiedAt: "2026-09-04T10:00:01.000Z", typedDataDigest: vector.typedDataDigest, publicSignature: vector.signature,
    };
    expect(await wallet.reproduceSigner(proof)).toBe(vector.signer);
  });

  it("fails closed for the wrong signer and never claims EIP-1271 or personal-sign", async () => {
    const run = await vectorRun();
    const wrongRun: ExecutionRun = {
      ...run,
      requiredSigner: {
        role: "tokenizer",
        walletAddress: "0x1111111111111111111111111111111111111111",
      },
    };
    const wallet = new WalletApprovalService({
      mac: new DomainSeparatedTokenMac(secret),
      clock: { nowEpochSeconds: () => vector.issuedAt },
      nonces: fixedNonce,
    });
    const challenge = await wallet.issueChallenge(wrongRun, wrongRun.revision);
    await expect(
      wallet.verify(
        wrongRun,
        wrongRun.revision,
        challenge.challengeToken,
        vector.signature,
        "2026-09-04T10:00:01.000Z",
      ),
    ).rejects.toBeInstanceOf(SecurityTokenError);
    expect(WALLET_APPROVAL_LIMITATIONS).toEqual({
      scheme: "EIP-712",
      signerType: "EOA_ONLY",
      eip1271Supported: false,
      personalSignFallback: false,
      rpcContractDetection: false,
    });
  });
});
