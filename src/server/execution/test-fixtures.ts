import type { ApprovalProofV1, ExecutionRun } from "./types";
import { encodeFunctionData, parseAbi } from "viem";
import { REVIEWED_TOKENIZE_FUNCTION_SIGNATURE } from "../orchestration/tokenize-receipt-binding";

export const PUBLIC_EIP712_SIGNATURE_VECTOR =
  "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c";

export function createApprovalProofFixture(
  run: ExecutionRun,
  verifiedAt: string,
  recoveredSigner = run.requiredSigner.walletAddress,
): ApprovalProofV1 {
  return {
    scheme: "EIP712_EOA",
    proofVersion: "1.0",
    domainVersion: "1",
    runId: run.id,
    manifestHash: run.manifestHash,
    planHash: run.planHash,
    environment: run.environment,
    chainId: run.chainId,
    approvalRevision: run.revision,
    requiredSigner: run.requiredSigner.walletAddress,
    recoveredSigner,
    challengeNonce: `0x${"11".repeat(32)}`,
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    verifiedAt,
    typedDataDigest: `0x${"22".repeat(32)}`,
    publicSignature: PUBLIC_EIP712_SIGNATURE_VECTOR,
  };
}

const TOKENIZE_ABI = parseAbi([`function ${REVIEWED_TOKENIZE_FUNCTION_SIGNATURE} external`]);

export function createValidTokenizeCalldata(
  deadline: bigint = 2000000000n,
  signer: `0x${string}` = "0x1111111111111111111111111111111111111111",
  to: `0x${string}` = "0x2222222222222222222222222222222222222222",
): string {
  return encodeFunctionData({
    abi: TOKENIZE_ABI,
    functionName: "newTokenization",
    args: [
      ["Token", "TKN", "ipfs://meta", 1000000n, signer, to, false, [], []],
      [to, 100n, to, signer, deadline, 1n, "0x1234"],
      [100n, to, to, 10n, 0, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`],
    ],
  });
}
