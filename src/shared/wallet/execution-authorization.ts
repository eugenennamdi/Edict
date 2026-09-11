import { canonicalizeJson, hashCanonicalJson } from "@/core";
import { z } from "zod";
import { WALLET_BOUNDARY_LIMITS } from "./limits";

const MAX_UINT256 = (1n << 256n) - 1n;
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const digest = z.string().regex(/^0x[0-9a-f]{64}$/);
const quantity = z
  .string()
  .max(66)
  .regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/)
  .refine((value) => BigInt(value) <= MAX_UINT256);
const data = z
  .string()
  .max(2 + WALLET_BOUNDARY_LIMITS.calldataBytes * 2)
  .regex(/^0x(?:[0-9a-f]{2})*$/);
const identifier = z.string().min(1).max(1_024);

const accessListEntry = z.strictObject({
  address,
  storageKeys: z.array(z.string().regex(/^0x[0-9a-f]{64}$/))
    .max(WALLET_BOUNDARY_LIMITS.storageKeysPerEntry),
});

const accessList = z.array(accessListEntry)
  .max(WALLET_BOUNDARY_LIMITS.accessListEntries)
  .superRefine((entries, context) => {
    if (entries.reduce((total, entry) => total + entry.storageKeys.length, 0) >
      WALLET_BOUNDARY_LIMITS.storageKeysTotal) {
      context.addIssue({ code: "custom", message: "access list storage-key limit exceeded" });
    }
  });

export const immutableExecutionIdentityV1Schema = z.strictObject({
  identityVersion: z.literal("1.0"),
  chainId: z.literal("11155111"),
  from: address,
  to: address,
  data,
  value: quantity,
  nonce: quantity,
});

const feeValues = z.strictObject({
  gasLimit: quantity,
  maxFeePerGas: quantity,
  maxPriorityFeePerGas: quantity,
});

export const feeAuthorizationV1Schema = z.strictObject({
  authorizationVersion: z.literal("1.0"),
  feeModel: z.literal("EIP1559"),
  transactionType: z.literal("0x2"),
  preparedDefaults: feeValues,
  authorizedCaps: feeValues.extend({ maximumNetworkFeeWei: quantity }),
  preparedAccessList: accessList,
  adjustmentPolicy: z.literal("BOUNDED_NO_INCREASE"),
}).superRefine((authorization, context) => {
  const defaults = authorization.preparedDefaults;
  const caps = authorization.authorizedCaps;
  const values = [
    defaults.gasLimit,
    defaults.maxFeePerGas,
    defaults.maxPriorityFeePerGas,
    caps.gasLimit,
    caps.maxFeePerGas,
    caps.maxPriorityFeePerGas,
    caps.maximumNetworkFeeWei,
  ].map(BigInt);
  const [defaultGas, defaultMax, defaultPriority, capGas, capMax, capPriority, capNetwork] = values;
  const product = capGas! * capMax!;
  if (
    defaultPriority! > defaultMax! || capPriority! > capMax! ||
    defaultGas! !== capGas! || defaultMax! !== capMax! || defaultPriority! !== capPriority! ||
    product > MAX_UINT256 || product !== capNetwork!
  ) {
    context.addIssue({ code: "custom", message: "invalid fee authorization" });
  }
});

export const semanticAuthorizationV1Schema = z.strictObject({
  authorizationVersion: z.literal("1.0"),
  policyVersion: identifier,
  authorizationId: identifier,
  environment: z.literal("sandbox"),
  brickkenMethod: z.enum(["newTokenization", "whitelistUser", "mintToken"]),
  executionMode: z.literal("client-broadcast"),
  destinationPolicy: z.strictObject({
    policyId: identifier,
    reviewedDestination: address,
  }),
  selectorPolicy: z.strictObject({
    policyId: identifier,
    reviewedSelector: z.string().regex(/^0x[0-9a-f]{8}$/),
  }),
  calldataCommitment: hash,
  decision: z.literal("ALLOW"),
});

export const brickkenPreparationIdentityV1Schema = z.strictObject({
  identityVersion: z.literal("1.0"),
  method: z.enum(["newTokenization", "whitelistUser", "mintToken"]),
  executionMode: z.literal("client-broadcast"),
  preparationAttemptId: identifier,
  preparedTxId: z.string().min(1).max(256),
  preparationFingerprint: hash,
});

export const walletExecutionIntentV1Schema = z.strictObject({
  domain: z.literal("edict.wallet-execution-intent.v1"),
  runId: identifier,
  runRevision: z.number().int().safe().positive(),
  approvalIdentity: z.strictObject({
    approvalRevision: z.number().int().safe().nonnegative(),
    typedDataDigest: digest,
  }),
  manifestHash: hash,
  planHash: hash,
  environment: z.literal("sandbox"),
  operation: z.strictObject({
    id: identifier,
    kind: z.enum(["TOKENIZE", "WHITELIST", "MINT"]),
    sequence: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  requiredSigner: address,
  chainRequirement: z.strictObject({
    decimalChainId: z.literal("11155111"),
    rpcChainId: z.literal("0xaa36a7"),
    authority: z.literal("TRUSTED_SERVER_RPC"),
  }),
  immutableIdentity: immutableExecutionIdentityV1Schema,
  feeAuthorization: feeAuthorizationV1Schema,
  brickkenPreparation: brickkenPreparationIdentityV1Schema,
  semanticAuthorization: semanticAuthorizationV1Schema,
}).superRefine((intent, context) => {
  if (
    intent.requiredSigner !== intent.immutableIdentity.from ||
    intent.chainRequirement.decimalChainId !== intent.immutableIdentity.chainId ||
    intent.semanticAuthorization.environment !== intent.environment ||
    intent.semanticAuthorization.brickkenMethod !== intent.brickkenPreparation.method ||
    intent.semanticAuthorization.executionMode !== intent.brickkenPreparation.executionMode ||
    intent.semanticAuthorization.destinationPolicy.reviewedDestination !== intent.immutableIdentity.to ||
    intent.semanticAuthorization.selectorPolicy.reviewedSelector !== intent.immutableIdentity.data.slice(0, 10)
  ) {
    context.addIssue({ code: "custom", message: "wallet intent authority mismatch" });
  }
});

export type ImmutableExecutionIdentityV1 = z.infer<typeof immutableExecutionIdentityV1Schema>;
export type FeeAuthorizationV1 = z.infer<typeof feeAuthorizationV1Schema>;
export type SemanticAuthorizationV1 = z.infer<typeof semanticAuthorizationV1Schema>;
export type BrickkenPreparationIdentityV1 = z.infer<typeof brickkenPreparationIdentityV1Schema>;
export type WalletExecutionIntentV1 = z.infer<typeof walletExecutionIntentV1Schema>;

export type FeeAuthorizationDecisionV1 = Readonly<
  | { accepted: true; maximumNetworkFeeWei: string }
  | {
      accepted: false;
      code:
        | "LEGACY_GAS_PRICE"
        | "FEE_MODEL_CHANGED"
        | "ACCESS_LIST_CHANGED"
        | "GAS_LIMIT_CAP_EXCEEDED"
        | "MAX_FEE_CAP_EXCEEDED"
        | "PRIORITY_FEE_CAP_EXCEEDED"
        | "NETWORK_FEE_CAP_EXCEEDED";
    }
>;

export function createInitialFeeAuthorizationV1(input: {
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly preparedAccessList?: readonly Readonly<{
    address: string;
    storageKeys: readonly string[];
  }>[];
}): FeeAuthorizationV1 {
  const parsed = feeValues.parse({
    gasLimit: input.gasLimit,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
  });
  const maximumNetworkFee = BigInt(parsed.gasLimit) * BigInt(parsed.maxFeePerGas);
  if (maximumNetworkFee > MAX_UINT256) throw new TypeError("INVALID_FEE_AUTHORIZATION");
  return feeAuthorizationV1Schema.parse({
    authorizationVersion: "1.0",
    feeModel: "EIP1559",
    transactionType: "0x2",
    preparedDefaults: parsed,
    authorizedCaps: {
      ...parsed,
      maximumNetworkFeeWei: `0x${maximumNetworkFee.toString(16)}`,
    },
    preparedAccessList: (input.preparedAccessList ?? []).map((entry) => ({
      address: entry.address,
      storageKeys: [...entry.storageKeys],
    })),
    adjustmentPolicy: "BOUNDED_NO_INCREASE",
  });
}

const actualFeeFieldsSchema = z.strictObject({
  transactionType: z.literal("0x2"),
  gasLimit: quantity,
  maxFeePerGas: quantity,
  maxPriorityFeePerGas: quantity,
  gasPrice: z.null().optional(),
  accessList,
});

export function evaluateFeeAuthorizationV1(
  authorizationRaw: unknown,
  actualRaw: unknown,
): FeeAuthorizationDecisionV1 {
  const authorization = feeAuthorizationV1Schema.parse(authorizationRaw);
  if (typeof actualRaw === "object" && actualRaw !== null) {
    if (
      "transactionType" in actualRaw &&
      (actualRaw as { transactionType?: unknown }).transactionType !== authorization.transactionType
    ) return Object.freeze({ accepted: false, code: "FEE_MODEL_CHANGED" });
    if (
    "gasPrice" in actualRaw && (actualRaw as { gasPrice?: unknown }).gasPrice !== null &&
    (actualRaw as { gasPrice?: unknown }).gasPrice !== undefined
    ) return Object.freeze({ accepted: false, code: "LEGACY_GAS_PRICE" });
  }
  const actual = actualFeeFieldsSchema.parse(actualRaw);
  if (actual.transactionType !== authorization.transactionType) {
    return Object.freeze({ accepted: false, code: "FEE_MODEL_CHANGED" });
  }
  if (canonicalizeJson(actual.accessList) !== canonicalizeJson(authorization.preparedAccessList)) {
    return Object.freeze({ accepted: false, code: "ACCESS_LIST_CHANGED" });
  }
  const gas = BigInt(actual.gasLimit);
  const maxFee = BigInt(actual.maxFeePerGas);
  const priority = BigInt(actual.maxPriorityFeePerGas);
  const caps = authorization.authorizedCaps;
  if (gas > BigInt(caps.gasLimit)) {
    return Object.freeze({ accepted: false, code: "GAS_LIMIT_CAP_EXCEEDED" });
  }
  if (maxFee > BigInt(caps.maxFeePerGas)) {
    return Object.freeze({ accepted: false, code: "MAX_FEE_CAP_EXCEEDED" });
  }
  if (priority > BigInt(caps.maxPriorityFeePerGas) || priority > maxFee) {
    return Object.freeze({ accepted: false, code: "PRIORITY_FEE_CAP_EXCEEDED" });
  }
  const maximumNetworkFee = gas * maxFee;
  if (maximumNetworkFee > MAX_UINT256 || maximumNetworkFee > BigInt(caps.maximumNetworkFeeWei)) {
    return Object.freeze({ accepted: false, code: "NETWORK_FEE_CAP_EXCEEDED" });
  }
  return Object.freeze({
    accepted: true,
    maximumNetworkFeeWei: `0x${maximumNetworkFee.toString(16)}`,
  });
}

export function validateWalletExecutionIntentV1(raw: unknown): WalletExecutionIntentV1 {
  canonicalizeJson(raw);
  return Object.freeze(walletExecutionIntentV1Schema.parse(raw));
}

export async function hashWalletExecutionIntentV1(raw: unknown) {
  return hashCanonicalJson(validateWalletExecutionIntentV1(raw));
}
