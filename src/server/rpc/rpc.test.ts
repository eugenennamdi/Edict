import { validateAssetManifestV1 } from "@/core";
import { TOKENIZER_ADDRESS, createValidRawManifest } from "@/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import type { ExecutionRunV4 } from "../execution/types";
import { upgradePreparedRunToV4 } from "../execution/v4-transitions";
import { createTrustedSepoliaRpcClient } from "./client";
import { compareNormalizedTransaction, compareOnchainTransaction } from "./comparison";
import {
  rawRpcBlockSchema,
  rawRpcReceiptSchema,
  rawRpcTransactionSchema,
  rpcAddressSchema,
  rpcCalldataSchema,
  rpcQuantitySchema,
} from "./contracts";
import { evaluateReceiptAndFinality } from "./finality";
import { applyPreparedStaleTransition, evaluatePreparedFreshness } from "./freshness";
import type { NormalizedRpcTransaction, RpcTransport } from "./types";
import fs from "node:fs";
import path from "node:path";

class FakeRpcTransport implements RpcTransport {
  #handlers: Map<string, (params?: readonly unknown[]) => unknown> = new Map();
  calls: Array<{ method: string; params?: readonly unknown[] }> = [];

  on(method: string, handler: (params?: readonly unknown[]) => unknown): this {
    this.#handlers.set(method, handler);
    return this;
  }

  async request(method: string, params?: readonly unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    const handler = this.#handlers.get(method);
    if (!handler) {
      throw new Error(`Unhandled RPC method in FakeRpcTransport: ${method}`);
    }
    return handler(params);
  }
}

const TO = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const FINALIZED_BLOCK_HASH = `0x${"ef".repeat(32)}`;
const NOW = "2026-09-11T12:00:00.000Z";

const UNSIGNED_TOKENIZE_TX = {
  from: TOKENIZER_ADDRESS,
  to: TO,
  value: "0x0",
  nonce: "0x5",
  chainId: "0xaa36a7",
  data: "0x12345678aabb",
  type: "0x2",
  maxPriorityFeePerGas: "0x4",
  maxFeePerGas: "0x20",
  gasLimit: "0x100",
};

async function createPreparedTestRun(): Promise<ExecutionRunV4> {
  const validation = validateAssetManifestV1(createValidRawManifest());
  if (!validation.ok) throw new Error("Manifest invalid");
  let tick = 0;
  let id = 0;
  const service = new ExecutionRunService({
    repository: new InMemoryExecutionRunRepository(),
    clock: { nowIso: () => new Date(Date.UTC(2026, 8, 11, 9, 0, tick++)).toISOString() },
    ids: {
      runId: () => "11111111-1111-4111-8111-111111111111",
      operationId: () => `operation-${++id}`,
      eventId: () => `event-${++id}`,
    },
  });
  const created = await service.createRun(validation.value);
  const approved = await service.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, "2026-09-11T09:00:01.000Z"),
  });
  const preparing = await service.beginPrepare(approved.id, approved.revision, "TOKENIZE");
  const prepared = await service.recordPrepared(preparing.id, preparing.revision, "TOKENIZE", {
    txId: "brickken-tx-1",
    unsignedTransaction: UNSIGNED_TOKENIZE_TX,
  });
  return upgradePreparedRunToV4(prepared, "TOKENIZE", {
    attemptId: "attempt-1",
    freshnessPolicyVersion: "policy-v1",
  });
}

describe("Trusted Sepolia RPC client & contracts", () => {
  it("1. verifies correct Sepolia chain (11155111 / 0xaa36a7) and caches session verification", async () => {
    const transport = new FakeRpcTransport().on("eth_chainId", () => "0xaa36a7");
    const client = createTrustedSepoliaRpcClient(transport);

    await client.verifyChain();
    expect(client.chainId).toBe("11155111");

    // Second call should reuse verified session and not re-issue eth_chainId
    await client.verifyChain();
    expect(transport.calls.filter((c) => c.method === "eth_chainId").length).toBe(1);
  });

  it("2. rejects wrong chain on verification", async () => {
    const transport = new FakeRpcTransport().on("eth_chainId", () => "0x1"); // Mainnet
    const client = createTrustedSepoliaRpcClient(transport);

    await expect(client.verifyChain()).rejects.toThrow(/Unsupported chain ID/);
  });

  it("3. exact pending nonce returns ELIGIBLE freshness evidence", async () => {
    const run = await createPreparedTestRun();
    const transport = new FakeRpcTransport()
      .on("eth_chainId", () => "0xaa36a7")
      .on("eth_getTransactionCount", () => "0x5") // Matches prepared nonce 0x5
      .on("eth_getBalance", () => "0x1000000000000000") // Ample balance
      .on("eth_getBlockByNumber", () => ({
        number: "0x10",
        hash: BLOCK_HASH,
        parentHash: `0x${"00".repeat(32)}`,
        baseFeePerGas: "0x10", // 0x10 <= maxFeePerGas 0x20
      }));
    const client = createTrustedSepoliaRpcClient(transport);

    const freshness = await evaluatePreparedFreshness({
      client,
      run,
      kind: "TOKENIZE",
      policyVersion: "policy-v1",
      observedAt: NOW,
    });

    expect(freshness.outcome).toBe("ELIGIBLE");
    expect(freshness.eligible).toBe(true);
    expect(freshness.nonceStatus).toBe("FRESH");
    expect(freshness.nonceEvidence?.status).toBe("FRESH");
    expect(freshness.nonceEvidence?.observedPendingNonce).toBe("0x5");
    expect(freshness.balanceStatus).toBe("SUFFICIENT");
    expect(freshness.feeFreshnessStatus).toBe("FRESH");
  });

  it("4. stale nonce returns STALE_NONCE and supports markPreparedStaleV4 transition", async () => {
    const run = await createPreparedTestRun();
    const transport = new FakeRpcTransport()
      .on("eth_chainId", () => "0xaa36a7")
      .on("eth_getTransactionCount", () => "0x6") // Stale: expected 0x5
      .on("eth_getBalance", () => "0x1000000000000000")
      .on("eth_getBlockByNumber", () => ({
        number: "0x10",
        hash: BLOCK_HASH,
        parentHash: `0x${"00".repeat(32)}`,
        baseFeePerGas: "0x10",
      }));
    const client = createTrustedSepoliaRpcClient(transport);

    const freshness = await evaluatePreparedFreshness({
      client,
      run,
      kind: "TOKENIZE",
      policyVersion: "policy-v1",
      observedAt: NOW,
    });

    expect(freshness.outcome).toBe("STALE_NONCE");
    expect(freshness.eligible).toBe(false);
    expect(freshness.nonceStatus).toBe("STALE");
    expect(freshness.nonceEvidence?.status).toBe("STALE");

    // Transition run to PREPARED_STALE using the stale evidence
    const staleRun = await applyPreparedStaleTransition({
      run,
      kind: "TOKENIZE",
      foundation: { attemptId: "attempt-1", freshnessPolicyVersion: "policy-v1" },
      freshness,
      id: "event-stale-1",
      at: NOW,
    });

    expect(staleRun.operations[0].stage).toBe("PREPARED_STALE");
    expect(staleRun.operations[0].preparationAttempts[0].state).toBe("STALE");
    expect(staleRun.operations[0].preparationAttempts[0].staleReason).toBe("NONCE_MISMATCH");
  });

  it("5. RPC unavailable does NOT mark stale and returns an unauthorized result", async () => {
    const run = await createPreparedTestRun();
    const transport = new FakeRpcTransport()
      .on("eth_chainId", () => "0xaa36a7")
      .on("eth_getTransactionCount", () => {
        throw new Error("RPC gateway timeout 504");
      });
    const client = createTrustedSepoliaRpcClient(transport);

    const freshness = await evaluatePreparedFreshness({
      client,
      run,
      kind: "TOKENIZE",
      policyVersion: "policy-v1",
      observedAt: NOW,
    });

    expect(freshness.outcome).toBe("RPC_UNAVAILABLE");
    expect(freshness.eligible).toBe(false);
    expect(freshness.nonceStatus).toBe("UNAVAILABLE");
    expect(freshness.nonceEvidence).toBeNull();
    // Verify run remains PREPARED without mutation
    expect(run.operations[0].stage).toBe("PREPARED");
  });

  it("6. evaluates sufficient vs insufficient balance (balance >= value + maxFee)", async () => {
    const run = await createPreparedTestRun();
    // preparedValue = 0x0, maxFeePerGas = 0x20, gasLimit = 0x100 -> maxNetworkFee = 0x2000 (8192 wei)
    const transport = new FakeRpcTransport()
      .on("eth_chainId", () => "0xaa36a7")
      .on("eth_getTransactionCount", () => "0x5")
      .on("eth_getBalance", () => "0x1000") // 4096 wei < 8192 wei required
      .on("eth_getBlockByNumber", () => ({
        number: "0x10",
        hash: BLOCK_HASH,
        parentHash: `0x${"00".repeat(32)}`,
        baseFeePerGas: "0x10",
      }));
    const client = createTrustedSepoliaRpcClient(transport);

    const freshness = await evaluatePreparedFreshness({
      client,
      run,
      kind: "TOKENIZE",
      policyVersion: "policy-v1",
      observedAt: NOW,
    });

    expect(freshness.outcome).toBe("INSUFFICIENT_BALANCE");
    expect(freshness.eligible).toBe(false);
    expect(freshness.balanceStatus).toBe("INSUFFICIENT");
    expect(freshness.nonceStatus).toBe("FRESH");
  });

  it("7. evaluates fee freshness (baseFeePerGas > maxFeePerGas produces FEE_CAP_EXCEEDED_BY_BASE_FEE)", async () => {
    const run = await createPreparedTestRun();
    // maxFeePerGas = 0x20 (32 wei), baseFee = 0x30 (48 wei) -> fee cap exceeded
    const transport = new FakeRpcTransport()
      .on("eth_chainId", () => "0xaa36a7")
      .on("eth_getTransactionCount", () => "0x5")
      .on("eth_getBalance", () => "0x1000000000000000")
      .on("eth_getBlockByNumber", () => ({
        number: "0x10",
        hash: BLOCK_HASH,
        parentHash: `0x${"00".repeat(32)}`,
        baseFeePerGas: "0x30", // Exceeds maxFeePerGas 0x20
      }));
    const client = createTrustedSepoliaRpcClient(transport);

    const freshness = await evaluatePreparedFreshness({
      client,
      run,
      kind: "TOKENIZE",
      policyVersion: "policy-v1",
      observedAt: NOW,
    });

    expect(freshness.outcome).toBe("FEE_CAP_EXCEEDED_BY_BASE_FEE");
    expect(freshness.eligible).toBe(false);
    expect(freshness.feeFreshnessStatus).toBe("FEE_CAP_EXCEEDED_BY_BASE_FEE");
    expect(freshness.nonceStatus).toBe("FRESH");
    expect(freshness.balanceStatus).toBe("SUFFICIENT");
  });

  it("7b. freshness evaluation derives required balance and base-fee freshness strictly from authorizedCaps when prepared defaults != authorized cap", async () => {
    const run = await createPreparedTestRun();
    const activeAttempt = run.operations[0].preparationAttempts[0];

    // Synthetic fixture where prepared defaults != authorized caps:
    // - preparedDefaults: gasLimit=0x100 (256), maxFeePerGas=0x20 (32) -> product = 8,192 (0x2000)
    // - authorizedCaps: gasLimit=0x200 (512), maxFeePerGas=0x40 (64), maximumNetworkFeeWei=0x8000 (32,768)
    const syntheticRun: ExecutionRunV4 = {
      ...run,
      operations: [
        {
          ...run.operations[0],
          preparationAttempts: [
            {
              ...activeAttempt,
              feeAuthorization: {
                ...activeAttempt.feeAuthorization!,
                preparedDefaults: {
                  gasLimit: "0x100",
                  maxFeePerGas: "0x20",
                  maxPriorityFeePerGas: "0x4",
                },
                authorizedCaps: {
                  gasLimit: "0x200",
                  maxFeePerGas: "0x40",
                  maxPriorityFeePerGas: "0x4",
                  maximumNetworkFeeWei: "0x8000",
                },
              },
            },
          ],
        },
        run.operations[1],
        run.operations[2],
      ],
    };

    // Subtest A: Balance is 10,000 wei (0x2710).
    // 10,000 > prepared product (8,192 / 0x2000), but 10,000 < authorized cap (32,768 / 0x8000).
    // Must evaluate INSUFFICIENT based on authorized cap!
    const transportA = new FakeRpcTransport()
      .on("eth_chainId", () => "0xaa36a7")
      .on("eth_getTransactionCount", () => "0x5")
      .on("eth_getBalance", () => "0x2710") // 10,000 wei
      .on("eth_getBlockByNumber", () => ({
        number: "0x10",
        hash: BLOCK_HASH,
        parentHash: `0x${"00".repeat(32)}`,
        baseFeePerGas: "0x10", // 16 wei <= 64 wei
      }));
    const clientA = createTrustedSepoliaRpcClient(transportA);

    const freshnessA = await evaluatePreparedFreshness({
      client: clientA,
      run: syntheticRun,
      kind: "TOKENIZE",
      policyVersion: "policy-v1",
      observedAt: NOW,
    });

    expect(freshnessA.outcome).toBe("INSUFFICIENT_BALANCE");
    expect(freshnessA.balanceStatus).toBe("INSUFFICIENT");
    expect(freshnessA.requiredBalanceWei).toBe("0x8000"); // 32,768 wei from authorized cap, NOT 0x2000
    expect(freshnessA.authorizedMaxFeeWei).toBe("0x40"); // 64 wei from authorized cap, NOT 0x20

    // Subtest B: Base fee is 48 wei (0x30).
    // 48 > prepared default maxFeePerGas (32 / 0x20), but 48 <= authorized cap maxFeePerGas (64 / 0x40).
    // With sufficient balance (50,000 wei / 0xc350), fee freshness must be FRESH based on authorized cap!
    const transportB = new FakeRpcTransport()
      .on("eth_chainId", () => "0xaa36a7")
      .on("eth_getTransactionCount", () => "0x5")
      .on("eth_getBalance", () => "0xc350") // 50,000 wei >= 32,768 wei
      .on("eth_getBlockByNumber", () => ({
        number: "0x10",
        hash: BLOCK_HASH,
        parentHash: `0x${"00".repeat(32)}`,
        baseFeePerGas: "0x30", // 48 wei: > 32 wei (default) but <= 64 wei (cap)
      }));
    const clientB = createTrustedSepoliaRpcClient(transportB);

    const freshnessB = await evaluatePreparedFreshness({
      client: clientB,
      run: syntheticRun,
      kind: "TOKENIZE",
      policyVersion: "policy-v1",
      observedAt: NOW,
    });

    expect(freshnessB.outcome).toBe("ELIGIBLE");
    expect(freshnessB.eligible).toBe(true);
    expect(freshnessB.feeFreshnessStatus).toBe("FRESH"); // Evaluated against 0x40 authorized cap!
    expect(freshnessB.authorizedMaxFeeWei).toBe("0x40");
    expect(freshnessB.balanceStatus).toBe("SUFFICIENT");
  });

  it("8. rejects malformed RPC quantities (leading zeroes, non-hex, negative, overflow)", () => {
    expect(() => rpcQuantitySchema.parse("0x01")).toThrow();
    expect(() => rpcQuantitySchema.parse("0x00")).toThrow();
    expect(() => rpcQuantitySchema.parse("-0x1")).toThrow();
    expect(() => rpcQuantitySchema.parse("10")).toThrow();
    expect(() => rpcQuantitySchema.parse("0xGHI")).toThrow();
    expect(() => rpcQuantitySchema.parse(`0x1${"0".repeat(64)}`)).toThrow(/Quantity exceeds uint256/);

    expect(rpcQuantitySchema.parse("0x0")).toBe("0x0");
    expect(rpcQuantitySchema.parse("0x1")).toBe("0x1");
    expect(rpcQuantitySchema.parse("0x1234abcd")).toBe("0x1234abcd");

    // Rejects inconsistent mined location fields in rawRpcTransactionSchema
    expect(() =>
      rawRpcTransactionSchema.parse({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x",
        value: "0x0",
        nonce: "0x1",
        type: "0x2",
        gas: "0x5208",
        blockHash: BLOCK_HASH,
        blockNumber: null, // Inconsistent with non-null blockHash!
        transactionIndex: null,
      }),
    ).toThrow(/inconsistent mined location fields/);

    // Rejects invalid receipt status in rawRpcReceiptSchema
    expect(() =>
      rawRpcReceiptSchema.parse({
        transactionHash: TX_HASH,
        transactionIndex: "0x0",
        blockHash: BLOCK_HASH,
        blockNumber: "0x1",
        from: TOKENIZER_ADDRESS,
        to: TO,
        cumulativeGasUsed: "0x1",
        gasUsed: "0x1",
        effectiveGasPrice: "0x1",
        contractAddress: null,
        logs: [],
        type: "0x2",
        status: "0x2" as unknown as "0x0" | "0x1",
      }),
    ).toThrow();

    // Rejects malformed block in rawRpcBlockSchema
    expect(() =>
      rawRpcBlockSchema.parse({
        number: "not-a-hex-quantity",
        hash: BLOCK_HASH,
        parentHash: BLOCK_HASH,
      }),
    ).toThrow();
  });

  it("8b. normalizes 20-byte Ethereum addresses to canonical lowercase and rejects invalid formats", () => {
    // Valid lowercase remains unchanged
    expect(rpcAddressSchema.parse("0x4444444444444444444444444444444444444444")).toBe(
      "0x4444444444444444444444444444444444444444",
    );
    // Valid mixed-case normalized to canonical lowercase (NOT checksummed lowercase)
    expect(rpcAddressSchema.parse("0xAbCdE1234567890aBcDeF1234567890AbCdEf123")).toBe(
      "0xabcde1234567890abcdef1234567890abcdef123",
    );
    // Valid all-uppercase normalized to canonical lowercase
    expect(rpcAddressSchema.parse("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    // Invalid length: 19 bytes (38 chars)
    expect(() => rpcAddressSchema.parse("0x12345678901234567890123456789012345678")).toThrow();
    // Invalid length: 21 bytes (42 chars)
    expect(() => rpcAddressSchema.parse("0x123456789012345678901234567890123456789012")).toThrow();
    // Non-hex characters
    expect(() => rpcAddressSchema.parse("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow();
    // Missing 0x prefix
    expect(() => rpcAddressSchema.parse("4444444444444444444444444444444444444444")).toThrow();
  });

  it("9. rejects oversized calldata (> 131,072 bytes)", () => {
    const validCalldata = `0x${"ab".repeat(131_072)}`;
    expect(rpcCalldataSchema.parse(validCalldata)).toBe(validCalldata);

    const oversizedCalldata = `0x${"ab".repeat(131_073)}`;
    expect(() => rpcCalldataSchema.parse(oversizedCalldata)).toThrow();
  });

  describe("Transaction comparison and presence states", () => {
    it("10. each of the exact six immutable fields independently causes IMMUTABLE_MISMATCH", async () => {
      const run = await createPreparedTestRun();
      const attempt = run.operations[0].preparationAttempts[0];
      const immutable = attempt.immutableIdentity!;
      const feeAuth = attempt.feeAuthorization!;

      const validBase: NormalizedRpcTransaction = {
        hash: TX_HASH,
        chainId: "11155111",
        rpcChainId: "0xaa36a7",
        from: immutable.from,
        to: immutable.to,
        input: immutable.data,
        value: immutable.value,
        nonce: immutable.nonce,
        type: "0x2",
        gas: feeAuth.preparedDefaults.gasLimit,
        gasPrice: null,
        maxFeePerGas: feeAuth.preparedDefaults.maxFeePerGas,
        maxPriorityFeePerGas: feeAuth.preparedDefaults.maxPriorityFeePerGas,
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
        presence: "MINED",
      };

      const mismatches: Array<[string, Partial<NormalizedRpcTransaction>]> = [
        ["chainId", { chainId: "1" }],
        ["from", { from: "0x9999999999999999999999999999999999999999" }],
        ["to", { to: "0x2222222222222222222222222222222222222222" }],
        ["input/data", { input: "0xdeadbeef" }],
        ["value", { value: "0x999" }],
        ["nonce", { nonce: "0x999" }],
      ];

      for (const [field, patch] of mismatches) {
        const result = compareNormalizedTransaction({
          transaction: { ...validBase, ...patch },
          expectedImmutableIdentity: immutable,
          expectedFeeAuthorization: feeAuth,
          observedAt: NOW,
        });

        expect(result.outcome, `field ${field} should cause IMMUTABLE_MISMATCH`).toBe(
          "IMMUTABLE_MISMATCH",
        );
        expect(result.immutableIdentityStatus).toBe("MISMATCH");
        expect(result.feeAuthorizationStatus).toBe("NOT_EVALUATED");
        expect(result.reconciliationRequired).toBe(true);
      }
    });

    it("11. fee compliant transaction produces IMMUTABLE_MATCH + FEE_COMPLIANT", async () => {
      const run = await createPreparedTestRun();
      const attempt = run.operations[0].preparationAttempts[0];
      const immutable = attempt.immutableIdentity!;
      const feeAuth = attempt.feeAuthorization!;

      const tx: NormalizedRpcTransaction = {
        hash: TX_HASH,
        chainId: "11155111",
        rpcChainId: "0xaa36a7",
        from: immutable.from,
        to: immutable.to,
        input: immutable.data,
        value: immutable.value,
        nonce: immutable.nonce,
        type: "0x2",
        gas: feeAuth.preparedDefaults.gasLimit,
        gasPrice: null,
        maxFeePerGas: feeAuth.preparedDefaults.maxFeePerGas,
        maxPriorityFeePerGas: feeAuth.preparedDefaults.maxPriorityFeePerGas,
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
        presence: "MINED",
      };

      const result = compareNormalizedTransaction({
        transaction: tx,
        expectedImmutableIdentity: immutable,
        expectedFeeAuthorization: feeAuth,
        observedAt: NOW,
      });

      expect(result.outcome).toBe("IMMUTABLE_MATCH + FEE_COMPLIANT");
      expect(result.immutableIdentityStatus).toBe("MATCH");
      expect(result.feeAuthorizationStatus).toBe("WITHIN_ENVELOPE");
      expect(result.feePolicyViolationCode).toBeNull();
      expect(result.evidence?.observedMaximumNetworkFeeWei).toBe(
        feeAuth.authorizedCaps.maximumNetworkFeeWei,
      );
      expect(result.reconciliationRequired).toBe(false);

      // Verify compareOnchainTransaction through client end-to-end
      const clientTransport = new FakeRpcTransport()
        .on("eth_chainId", () => "0xaa36a7")
        .on("eth_getTransactionByHash", () => ({
          hash: TX_HASH,
          chainId: "0xaa36a7",
          from: immutable.from,
          to: immutable.to,
          input: immutable.data,
          value: immutable.value,
          nonce: immutable.nonce,
          type: "0x2",
          gas: feeAuth.preparedDefaults.gasLimit,
          maxFeePerGas: feeAuth.preparedDefaults.maxFeePerGas,
          maxPriorityFeePerGas: feeAuth.preparedDefaults.maxPriorityFeePerGas,
          blockHash: BLOCK_HASH,
          blockNumber: "0x10",
          transactionIndex: "0x0",
        }));
      const client = createTrustedSepoliaRpcClient(clientTransport);
      const clientResult = await compareOnchainTransaction({
        client,
        txHash: TX_HASH,
        expectedImmutableIdentity: immutable,
        expectedFeeAuthorization: feeAuth,
        observedAt: NOW,
      });
      expect(clientResult.outcome).toBe("IMMUTABLE_MATCH + FEE_COMPLIANT");
    });

    it("11b. gas lower than prepared but within authorization produces immutable identity MATCH and FEE_COMPLIANT", async () => {
      const run = await createPreparedTestRun();
      const attempt = run.operations[0].preparationAttempts[0];
      const immutable = attempt.immutableIdentity!;
      const feeAuth = attempt.feeAuthorization!;

      // Prepared gas was 0x100 (256); actual tx gas is 0x80 (128) - lower than prepared
      const tx: NormalizedRpcTransaction = {
        hash: TX_HASH,
        chainId: "11155111",
        rpcChainId: "0xaa36a7",
        from: immutable.from,
        to: immutable.to,
        input: immutable.data,
        value: immutable.value,
        nonce: immutable.nonce,
        type: "0x2",
        gas: "0x80", // Gas lower than prepared default 0x100
        gasPrice: null,
        maxFeePerGas: feeAuth.preparedDefaults.maxFeePerGas,
        maxPriorityFeePerGas: feeAuth.preparedDefaults.maxPriorityFeePerGas,
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
        presence: "MINED",
      };

      const result = compareNormalizedTransaction({
        transaction: tx,
        expectedImmutableIdentity: immutable,
        expectedFeeAuthorization: feeAuth,
        observedAt: NOW,
      });

      // Immutable identity matches, and gas is within authorized cap -> FEE_COMPLIANT
      expect(result.outcome).toBe("IMMUTABLE_MATCH + FEE_COMPLIANT");
      expect(result.immutableIdentityStatus).toBe("MATCH");
      expect(result.feeAuthorizationStatus).toBe("WITHIN_ENVELOPE");
      expect(result.feePolicyViolationCode).toBeNull();
      expect(result.reconciliationRequired).toBe(false);
    });

    it("12. gas, maxFee, or priority fee changed above cap produce POLICY_VIOLATION_ONCHAIN, NEVER IMMUTABLE_MISMATCH", async () => {
      const run = await createPreparedTestRun();
      const attempt = run.operations[0].preparationAttempts[0];
      const immutable = attempt.immutableIdentity!;
      const feeAuth = attempt.feeAuthorization!;

      const validTx: NormalizedRpcTransaction = {
        hash: TX_HASH,
        chainId: "11155111",
        rpcChainId: "0xaa36a7",
        from: immutable.from,
        to: immutable.to,
        input: immutable.data,
        value: immutable.value,
        nonce: immutable.nonce,
        type: "0x2",
        gas: feeAuth.preparedDefaults.gasLimit,
        gasPrice: null,
        maxFeePerGas: feeAuth.preparedDefaults.maxFeePerGas,
        maxPriorityFeePerGas: feeAuth.preparedDefaults.maxPriorityFeePerGas,
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
        presence: "MINED",
      };

      // 1. Gas changed above authorized cap:
      // A gasLimit difference by itself must NEVER become IMMUTABLE_MISMATCH
      const gasExceededResult = compareNormalizedTransaction({
        transaction: { ...validTx, gas: "0x200" }, // Exceeds cap 0x100
        expectedImmutableIdentity: immutable,
        expectedFeeAuthorization: feeAuth,
        observedAt: NOW,
      });
      expect(gasExceededResult.outcome).toBe("IMMUTABLE_MATCH + POLICY_VIOLATION_ONCHAIN");
      expect(gasExceededResult.outcome).not.toBe("IMMUTABLE_MISMATCH");
      expect(gasExceededResult.immutableIdentityStatus).toBe("MATCH");
      expect(gasExceededResult.feeAuthorizationStatus).toBe("POLICY_VIOLATION");
      expect(gasExceededResult.feePolicyViolationCode).toBe("GAS_LIMIT_CAP_EXCEEDED");
      expect(gasExceededResult.reconciliationRequired).toBe(true);

      // 2. maxFee changed above cap:
      const maxFeeExceededResult = compareNormalizedTransaction({
        transaction: { ...validTx, maxFeePerGas: "0x30" }, // Exceeds cap 0x20
        expectedImmutableIdentity: immutable,
        expectedFeeAuthorization: feeAuth,
        observedAt: NOW,
      });
      expect(maxFeeExceededResult.outcome).toBe("IMMUTABLE_MATCH + POLICY_VIOLATION_ONCHAIN");
      expect(maxFeeExceededResult.outcome).not.toBe("IMMUTABLE_MISMATCH");
      expect(maxFeeExceededResult.immutableIdentityStatus).toBe("MATCH");
      expect(maxFeeExceededResult.feeAuthorizationStatus).toBe("POLICY_VIOLATION");
      expect(maxFeeExceededResult.feePolicyViolationCode).toBe("MAX_FEE_CAP_EXCEEDED");
      expect(maxFeeExceededResult.reconciliationRequired).toBe(true);

      // 3. priority fee changed above cap:
      const priorityFeeExceededResult = compareNormalizedTransaction({
        transaction: { ...validTx, maxPriorityFeePerGas: "0x25" }, // Exceeds cap 0x4
        expectedImmutableIdentity: immutable,
        expectedFeeAuthorization: feeAuth,
        observedAt: NOW,
      });
      expect(priorityFeeExceededResult.outcome).toBe("IMMUTABLE_MATCH + POLICY_VIOLATION_ONCHAIN");
      expect(priorityFeeExceededResult.outcome).not.toBe("IMMUTABLE_MISMATCH");
      expect(priorityFeeExceededResult.immutableIdentityStatus).toBe("MATCH");
      expect(priorityFeeExceededResult.feeAuthorizationStatus).toBe("POLICY_VIOLATION");
      expect(priorityFeeExceededResult.feePolicyViolationCode).toBe("PRIORITY_FEE_CAP_EXCEEDED");
      expect(priorityFeeExceededResult.reconciliationRequired).toBe(true);

      // 4. Other fee violations (model, legacy price, access list, invalid evidence):
      const otherViolations: Array<[string, Partial<NormalizedRpcTransaction>, string]> = [
        ["LEGACY_GAS_PRICE", { gasPrice: "0x10" }, "LEGACY_GAS_PRICE"],
        ["FEE_MODEL_CHANGED", { type: "0x0" }, "FEE_MODEL_CHANGED"],
        [
          "ACCESS_LIST_CHANGED",
          { accessList: [{ address: "0x3333333333333333333333333333333333333333", storageKeys: [] }] },
          "ACCESS_LIST_CHANGED",
        ],
        ["INVALID_FEE_EVIDENCE", { maxFeePerGas: "invalid-fee-quantity" as unknown as string }, "INVALID_FEE_EVIDENCE"],
      ];

      for (const [name, patch, expectedCode] of otherViolations) {
        const result = compareNormalizedTransaction({
          transaction: { ...validTx, ...patch },
          expectedImmutableIdentity: immutable,
          expectedFeeAuthorization: feeAuth,
          observedAt: NOW,
        });

        expect(result.outcome, `violation ${name} should produce POLICY_VIOLATION_ONCHAIN`).toBe(
          "IMMUTABLE_MATCH + POLICY_VIOLATION_ONCHAIN",
        );
        expect(result.immutableIdentityStatus).toBe("MATCH");
        expect(result.feeAuthorizationStatus).toBe("POLICY_VIOLATION");
        expect(result.feePolicyViolationCode).toBe(expectedCode);
        expect(result.reconciliationRequired).toBe(true);
      }
    });

    it("13. distinguishes presence states: NOT_FOUND vs UNMINED vs MINED", async () => {
      const transport = new FakeRpcTransport()
        .on("eth_chainId", () => "0xaa36a7")
        .on("eth_getTransactionByHash", (params) => {
          const hash = params?.[0];
          if (hash === `0x${"00".repeat(32)}`) return null; // NOT_FOUND
          if (hash === `0x${"11".repeat(32)}`) {
            // UNMINED: blockHash/blockNumber null
            return {
              hash: `0x${"11".repeat(32)}`,
              chainId: "0xaa36a7",
              from: TOKENIZER_ADDRESS,
              to: TO,
              input: "0x",
              value: "0x0",
              nonce: "0x1",
              type: "0x2",
              gas: "0x5208",
              maxFeePerGas: "0x20",
              maxPriorityFeePerGas: "0x2",
              blockHash: null,
              blockNumber: null,
              transactionIndex: null,
            };
          }
          // MINED
          return {
            hash: TX_HASH,
            chainId: "0xaa36a7",
            from: TOKENIZER_ADDRESS,
            to: TO,
            input: "0x",
            value: "0x0",
            nonce: "0x1",
            type: "0x2",
            gas: "0x5208",
            maxFeePerGas: "0x20",
            maxPriorityFeePerGas: "0x2",
            blockHash: BLOCK_HASH,
            blockNumber: "0x10",
            transactionIndex: "0x0",
          };
        });

      const client = createTrustedSepoliaRpcClient(transport);

      const notFound = await client.getTransaction(`0x${"00".repeat(32)}`);
      expect(notFound).toBeNull();

      const unmined = await client.getTransaction(`0x${"11".repeat(32)}`);
      expect(unmined).not.toBeNull();
      expect(unmined?.presence).toBe("UNMINED");
      expect(unmined?.blockHash).toBeNull();
      expect(unmined?.blockNumber).toBeNull();

      const mined = await client.getTransaction(TX_HASH);
      expect(mined).not.toBeNull();
      expect(mined?.presence).toBe("MINED");
      expect(mined?.blockHash).toBe(BLOCK_HASH);
      expect(mined?.blockNumber).toBe("0x10");
    });
  });

  describe("Receipt, canonicality, and finality verification", () => {
    it("14. successful receipt (status 0x1) produces SUCCESS receiptStatus", async () => {
      const transport = new FakeRpcTransport()
        .on("eth_chainId", () => "0xaa36a7")
        .on("eth_getTransactionReceipt", () => ({
          transactionHash: TX_HASH,
          transactionIndex: "0x0",
          blockHash: BLOCK_HASH,
          blockNumber: "0x10",
          from: TOKENIZER_ADDRESS,
          to: TO,
          cumulativeGasUsed: "0x50",
          gasUsed: "0x50",
          effectiveGasPrice: "0x15",
          contractAddress: null,
          logs: [],
          type: "0x2",
          status: "0x1",
        }))
        .on("eth_getBlockByNumber", (params) => {
          if (params?.[0] === "finalized") return null;
          return { number: "0x10", hash: BLOCK_HASH, parentHash: `0x${"00".repeat(32)}` };
        });
      const client = createTrustedSepoliaRpcClient(transport);

      const result = await evaluateReceiptAndFinality({
        client,
        txHash: TX_HASH,
        expectedFrom: TOKENIZER_ADDRESS,
        expectedTo: TO,
        expectedType: "0x2",
        gasLimit: "0x100",
        observedAt: NOW,
      });

      expect(result.receiptStatus).toBe("SUCCESS");
      expect(result.canonicality).toBe("CANONICAL");
      expect(result.evidence?.executionStatus).toBe("SUCCESS");
    });

    it("15. reverted receipt (status 0x0) produces REVERTED receiptStatus", async () => {
      const transport = new FakeRpcTransport()
        .on("eth_chainId", () => "0xaa36a7")
        .on("eth_getTransactionReceipt", () => ({
          transactionHash: TX_HASH,
          transactionIndex: "0x0",
          blockHash: BLOCK_HASH,
          blockNumber: "0x10",
          from: TOKENIZER_ADDRESS,
          to: TO,
          cumulativeGasUsed: "0x50",
          gasUsed: "0x50",
          effectiveGasPrice: "0x15",
          contractAddress: null,
          logs: [],
          type: "0x2",
          status: "0x0", // REVERTED
        }))
        .on("eth_getBlockByNumber", () => ({
          number: "0x10",
          hash: BLOCK_HASH,
          parentHash: `0x${"00".repeat(32)}`,
        }));
      const client = createTrustedSepoliaRpcClient(transport);

      const result = await evaluateReceiptAndFinality({
        client,
        txHash: TX_HASH,
        expectedFrom: TOKENIZER_ADDRESS,
        expectedTo: TO,
        observedAt: NOW,
      });

      expect(result.receiptStatus).toBe("REVERTED");
      expect(result.canonicality).toBe("CANONICAL");
      expect(result.evidence?.executionStatus).toBe("REVERTED");
    });

    it("16. reaches finality when finalizedBlock >= receipt block number", async () => {
      const transport = new FakeRpcTransport()
        .on("eth_chainId", () => "0xaa36a7")
        .on("eth_getTransactionReceipt", () => ({
          transactionHash: TX_HASH,
          transactionIndex: "0x0",
          blockHash: BLOCK_HASH,
          blockNumber: "0x10", // Block 16
          from: TOKENIZER_ADDRESS,
          to: TO,
          cumulativeGasUsed: "0x50",
          gasUsed: "0x50",
          effectiveGasPrice: "0x15",
          contractAddress: null,
          logs: [],
          type: "0x2",
          status: "0x1",
        }))
        .on("eth_getBlockByNumber", (params) => {
          if (params?.[0] === "finalized") {
            // Finalized head is at Block 0x20 (32 >= 16)
            return {
              number: "0x20",
              hash: FINALIZED_BLOCK_HASH,
              parentHash: `0x${"00".repeat(32)}`,
            };
          }
          return { number: "0x10", hash: BLOCK_HASH, parentHash: `0x${"00".repeat(32)}` };
        });
      const client = createTrustedSepoliaRpcClient(transport);

      const result = await evaluateReceiptAndFinality({
        client,
        txHash: TX_HASH,
        expectedFrom: TOKENIZER_ADDRESS,
        expectedTo: TO,
        observedAt: NOW,
      });

      expect(result.finality).toBe("FINALIZED");
      expect(result.evidence?.finalityStatus).toBe("FINALIZED");
      expect(result.evidence?.finalizedBlockHash).toBe(FINALIZED_BLOCK_HASH);
      expect(result.evidence?.finalizedBlockNumber).toBe("0x20");
    });

    it("17. retains INCLUDED when finalized head is unavailable or block is ahead of finalized head", async () => {
      const transport = new FakeRpcTransport()
        .on("eth_chainId", () => "0xaa36a7")
        .on("eth_getTransactionReceipt", () => ({
          transactionHash: TX_HASH,
          transactionIndex: "0x0",
          blockHash: BLOCK_HASH,
          blockNumber: "0x10",
          from: TOKENIZER_ADDRESS,
          to: TO,
          cumulativeGasUsed: "0x50",
          gasUsed: "0x50",
          effectiveGasPrice: "0x15",
          contractAddress: null,
          logs: [],
          type: "0x2",
          status: "0x1",
        }))
        .on("eth_getBlockByNumber", (params) => {
          if (params?.[0] === "finalized") return null; // Finalized head unavailable
          return { number: "0x10", hash: BLOCK_HASH, parentHash: `0x${"00".repeat(32)}` };
        });
      const client = createTrustedSepoliaRpcClient(transport);

      const result = await evaluateReceiptAndFinality({
        client,
        txHash: TX_HASH,
        expectedFrom: TOKENIZER_ADDRESS,
        expectedTo: TO,
        observedAt: NOW,
      });

      expect(result.finality).toBe("UNAVAILABLE");
      expect(result.evidence?.finalityStatus).toBe("INCLUDED");
      expect(result.evidence?.finalizedBlockHash).toBeNull();
      expect(result.evidence?.finalizedBlockNumber).toBeNull();
    });

    it("18. detects canonical block mismatch/reorg as CONTRADICTION", async () => {
      const reorgedBlockHash = `0x${"99".repeat(32)}`;
      const transport = new FakeRpcTransport()
        .on("eth_chainId", () => "0xaa36a7")
        .on("eth_getTransactionReceipt", () => ({
          transactionHash: TX_HASH,
          transactionIndex: "0x0",
          blockHash: BLOCK_HASH, // Receipt points to BLOCK_HASH
          blockNumber: "0x10",
          from: TOKENIZER_ADDRESS,
          to: TO,
          cumulativeGasUsed: "0x50",
          gasUsed: "0x50",
          effectiveGasPrice: "0x15",
          contractAddress: null,
          logs: [],
          type: "0x2",
          status: "0x1",
        }))
        .on("eth_getBlockByNumber", () => ({
          number: "0x10",
          hash: reorgedBlockHash, // Canonical block at height 0x10 is reorgedBlockHash != BLOCK_HASH
          parentHash: `0x${"00".repeat(32)}`,
        }));
      const client = createTrustedSepoliaRpcClient(transport);

      const result = await evaluateReceiptAndFinality({
        client,
        txHash: TX_HASH,
        expectedFrom: TOKENIZER_ADDRESS,
        expectedTo: TO,
        observedAt: NOW,
      });

      expect(result.canonicality).toBe("CONTRADICTION");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.evidence?.identityStatus).toBe("MISMATCH");
      expect(result.evidence?.reconciliationStatus).toBe("REQUIRED");
    });
  });

  it("19. verifies server-only boundary enforcement across RPC modules", () => {
    const rpcDir = path.join(process.cwd(), "src", "server", "rpc");
    const files = fs.readdirSync(rpcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const content = fs.readFileSync(path.join(rpcDir, file), "utf8");
      expect(
        content.startsWith('import "server-only";'),
        `File ${file} must enforce import "server-only"; as first line`,
      ).toBe(true);
    }
  });
});
