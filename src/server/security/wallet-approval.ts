import "server-only";

import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import {
  createApprovalRpcMaterial,
  EDICT_APPROVAL_CHALLENGE_TTL_SECONDS,
  EDICT_APPROVAL_DOMAIN,
  EDICT_APPROVAL_TYPES,
  type EdictApprovalTypedDataV1,
} from "@/shared/wallet";
import type { ApprovalProofV1, ExecutionRun } from "../execution/types";
import type { NonceSource, TokenClock } from "./tokens";
import { bytesToHex, DomainSeparatedTokenMac, SecurityTokenError } from "./tokens";

export const APPROVAL_CHALLENGE_TTL_SECONDS = EDICT_APPROVAL_CHALLENGE_TTL_SECONDS;
export { EDICT_APPROVAL_DOMAIN, EDICT_APPROVAL_TYPES };

const SHA256 = /^sha256:([0-9a-f]{64})$/;
const challengePayloadSchema = z.strictObject({
  version: z.literal("1.0"),
  purpose: z.literal("approval-challenge"),
  runId: z.string().uuid(),
  manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  planHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  environment: z.literal("sandbox"),
  chainId: z.literal("11155111"),
  approvalRevision: z.number().int().nonnegative(),
  requiredSigner: z.string().regex(/^0x[0-9a-f]{40}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
});

const signatureSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/);

export interface WalletApprovalDependencies {
  readonly mac: DomainSeparatedTokenMac;
  readonly clock: TokenClock;
  readonly nonces: NonceSource;
}

export interface ApprovalChallenge {
  readonly challengeToken: string;
  readonly typedData: EdictApprovalTypedDataV1;
  readonly typedDataDigest: Hex;
  readonly signingRequest: {
    readonly method: "eth_signTypedData_v4";
    readonly params: readonly [string, string];
  };
}

function hashToBytes32(value: string): Hex {
  const match = SHA256.exec(value);
  if (!match) throw new SecurityTokenError();
  return `0x${match[1]}`;
}

function epochToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

function internalTypedData(payload: z.infer<typeof challengePayloadSchema>) {
  return {
    domain: EDICT_APPROVAL_DOMAIN,
    types: EDICT_APPROVAL_TYPES,
    primaryType: "ApproveExecutionPlan" as const,
    message: {
      runId: payload.runId,
      manifestHash: hashToBytes32(payload.manifestHash),
      planHash: hashToBytes32(payload.planHash),
      environment: payload.environment,
      chainId: BigInt(payload.chainId),
      approvalVersion: "1.0" as const,
      approvalRevision: BigInt(payload.approvalRevision),
      requiredSigner: payload.requiredSigner as Hex,
      issuedAt: BigInt(payload.issuedAt),
      expiresAt: BigInt(payload.expiresAt),
      nonce: payload.nonce as Hex,
    },
  };
}

function assertRunBinding(run: ExecutionRun, expectedRevision: number): void {
  if (
    run.id.length === 0 ||
    run.revision !== expectedRevision ||
    run.phase !== "PLAN" ||
    run.status !== "AWAITING_APPROVAL" ||
    run.approval !== null
  ) {
    throw new SecurityTokenError();
  }
}

export class WalletApprovalService {
  readonly #deps: WalletApprovalDependencies;

  constructor(deps: WalletApprovalDependencies) {
    this.#deps = deps;
  }

  async issueChallenge(run: ExecutionRun, expectedRevision: number): Promise<ApprovalChallenge> {
    assertRunBinding(run, expectedRevision);
    const issuedAt = this.#deps.clock.nowEpochSeconds();
    const payload = challengePayloadSchema.parse({
      version: "1.0",
      purpose: "approval-challenge",
      runId: run.id,
      manifestHash: run.manifestHash,
      planHash: run.planHash,
      environment: run.environment,
      chainId: run.chainId,
      approvalRevision: run.revision,
      requiredSigner: run.requiredSigner.walletAddress,
      issuedAt,
      expiresAt: issuedAt + APPROVAL_CHALLENGE_TTL_SECONDS,
      nonce: bytesToHex(this.#deps.nonces.bytes(32)),
    });
    const material = createApprovalRpcMaterial(internalTypedData(payload));
    return Object.freeze({
      challengeToken: await this.#deps.mac.sign("approval-challenge", payload),
      typedData: material.typedData,
      typedDataDigest: material.typedDataDigest,
      signingRequest: Object.freeze({
        method: "eth_signTypedData_v4" as const,
        params: Object.freeze([payload.requiredSigner, material.serialized] as const),
      }),
    });
  }

  async verify(
    run: ExecutionRun,
    expectedRevision: number,
    challengeToken: string,
    signature: string,
    verifiedAt: string,
  ): Promise<ApprovalProofV1> {
    assertRunBinding(run, expectedRevision);
    const parsedSignature = signatureSchema.safeParse(signature);
    if (!parsedSignature.success) throw new SecurityTokenError();
    const payload = await this.#deps.mac.verify(
      "approval-challenge",
      challengeToken,
      challengePayloadSchema,
    );
    const now = this.#deps.clock.nowEpochSeconds();
    if (
      payload.runId !== run.id ||
      payload.manifestHash !== run.manifestHash ||
      payload.planHash !== run.planHash ||
      payload.environment !== run.environment ||
      payload.chainId !== run.chainId ||
      payload.approvalRevision !== run.revision ||
      payload.requiredSigner !== run.requiredSigner.walletAddress ||
      payload.expiresAt <= now ||
      payload.issuedAt > now + 30 ||
      payload.expiresAt - payload.issuedAt !== APPROVAL_CHALLENGE_TTL_SECONDS
    ) {
      throw new SecurityTokenError();
    }
    const typedData = internalTypedData(payload);
    let recoveredSigner: string;
    try {
      recoveredSigner = (
        await recoverTypedDataAddress({
          ...typedData,
          signature: parsedSignature.data as Hex,
        })
      ).toLowerCase();
    } catch {
      throw new SecurityTokenError();
    }
    if (recoveredSigner !== run.requiredSigner.walletAddress) {
      throw new SecurityTokenError();
    }
    return Object.freeze({
      scheme: "EIP712_EOA",
      proofVersion: "1.0",
      domainVersion: "1",
      runId: payload.runId,
      manifestHash: payload.manifestHash,
      planHash: payload.planHash,
      environment: payload.environment,
      chainId: payload.chainId,
      approvalRevision: payload.approvalRevision,
      requiredSigner: payload.requiredSigner,
      recoveredSigner,
      challengeNonce: payload.nonce,
      issuedAt: epochToIso(payload.issuedAt),
      expiresAt: epochToIso(payload.expiresAt),
      verifiedAt,
      typedDataDigest: hashTypedData(typedData),
      publicSignature: parsedSignature.data.toLowerCase() as Hex,
    });
  }

  async reproduceSigner(proof: ApprovalProofV1): Promise<string> {
    const payload = challengePayloadSchema.parse({
      version: proof.proofVersion,
      purpose: "approval-challenge",
      runId: proof.runId,
      manifestHash: proof.manifestHash,
      planHash: proof.planHash,
      environment: proof.environment,
      chainId: proof.chainId,
      approvalRevision: proof.approvalRevision,
      requiredSigner: proof.requiredSigner,
      issuedAt: Math.floor(new Date(proof.issuedAt).getTime() / 1000),
      expiresAt: Math.floor(new Date(proof.expiresAt).getTime() / 1000),
      nonce: proof.challengeNonce,
    });
    const typedData = internalTypedData(payload);
    if (hashTypedData(typedData) !== proof.typedDataDigest) throw new SecurityTokenError();
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature: proof.publicSignature as Hex,
    });
    return recovered.toLowerCase();
  }
}

export const WALLET_APPROVAL_LIMITATIONS = Object.freeze({
  scheme: "EIP-712",
  signerType: "EOA_ONLY",
  eip1271Supported: false,
  personalSignFallback: false,
  rpcContractDetection: false,
});
