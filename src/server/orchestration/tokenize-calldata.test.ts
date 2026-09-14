import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, zeroAddress } from "viem";
import { validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import { createValidTokenizeCalldata, syntheticTokenizeProtocolRpc } from "../execution/test-fixtures";
import { createTrustedSepoliaRpcClient } from "../rpc/client";
import { canonicalTokenizeCall, TOKENIZE_ABI, validateTokenizeProtocol } from "./tokenize-calldata";

async function runFixture() {
  const manifest = validateAssetManifestV1(createValidRawManifest());
  if (!manifest.ok) throw new Error("fixture");
  return new ExecutionRunService({ repository: new InMemoryExecutionRunRepository(),
    clock: { nowIso: () => "2026-09-14T00:00:00.000Z" }, ids: {
      runId: () => "11111111-1111-4111-8111-111111111111", operationId: (() => { let i = 0; return () => `op-${i++}`; })(), eventId: () => "event-1",
    } }).createRun(manifest.value);
}

function mutate(tuple: number, index: number, value: unknown): string {
  const args = decodeFunctionData({ abi: TOKENIZE_ABI, data: createValidTokenizeCalldata() as `0x${string}` }).args;
  const changed = args.map((entry, t) => entry.map((old, i) => t === tuple && i === index ? value : old));
  return encodeFunctionData({ abi: TOKENIZE_ABI, functionName: "newTokenization", args: changed as unknown as typeof args });
}

function rpcFixture(override?: (method: string, params?: readonly unknown[]) => unknown) {
  return createTrustedSepoliaRpcClient({ request: async (method, params) => {
    const changed = override?.(method, params);
    if (changed !== undefined) return changed;
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`, baseFeePerGas: "0x10", timestamp: "0x66e44000" };
    const value = syntheticTokenizeProtocolRpc(method, params);
    if (value === undefined) throw new Error("Unexpected RPC");
    return value;
  } });
}

describe("canonical mandate calldata", () => {
  it.each([
    ["url", 0, 0, "https://evil.example"], ["name", 0, 1, "Changed"], ["symbol", 0, 2, "BAD"],
    ["supply", 0, 3, 1001n * 10n ** 18n], ["issuer", 1, 3, zeroAddress], ["payer", 1, 2, zeroAddress],
    ["pre-mints", 0, 7, [1n]], ["holders", 0, 8, [zeroAddress]],
    ["unbound fee permit", 1, 1, 1n], ["payment token", 0, 4, zeroAddress],
    ["oracle flag", 0, 6, true], ["permit deadline", 2, 0, 1n],
    ["malformed report", 1, 6, "0x1234"],
  ])("rejects changed %s with unchanged selector/destination", async (_name, tuple, index, value) => {
    const run = await runFixture();
    expect(() => canonicalTokenizeCall(run, mutate(tuple as number, index as number, value))).toThrow();
  });

  it("encodes approved values plus exact protocol fields byte for byte", async () => {
    const run = await runFixture();
    const data = createValidTokenizeCalldata();
    expect(canonicalTokenizeCall(run, data).calldata).toBe(data);
    expect(() => canonicalTokenizeCall(run, `${data}00`)).toThrow();
    await expect(validateTokenizeProtocol(run, data, rpcFixture())).resolves.toBeUndefined();
  });

  it("rejects expired and safety-buffer reports", async () => {
    const run = await runFixture();
    for (const deadline of [1n, BigInt("0x66e44000") + 299n]) {
      await expect(validateTokenizeProtocol(run, createValidTokenizeCalldata(deadline), rpcFixture())).rejects.toThrow();
    }
  });

  it.each(["chain", "implementation", "signature/source/domain", "code", "simulation", "decimals", "report nonce"])("fails closed on invalid current %s", async (failure) => {
    const run = await runFixture();
    const rpc = rpcFixture((method, params) => {
      const data = (params?.[0] as { data?: string })?.data ?? "";
      if (failure === "chain" && method === "eth_chainId") return "0x1";
      if (failure === "implementation" && method === "eth_getStorageAt") return `0x${"0".repeat(64)}`;
      if (failure === "code" && method === "eth_getCode") return "0x";
      if (failure === "signature/source/domain" && method === "eth_call") throw new Error("revert");
      if (failure === "simulation" && data.startsWith("0xf3d02cfd")) throw new Error("revert");
      if (failure === "decimals" && data.startsWith("0x313ce567")) return `0x${"0".repeat(63)}6`;
      if (failure === "report nonce" && data.startsWith("0x7ecebe00")) return `0x${"0".repeat(63)}2`;
    });
    await expect(validateTokenizeProtocol(run, createValidTokenizeCalldata(), rpc)).rejects.toThrow();
  });
});
