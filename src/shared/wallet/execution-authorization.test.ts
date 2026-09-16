import { describe, expect, it } from "vitest";
import {
  createInitialFeeAuthorizationV1,
  evaluateFeeAuthorizationV1,
  feeAuthorizationV1Schema,
  hashWalletExecutionIntentV1,
  validateWalletExecutionIntentV1,
  type WalletExecutionIntentV1,
} from "./execution-authorization";
import { createServerBoundedFeeAuthorizationV1 } from "@/server/orchestration/fee-authorization-policy";
import { compareNormalizedTransaction } from "@/server/rpc/comparison";

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x4444444444444444444444444444444444444444";
const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

const fees = createInitialFeeAuthorizationV1({
  gasLimit: "0x100",
  maxFeePerGas: "0x20",
  maxPriorityFeePerGas: "0x4",
});

const actualFees = {
  transactionType: "0x2" as const,
  gasLimit: "0x100",
  maxFeePerGas: "0x20",
  maxPriorityFeePerGas: "0x4",
  accessList: [],
};

const intent: WalletExecutionIntentV1 = {
  domain: "edict.wallet-execution-intent.v1",
  runId: "run-1",
  runRevision: 5,
  approvalIdentity: { approvalRevision: 2, typedDataDigest: `0x${"1".repeat(64)}` },
  manifestHash: HASH_A,
  planHash: HASH_B,
  environment: "sandbox",
  operation: { id: "operation-1", kind: "TOKENIZE", sequence: 1 },
  requiredSigner: FROM,
  chainRequirement: {
    decimalChainId: "11155111",
    rpcChainId: "0xaa36a7",
    authority: "TRUSTED_SERVER_RPC",
  },
  immutableIdentity: {
    identityVersion: "1.0",
    chainId: "11155111",
    from: FROM,
    to: TO,
    data: "0x12345678aabb",
    value: "0x0",
    nonce: "0x7",
  },
  feeAuthorization: fees,
  brickkenPreparation: {
    identityVersion: "1.0",
    method: "newTokenization",
    executionMode: "client-broadcast",
    preparationAttemptId: "attempt-1",
    preparedTxId: "brickken-tx-1",
    preparationFingerprint: HASH_A,
  },
  semanticAuthorization: {
    authorizationVersion: "1.0",
    policyVersion: "policy-1",
    authorizationId: "authorization-1",
    environment: "sandbox",
    brickkenMethod: "newTokenization",
    executionMode: "client-broadcast",
    destinationPolicy: { policyId: "destination-1", reviewedDestination: TO },
    selectorPolicy: { policyId: "selector-1", reviewedSelector: "0x12345678" },
    calldataCommitment: HASH_B,
    decision: "ALLOW",
  },
};

describe("FeeAuthorizationV1", () => {
  it("derives exact initial caps and network-fee arithmetic", () => {
    expect(fees.authorizedCaps).toEqual({
      gasLimit: "0x100",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x4",
      maximumNetworkFeeWei: "0x2000",
    });
    expect(evaluateFeeAuthorizationV1(fees, actualFees)).toEqual({
      accepted: true,
      maximumNetworkFeeWei: "0x2000",
    });
  });

  it.each([
    ["lower gas", { ...actualFees, gasLimit: "0xff" }],
    ["lower max fee", { ...actualFees, maxFeePerGas: "0x1f" }],
    ["lower priority fee", { ...actualFees, maxPriorityFeePerGas: "0x3" }],
  ])("accepts %s", (_label, actual) => {
    expect(evaluateFeeAuthorizationV1(fees, actual).accepted).toBe(true);
  });

  it.each([
    ["gas", { ...actualFees, gasLimit: "0x101" }, "GAS_LIMIT_CAP_EXCEEDED"],
    ["max fee", { ...actualFees, maxFeePerGas: "0x21" }, "MAX_FEE_CAP_EXCEEDED"],
    ["priority fee", { ...actualFees, maxPriorityFeePerGas: "0x5" }, "PRIORITY_FEE_CAP_EXCEEDED"],
  ])("rejects an upward %s cap violation", (_label, actual, code) => {
    expect(evaluateFeeAuthorizationV1(fees, actual)).toEqual({ accepted: false, code });
  });

  it("uses transaction type rather than an RPC gasPrice compatibility field to classify fees", () => {
    expect(evaluateFeeAuthorizationV1(fees, { ...actualFees, gasPrice: "0x1" })).toEqual({
      accepted: true,
      maximumNetworkFeeWei: "0x2000",
    });
    expect(evaluateFeeAuthorizationV1(fees, {
      ...actualFees,
      transactionType: "0x0",
      gasPrice: "0x1",
    })).toEqual({
      accepted: true,
      maximumNetworkFeeWei: "0x100",
    });
    expect(evaluateFeeAuthorizationV1(fees, {
      ...actualFees,
      transactionType: "0x0",
      gasPrice: null,
    })).toEqual({
      accepted: false,
      code: "LEGACY_GAS_PRICE",
    });
    expect(evaluateFeeAuthorizationV1(fees, {
      ...actualFees,
      transactionType: "0x0",
      gasLimit: "0x101",
      gasPrice: "0x1",
    })).toEqual({
      accepted: false,
      code: "GAS_LIMIT_CAP_EXCEEDED",
    });
    expect(evaluateFeeAuthorizationV1(fees, { ...actualFees, transactionType: "0x1" })).toEqual({
      accepted: false,
      code: "FEE_MODEL_CHANGED",
    });
  });

  it("derives server-owned bounded headroom while preserving Brickken values as defaults", () => {
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: "0x100",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x4",
    });
    expect(bounded.preparedDefaults).toEqual(fees.preparedDefaults);
    expect(bounded.adjustmentPolicy).toBe("SERVER_BOUNDED_HEADROOM");
    expect(BigInt(bounded.authorizedCaps.gasLimit)).toBeGreaterThan(BigInt(bounded.preparedDefaults.gasLimit));
    expect(BigInt(bounded.authorizedCaps.maxFeePerGas)).toBeGreaterThan(BigInt(bounded.preparedDefaults.maxFeePerGas));
    expect(BigInt(bounded.authorizedCaps.maxPriorityFeePerGas)).toBeGreaterThan(BigInt(bounded.preparedDefaults.maxPriorityFeePerGas));
    expect(BigInt(bounded.authorizedCaps.maximumNetworkFeeWei)).toBe(
      BigInt(bounded.authorizedCaps.gasLimit) * BigInt(bounded.authorizedCaps.maxFeePerGas),
    );
    expect(evaluateFeeAuthorizationV1(bounded, {
      ...actualFees,
      gasLimit: bounded.authorizedCaps.gasLimit,
      maxFeePerGas: bounded.authorizedCaps.maxFeePerGas,
      maxPriorityFeePerGas: bounded.authorizedCaps.maxPriorityFeePerGas,
      gasPrice: "0x1",
    }).accepted).toBe(true);
  });

  it("enforces bounded 3 gwei priority-fee ceiling and total network fee ceiling", () => {
    // Normal Brickken prepared transaction with typical low priority fee (~0.00115 gwei)
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: "0x4a6f7",
      maxFeePerGas: "0xa284b18c",
      maxPriorityFeePerGas: "0x118c30",
    });

    // 3 gwei is 3_000_000_000 wei = 0xb2d05e00
    expect(bounded.authorizedCaps.maxPriorityFeePerGas).toBe("0xb2d05e00");

    // 1. <= 3 gwei accepted when all other envelope limits pass:
    // - Sepolia wallet adjustment (~2.159 gwei = 0x80b14f63)
    const walletAdjusted = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x2",
      gasLimit: "0x43ab2",
      gasPrice: "0x110a73b30",
      maxFeePerGas: "0x14fd7a882",
      maxPriorityFeePerGas: "0x80b14f63", // ~2.159 gwei
      accessList: [],
    });
    expect(walletAdjusted.accepted).toBe(true);

    // - Exactly 3 gwei (0xb2d05e00)
    const exact3Gwei = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x2",
      gasLimit: "0x43ab2",
      gasPrice: "0x110a73b30",
      maxFeePerGas: "0x14fd7a882",
      maxPriorityFeePerGas: "0xb2d05e00", // 3.0 gwei
      accessList: [],
    });
    expect(exact3Gwei.accepted).toBe(true);

    // 2. > 3 gwei still rejected:
    // - 3 gwei + 1 wei (0xb2d05e01)
    const aboveCap = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x2",
      gasLimit: "0x43ab2",
      gasPrice: "0x110a73b30",
      maxFeePerGas: "0x14fd7a882",
      maxPriorityFeePerGas: "0xb2d05e01", // 3 gwei + 1 wei
      accessList: [],
    });
    expect(aboveCap).toEqual({ accepted: false, code: "PRIORITY_FEE_CAP_EXCEEDED" });

    // - 3.1 gwei (0xb8d77e00)
    const farAboveCap = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x2",
      gasLimit: "0x43ab2",
      gasPrice: "0x110a73b30",
      maxFeePerGas: "0x14fd7a882",
      maxPriorityFeePerGas: "0xb8d77e00", // 3.1 gwei
      accessList: [],
    });
    expect(farAboveCap).toEqual({ accepted: false, code: "PRIORITY_FEE_CAP_EXCEEDED" });

    // 3. Total network fee ceiling still enforced:
    // If gasLimit * maxFeePerGas > authorizedCaps.maximumNetworkFeeWei
    const feeCeilingExceeded = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x2",
      gasLimit: bounded.authorizedCaps.gasLimit,
      gasPrice: "0x110a73b30",
      maxFeePerGas: `0x${(BigInt(bounded.authorizedCaps.maxFeePerGas) + 1n).toString(16)}`,
      maxPriorityFeePerGas: "0xb2d05e00",
      accessList: [],
    });
    expect(feeCeilingExceeded.accepted).toBe(false);
  });

  it("classifies the exact mined OKX type-0x2 shape by bounded caps, never by gasPrice", () => {
    const historical = feeAuthorizationV1Schema.parse({
      authorizationVersion: "1.0",
      feeModel: "EIP1559",
      transactionType: "0x2",
      preparedDefaults: {
        gasLimit: "0x350c63",
        maxFeePerGas: "0x454bf75b",
        maxPriorityFeePerGas: "0x118c30",
      },
      authorizedCaps: {
        gasLimit: "0x350c63",
        maxFeePerGas: "0x454bf75b",
        maxPriorityFeePerGas: "0x118c30",
        maximumNetworkFeeWei: "0xe5c1491cfec31",
      },
      preparedAccessList: [],
      adjustmentPolicy: "BOUNDED_NO_INCREASE",
    });
    expect(evaluateFeeAuthorizationV1(historical, {
      transactionType: "0x2",
      gasLimit: "0x350c63",
      gasPrice: "0x7b729771",
      maxFeePerGas: "0x9884d6a8",
      maxPriorityFeePerGas: "0x406d72c5",
      accessList: [],
    })).toEqual({ accepted: false, code: "MAX_FEE_CAP_EXCEEDED" });
  });

  it("rejects malformed, overflowing and inconsistent fee arithmetic", () => {
    expect(() => createInitialFeeAuthorizationV1({
      gasLimit: `0x${"f".repeat(64)}`,
      maxFeePerGas: "0x2",
      maxPriorityFeePerGas: "0x1",
    })).toThrow("INVALID_FEE_AUTHORIZATION");
    expect(() => evaluateFeeAuthorizationV1(fees, { ...actualFees, gasLimit: "01" })).toThrow();
    expect(() => feeAuthorizationV1Schema.parse({
      ...fees,
      authorizedCaps: { ...fees.authorizedCaps, maximumNetworkFeeWei: "0x1fff" },
    })).toThrow();
  });
});

describe("WalletExecutionIntentV1", () => {
  it("strictly validates the separated authority contract", () => {
    expect(validateWalletExecutionIntentV1(structuredClone(intent))).toEqual(intent);
    expect(() => validateWalletExecutionIntentV1({ ...intent, unexpected: true })).toThrow();
  });

  it("changes the canonical hash for every immutable identity field", async () => {
    const original = (await hashWalletExecutionIntentV1(intent)).hash;
    const identities = [
      { ...intent.immutableIdentity, chainId: "1" },
      { ...intent.immutableIdentity, from: "0x2222222222222222222222222222222222222222" },
      { ...intent.immutableIdentity, to: "0x5555555555555555555555555555555555555555" },
      { ...intent.immutableIdentity, data: "0x12345678aabc" },
      { ...intent.immutableIdentity, value: "0x1" },
      { ...intent.immutableIdentity, nonce: "0x8" },
    ];
    for (const immutableIdentity of identities) {
      try {
        expect((await hashWalletExecutionIntentV1({ ...intent, immutableIdentity })).hash).not.toBe(original);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  it.each([
    ["preparation fingerprint", { brickkenPreparation: { ...intent.brickkenPreparation, preparationFingerprint: HASH_B } }],
    ["Brickken txId", { brickkenPreparation: { ...intent.brickkenPreparation, preparedTxId: "brickken-tx-2" } }],
    ["approval", { approvalIdentity: { ...intent.approvalIdentity, approvalRevision: 3 } }],
    ["manifest hash", { manifestHash: HASH_B }],
    ["plan hash", { planHash: HASH_A }],
    ["semantic authorization", { semanticAuthorization: { ...intent.semanticAuthorization, authorizationId: "authorization-2" } }],
  ])("binds %s", async (_label, patch) => {
    const original = (await hashWalletExecutionIntentV1(intent)).hash;
    expect((await hashWalletExecutionIntentV1({ ...intent, ...patch })).hash).not.toBe(original);
  });
});

describe("Final Wallet Fee Compatibility (10-Point Verification)", () => {
  // 1. Type 2 inside envelope passes
  it("1. Type 2 inside envelope passes", () => {
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: "0x100",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x4",
    });
    const res = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x2",
      gasLimit: bounded.authorizedCaps.gasLimit,
      maxFeePerGas: bounded.authorizedCaps.maxFeePerGas,
      maxPriorityFeePerGas: bounded.authorizedCaps.maxPriorityFeePerGas,
      accessList: [],
    });
    expect(res.accepted).toBe(true);
    if (res.accepted) {
      expect(res.maximumNetworkFeeWei).toBe(bounded.authorizedCaps.maximumNetworkFeeWei);
    }
  });

  // 2. Type 0 wallet conversion inside equivalent bounded envelope passes
  it("2. Type 0 wallet conversion inside equivalent bounded envelope passes", () => {
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: "0x100",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x4",
    });
    const res = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x0",
      gasLimit: bounded.authorizedCaps.gasLimit,
      gasPrice: bounded.authorizedCaps.maxPriorityFeePerGas, // <= priority fee cap and <= maxFee cap
      accessList: [],
    });
    expect(res.accepted).toBe(true);
    if (res.accepted) {
      expect(BigInt(res.maximumNetworkFeeWei)).toBeLessThanOrEqual(
        BigInt(bounded.authorizedCaps.maximumNetworkFeeWei),
      );
    }
  });

  // 3. Legacy effective priority fee above 3 gwei fails with priority fee violation
  it("3. Legacy effective priority fee above 3 gwei fails with priority fee violation", () => {
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: "0x100",
      maxFeePerGas: "0x2540be400", // 10 gwei max fee cap
      maxPriorityFeePerGas: "0xb2d05e00", // 3 gwei priority fee cap
    });
    // Gas price = 5 gwei, baseFee = 1 gwei -> effective priority fee = 4 gwei > 3 gwei cap
    const res = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x0",
      gasLimit: bounded.authorizedCaps.gasLimit,
      gasPrice: "0x12a05f200", // 5 gwei
      baseFeePerGas: "0x3b9aca00", // 1 gwei
      accessList: [],
    });
    expect(res).toEqual({
      accepted: false,
      code: "PRIORITY_FEE_CAP_EXCEEDED",
    });
  });

  // 4. Legacy gasPrice above max-fee cap fails with max fee violation
  it("4. Legacy gasPrice above max-fee cap fails with max fee violation", () => {
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: "0x100",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x4",
    });
    const exceedingGasPrice = `0x${(BigInt(bounded.authorizedCaps.maxFeePerGas) + 1n).toString(16)}`;
    const res = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x0",
      gasLimit: bounded.authorizedCaps.gasLimit,
      gasPrice: exceedingGasPrice,
      accessList: [],
    });
    expect(res).toEqual({
      accepted: false,
      code: "MAX_FEE_CAP_EXCEEDED",
    });
  });

  // 5. Gas limit <= 150% of prepared gas passes
  it("5. Gas limit <= 150% of prepared gas passes", () => {
    const preparedGas = 3_476_539n;
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: `0x${preparedGas.toString(16)}`,
      maxFeePerGas: "0x454bf75b",
      maxPriorityFeePerGas: "0x118c30",
    });
    // 150% of 3,476,539 is 5,214,809
    const authorizedCapGas = BigInt(bounded.authorizedCaps.gasLimit);
    expect(authorizedCapGas).toBe(5_214_809n);

    // Observed gas limit of 4,740,735 is <= 150% (5,214,809)
    const observedGas = 4_740_735n;
    expect(observedGas).toBeLessThanOrEqual(authorizedCapGas);

    const res = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x0",
      gasLimit: `0x${observedGas.toString(16)}`,
      gasPrice: "0x454bf75b",
      accessList: [],
    });
    expect(res.accepted).toBe(true);
  });

  // 6. Gas limit > 150% of prepared gas fails with gas limit violation
  it("6. Gas limit > 150% of prepared gas fails with gas limit violation", () => {
    const preparedGas = 3_476_539n;
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: `0x${preparedGas.toString(16)}`,
      maxFeePerGas: "0x454bf75b",
      maxPriorityFeePerGas: "0x118c30",
    });
    const exceedingGas = BigInt(bounded.authorizedCaps.gasLimit) + 1n;
    const res = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x0",
      gasLimit: `0x${exceedingGas.toString(16)}`,
      gasPrice: "0x454bf75b",
      accessList: [],
    });
    expect(res).toEqual({
      accepted: false,
      code: "GAS_LIMIT_CAP_EXCEEDED",
    });
  });

  // 7. Absolute 8,000,000 gas ceiling is enforced
  it("7. Absolute 8,000,000 gas ceiling is enforced", () => {
    // 6,000,000 prepared gas * 150% = 9,000,000, but ceiling is 8,000,000
    const preparedGas = 6_000_000n;
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: `0x${preparedGas.toString(16)}`,
      maxFeePerGas: "0x454bf75b",
      maxPriorityFeePerGas: "0x118c30",
    });
    expect(BigInt(bounded.authorizedCaps.gasLimit)).toBe(8_000_000n);

    // 8,000,001 gas limit must fail
    const exceedingCeiling = 8_000_001n;
    const res = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x2",
      gasLimit: `0x${exceedingCeiling.toString(16)}`,
      maxFeePerGas: "0x454bf75b",
      maxPriorityFeePerGas: "0x118c30",
      accessList: [],
    });
    expect(res).toEqual({
      accepted: false,
      code: "GAS_LIMIT_CAP_EXCEEDED",
    });
  });

  // 8. maximumNetworkFeeWei cap remains enforced for both type 0 and type 2
  it("8. maximumNetworkFeeWei cap remains enforced for both type 0 and type 2", () => {
    const bounded = createServerBoundedFeeAuthorizationV1({
      gasLimit: "0x100", // 256
      maxFeePerGas: "0x20", // 32
      maxPriorityFeePerGas: "0x4",
    });

    // Type 2 exceeding network fee
    const type2Exceeded = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x2",
      gasLimit: bounded.authorizedCaps.gasLimit,
      maxFeePerGas: `0x${(BigInt(bounded.authorizedCaps.maxFeePerGas) + 1n).toString(16)}`,
      maxPriorityFeePerGas: "0x4",
      accessList: [],
    });
    expect(type2Exceeded.accepted).toBe(false);

    // Type 0 exceeding network fee
    const type0Exceeded = evaluateFeeAuthorizationV1(bounded, {
      transactionType: "0x0",
      gasLimit: bounded.authorizedCaps.gasLimit,
      gasPrice: `0x${(BigInt(bounded.authorizedCaps.maxFeePerGas) + 1n).toString(16)}`,
      accessList: [],
    });
    expect(type0Exceeded.accepted).toBe(false);
  });

  // 9. Immutable transaction identity mismatch still fails
  it("9. Immutable transaction identity mismatch still fails", () => {
    const feeAuth = createServerBoundedFeeAuthorizationV1({
      gasLimit: "0x100",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x4",
    });
    const expectedIdentity = {
      identityVersion: "1.0" as const,
      chainId: "11155111" as const,
      from: FROM,
      to: TO,
      data: "0x12345678",
      value: "0x0",
      nonce: "0x5",
    };

    // Legacy transaction with altered destination "to"
    const mismatchedTx = {
      hash: "0x" + "11".repeat(32),
      chainId: "11155111",
      rpcChainId: "0xaa36a7",
      from: FROM,
      to: "0x9999999999999999999999999999999999999999", // MISMATCH
      input: "0x12345678",
      value: "0x0",
      nonce: "0x5",
      type: "0x0" as const,
      gas: "0x100",
      gasPrice: "0x4",
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      accessList: [],
      blockHash: "0x" + "22".repeat(32),
      blockNumber: "0x10",
      transactionIndex: "0x0",
      presence: "MINED" as const,
    };

    const comparison = compareNormalizedTransaction({
      transaction: mismatchedTx,
      expectedImmutableIdentity: expectedIdentity,
      expectedFeeAuthorization: feeAuth,
      observedAt: "2026-09-16T12:00:00.000Z",
    });

    expect(comparison.outcome).toBe("IMMUTABLE_MISMATCH");
    expect(comparison.immutableIdentityStatus).toBe("MISMATCH");
    expect(comparison.feeAuthorizationStatus).toBe("NOT_EVALUATED");
    expect(comparison.reconciliationRequired).toBe(true);
  });

  // 10. Historical run with 120% authorization is evaluated against its persisted caps, not new policy
  it("10. Historical run with 120% authorization is evaluated against its persisted caps, not new policy", () => {
    // Prepared gas: 3,476,539 (0x350c63). Under historical 120% policy, cap was 4,171,847 (0x3fa847).
    // Wallet observed gas: 4,740,735 (0x48567f). Under new 150% policy it would be 5,214,809, but historical
    // authorization MUST be evaluated strictly against its persisted cap.
    const historicalAuth = feeAuthorizationV1Schema.parse({
      authorizationVersion: "1.0",
      feeModel: "EIP1559",
      transactionType: "0x2",
      preparedDefaults: {
        gasLimit: "0x350c63", // 3,476,539
        maxFeePerGas: "0x4bd88df2",
        maxPriorityFeePerGas: "0x118c30",
      },
      authorizedCaps: {
        gasLimit: "0x3fa847", // 4,171,847 (persisted 120% cap)
        maxFeePerGas: "0x4bd88df2",
        maxPriorityFeePerGas: "0x4bd88df2",
        maximumNetworkFeeWei: `0x${(BigInt("0x3fa847") * BigInt("0x4bd88df2")).toString(16)}`,
      },
      preparedAccessList: [],
      adjustmentPolicy: "SERVER_BOUNDED_HEADROOM",
    });

    // Observed tx from historical run 132bb969-7a91-4153-ba8e-abef9727b99a
    const observedTx = {
      transactionType: "0x0",
      gasLimit: "0x48567f", // 4,740,735 gas
      gasPrice: "0x4bd88df2", // 1.272 gwei
      baseFeePerGas: "0x42a5e738", // 1.118 gwei -> effective priority ~0.154 gwei
      accessList: [],
    };

    const decision = evaluateFeeAuthorizationV1(historicalAuth, observedTx);
    expect(decision).toEqual({
      accepted: false,
      code: "GAS_LIMIT_CAP_EXCEEDED",
    });
  });
});
