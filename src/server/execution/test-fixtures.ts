import type { ApprovalProofV1, ExecutionRun } from "./types";
import { encodeFunctionData, parseAbi, toFunctionSelector, zeroAddress, zeroHash } from "viem";
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
      ["https://docs.example.com/asset?b=2&a=1", "Café Receivables", "ED1", 1000n * 10n ** 18n, to, to, false, [], []],
      [to, 0n, signer, signer, deadline, 1n, PUBLIC_EIP712_SIGNATURE_VECTOR],
      [0n, zeroAddress, zeroAddress, 0n, 0, zeroHash, zeroHash],
    ],
  });
}

/** Synthetic read responses only; never evidence of deployed Brickken behavior. */
export function syntheticTokenizeProtocolRpc(method: string, params?: readonly unknown[]): unknown {
  if (method === "eth_getCode") return "0x6000";
  if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}2c24f3fe7665ea83b2280bb5a7e66072c869ad89`;
  if (method === "eth_call") {
    const data = (params?.[0] as { data: string }).data;
    if (data.startsWith(toFunctionSelector("stoBeaconToken()")) || data.startsWith(toFunctionSelector("implementation()"))) return `0x${"0".repeat(24)}3333333333333333333333333333333333333333`;
    if (data.startsWith("0x313ce567")) return `0x${"0".repeat(62)}12`;
    if (data.startsWith("0xf3d02cfd")) return "0x";
    // nonces(address)
    if (data.startsWith("0x7ecebe00")) return `0x${"0".repeat(63)}1`;
    return `0x${"0".repeat(64)}${"0".repeat(24)}3333333333333333333333333333333333333333`;
  }
  return undefined;
}
