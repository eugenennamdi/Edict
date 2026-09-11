import { describe, expect, it } from "vitest";
import {
  createInitialFeeAuthorizationV1,
  evaluateFeeAuthorizationV1,
  feeAuthorizationV1Schema,
  hashWalletExecutionIntentV1,
  validateWalletExecutionIntentV1,
  type WalletExecutionIntentV1,
} from "./execution-authorization";

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

  it("rejects legacy gasPrice and fee-model/type switching", () => {
    expect(evaluateFeeAuthorizationV1(fees, { ...actualFees, gasPrice: "0x1" })).toEqual({
      accepted: false,
      code: "LEGACY_GAS_PRICE",
    });
    expect(evaluateFeeAuthorizationV1(fees, { ...actualFees, transactionType: "0x1" })).toEqual({
      accepted: false,
      code: "FEE_MODEL_CHANGED",
    });
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
