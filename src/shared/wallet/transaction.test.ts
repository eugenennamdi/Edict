import { describe, expect, it } from "vitest";
import encodingA from "@/server/brickken/test-vectors/prepare/newTokenization.response.json";
import encodingB from "@/server/brickken/test-vectors/prepare/unsigned-transaction.encoding-b.json";
import whitelist from "@/server/brickken/test-vectors/prepare/whitelist.response.json";
import mint from "@/server/brickken/test-vectors/prepare/mintToken.response.single.json";
import { WALLET_BOUNDARY_LIMITS } from "./limits";
import {
  projectPreparedTransactionV1,
  validateWalletTransactionRequestV1,
  WalletTransactionError,
} from "./transaction";

describe("strict prepared transaction projection", () => {
  it.each([
    ["tokenization", encodingA.transactions[0]],
    ["whitelist", whitelist.transactions[0]],
    ["mint", mint.transactions[0]],
    ["BigNumber encoding", encodingB],
  ])("projects the sourced %s fixture without dropping signing fields", (_name, raw) => {
    const normalized = projectPreparedTransactionV1(raw);
    expect(normalized.chainId).toBe("0xaa36a7");
    expect(normalized.walletRequest).toMatchObject({
      from: "0x1111111111111111111111111111111111111111",
      to: "0x4444444444444444444444444444444444444444",
      value: "0x0",
      type: "0x2",
    });
    expect(normalized.walletRequest).toHaveProperty("nonce");
    expect(normalized.walletRequest).toHaveProperty("gas");
    expect(normalized.walletRequest).toHaveProperty("maxFeePerGas");
    expect(normalized.walletRequest).toHaveProperty("maxPriorityFeePerGas");
    expect(normalized.walletRequest).not.toHaveProperty("chainId");
    expect(normalized.walletRequest).not.toHaveProperty("gasLimit");
  });

  it("proves equivalent aliases and rejects conflicting aliases", () => {
    const base = encodingA.transactions[0];
    expect(
      projectPreparedTransactionV1({ ...base, input: base.data, gas: base.gasLimit }).walletRequest,
    ).toMatchObject({ data: base.data, gas: base.gasLimit });
    expect(() => projectPreparedTransactionV1({ ...base, input: "0x1234" })).toThrowError(
      expect.objectContaining({ code: "CONFLICTING_TRANSACTION_FIELDS", path: "$.input" }),
    );
    expect(() => projectPreparedTransactionV1({ ...base, gas: "0x1" })).toThrowError(
      expect.objectContaining({ code: "CONFLICTING_TRANSACTION_FIELDS", path: "$.gasLimit" }),
    );
  });

  it("preserves absent versus zero and refuses mixed or incomplete fee models", () => {
    const minimal = {
      from: encodingA.transactions[0].from,
      chainId: encodingA.transactions[0].chainId,
      value: "0x00",
      nonce: 0,
    };
    expect(projectPreparedTransactionV1(minimal).walletRequest).toEqual({
      from: minimal.from,
      value: "0x0",
      nonce: "0x0",
    });
    expect(() =>
      projectPreparedTransactionV1({ ...encodingA.transactions[0], gasPrice: "1" }),
    ).toThrowError(expect.objectContaining({ code: "CONFLICTING_TRANSACTION_FIELDS" }));
    const incomplete = { ...encodingA.transactions[0] } as Record<string, unknown>;
    delete incomplete.maxPriorityFeePerGas;
    expect(() => projectPreparedTransactionV1(incomplete)).toThrowError(
      expect.objectContaining({ code: "PREPARED_TRANSACTION_INCOMPLETE" }),
    );
  });

  it("deeply validates and freezes an access list", () => {
    const normalized = projectPreparedTransactionV1({
      from: encodingA.transactions[0].from,
      chainId: encodingA.transactions[0].chainId,
      type: 1,
      gasPrice: "1",
      accessList: [
        {
          address: encodingA.transactions[0].to,
          storageKeys: [`0x${"AB".repeat(32)}`],
        },
      ],
    });
    expect(normalized.walletRequest.accessList?.[0]?.storageKeys[0]).toBe(`0x${"ab".repeat(32)}`);
    expect(Object.isFrozen(normalized.walletRequest)).toBe(true);
    expect(Object.isFrozen(normalized.walletRequest.accessList)).toBe(true);
    expect(Object.isFrozen(normalized.walletRequest.accessList?.[0]?.storageKeys)).toBe(true);
  });

  it("rejects unknown properties and accessors without reading inspected values", () => {
    expect(() =>
      projectPreparedTransactionV1({ ...encodingA.transactions[0], authorizationList: [] }),
    ).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_SIGNING_FIELD", path: "$.authorizationList" }),
    );
    let reads = 0;
    const raw = { ...encodingA.transactions[0] };
    Object.defineProperty(raw, "data", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "0x1234";
      },
    });
    expect(() => projectPreparedTransactionV1(raw)).toThrowError(WalletTransactionError);
    expect(reads).toBe(0);
  });

  it("retains no caller references and strictly revalidates the canonical DTO", () => {
    const raw = structuredClone(encodingB) as Record<string, unknown>;
    const normalized = projectPreparedTransactionV1(raw);
    raw.from = "0x9999999999999999999999999999999999999999";
    expect(normalized.walletRequest.from).toBe(encodingB.from);
    expect(() =>
      validateWalletTransactionRequestV1({ ...normalized.walletRequest, rawUnsigned: raw }),
    ).toThrowError(expect.objectContaining({ code: "MALFORMED_PREPARED_TRANSACTION" }));
    try {
      (normalized.walletRequest as { from: string }).from = raw.from as string;
    } catch {
      // Frozen objects may throw in strict mode.
    }
    expect(normalized.walletRequest.from).toBe(encodingB.from);
  });

  it("rejects quantities above uint256 before conversion", () => {
    expect(() => projectPreparedTransactionV1({
      from: encodingA.transactions[0].from,
      chainId: encodingA.transactions[0].chainId,
      value: `0x1${"0".repeat(64)}`,
    })).toThrowError(expect.objectContaining({ code: "MALFORMED_PREPARED_TRANSACTION" }));
  });

  it("rejects oversized calldata and access lists without truncation", () => {
    expect(() => projectPreparedTransactionV1({
      from: encodingA.transactions[0].from,
      chainId: encodingA.transactions[0].chainId,
      data: `0x${"00".repeat(WALLET_BOUNDARY_LIMITS.calldataBytes + 1)}`,
    })).toThrowError(expect.objectContaining({ code: "MALFORMED_PREPARED_TRANSACTION" }));
    expect(() => projectPreparedTransactionV1({
      from: encodingA.transactions[0].from,
      chainId: encodingA.transactions[0].chainId,
      accessList: Array.from({ length: WALLET_BOUNDARY_LIMITS.accessListEntries + 1 }, () => ({
        address: encodingA.transactions[0].to,
        storageKeys: [],
      })),
    })).toThrowError(expect.objectContaining({ code: "MALFORMED_PREPARED_TRANSACTION" }));
  });
});
