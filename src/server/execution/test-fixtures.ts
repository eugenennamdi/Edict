import type { ApprovalProofV1, ExecutionRun } from "./types";

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
