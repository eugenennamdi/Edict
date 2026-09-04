import "server-only";

import { hashCanonicalJson, sha256Utf8 } from "@/core";
import {
  assertBoundedWalletValue,
  validateWalletTransactionRequestV1,
  WALLET_BOUNDARY_LIMITS,
  type WalletAccessListEntryV1,
  type WalletTransactionRequestV1,
} from "@/shared/wallet";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

const MAX_UINT256 = (1n << 256n) - 1n;
const quantity = z.string().max(66).regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/).refine(
  (value) => BigInt(value) <= MAX_UINT256,
);
const data = z.string().max(2 + WALLET_BOUNDARY_LIMITS.calldataBytes * 2).regex(/^0x(?:[0-9a-f]{2})*$/);
const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const isoUtc = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value,
);
const address = z.string().refine(isAddress).transform((value) => getAddress(value).toLowerCase());
const nullableAddress = z.union([address, z.null()]);
const accessListEntry = z.strictObject({
  address,
  storageKeys: z.array(hash32).max(WALLET_BOUNDARY_LIMITS.storageKeysPerEntry),
});
const accessList = z.array(accessListEntry)
  .max(WALLET_BOUNDARY_LIMITS.accessListEntries)
  .superRefine((entries, context) => {
    const total = entries.reduce((count, entry) => count + entry.storageKeys.length, 0);
    if (total > WALLET_BOUNDARY_LIMITS.storageKeysTotal) {
      context.addIssue({ code: "custom", message: "access list storage-key limit exceeded" });
    }
  });

export const rpcTransactionV1Schema = z.strictObject({
  hash: hash32,
  chainId: quantity,
  from: address,
  to: nullableAddress,
  input: data,
  value: quantity,
  nonce: quantity,
  type: z.enum(["0x0", "0x1", "0x2"]),
  gas: quantity,
  gasPrice: quantity.optional(),
  maxFeePerGas: quantity.optional(),
  maxPriorityFeePerGas: quantity.optional(),
  accessList: accessList.optional(),
  blockHash: hash32.nullable(),
  blockNumber: quantity.nullable(),
  transactionIndex: quantity.nullable(),
  v: quantity.optional(),
  r: hash32.optional(),
  s: hash32.optional(),
  yParity: quantity.optional(),
});

export const rpcTransactionReceiptV1Schema = z.strictObject({
  transactionHash: hash32,
  transactionIndex: quantity,
  blockHash: hash32,
  blockNumber: quantity,
  from: address,
  to: nullableAddress,
  cumulativeGasUsed: quantity,
  gasUsed: quantity,
  effectiveGasPrice: quantity,
  contractAddress: nullableAddress,
  logs: z.array(z.unknown()).max(4_096),
  logsBloom: data,
  type: z.enum(["0x0", "0x1", "0x2"]),
  status: z.enum(["0x0", "0x1"]),
  root: hash32.optional(),
  blobGasUsed: quantity.optional(),
  blobGasPrice: quantity.optional(),
  depositNonce: quantity.optional(),
});

export const comparisonResultSchema = z.enum([
  "EXACT_MATCH",
  "SEMANTIC_MATCH",
  "DERIVED_RESPONSE_FIELD",
  "RECEIPT_OBSERVATION",
  "NOT_APPLICABLE",
  "MISMATCH",
]);

const fieldComparisonsSchema = z.strictObject({
  chainId: comparisonResultSchema,
  hash: comparisonResultSchema,
  from: comparisonResultSchema,
  to: comparisonResultSchema,
  input: comparisonResultSchema,
  value: comparisonResultSchema,
  nonce: comparisonResultSchema,
  type: comparisonResultSchema,
  gas: comparisonResultSchema,
  gasPrice: comparisonResultSchema,
  maxFeePerGas: comparisonResultSchema,
  maxPriorityFeePerGas: comparisonResultSchema,
  accessList: comparisonResultSchema,
});

export const onchainTransactionEvidenceV1Schema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  observedAt: isoUtc,
  walletRequestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  transactionIdentityHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  requestedHash: hash32,
  returnedHash: hash32,
  chainId: quantity,
  from: address,
  to: nullableAddress,
  inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  inputBytes: z.number().int().nonnegative().max(WALLET_BOUNDARY_LIMITS.calldataBytes),
  value: quantity,
  nonce: quantity,
  type: z.enum(["0x0", "0x1", "0x2"]),
  gas: quantity,
  gasPrice: quantity.nullable(),
  maxFeePerGas: quantity.nullable(),
  maxPriorityFeePerGas: quantity.nullable(),
  accessListHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  blockHash: hash32.nullable(),
  blockNumber: quantity.nullable(),
  transactionIndex: quantity.nullable(),
  fields: fieldComparisonsSchema,
  comparisonStatus: z.enum(["MATCH", "MISMATCH"]),
  reconciliationStatus: z.enum(["CLEAR", "REQUIRED"]),
});

export const transactionReceiptEvidenceV1Schema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  observedAt: isoUtc,
  transactionHash: hash32,
  blockHash: hash32,
  blockNumber: quantity,
  transactionIndex: quantity,
  from: address,
  to: nullableAddress,
  type: z.enum(["0x0", "0x1", "0x2"]),
  gasUsed: quantity,
  effectiveGasPrice: quantity,
  contractAddress: nullableAddress,
  executionStatus: z.enum(["SUCCESS", "REVERTED"]),
  identityStatus: z.enum(["MATCH", "MISMATCH"]),
  finalityStatus: z.enum(["INCLUDED", "FINALIZED"]),
  finalizedBlockHash: hash32.nullable(),
  finalizedBlockNumber: quantity.nullable(),
  reconciliationStatus: z.enum(["CLEAR", "REQUIRED"]),
});

export type OnchainTransactionEvidenceV1 = z.infer<typeof onchainTransactionEvidenceV1Schema>;
export type TransactionReceiptEvidenceV1 = z.infer<typeof transactionReceiptEvidenceV1Schema>;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function boundedRpc(raw: unknown): void {
  assertBoundedWalletValue(raw, {
    maxCodeUnits: WALLET_BOUNDARY_LIMITS.rpcResponseCodeUnits,
    maxArrayLength: 4_096,
    maxProperties: 128,
  });
}

function sameQuantity(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && BigInt(left) === BigInt(right);
}

function sameAddress(left: string | undefined, right: string | null): boolean {
  return left !== undefined && right !== null && left.toLowerCase() === right.toLowerCase();
}

function normalizeAccessList(value: readonly WalletAccessListEntryV1[] | undefined) {
  return (value ?? []).map((entry) => ({
    address: entry.address.toLowerCase(),
    storageKeys: [...entry.storageKeys].map((key) => key.toLowerCase()),
  }));
}

export async function compareWalletRequestToRpcTransaction(input: {
  readonly walletRequest: unknown;
  readonly expectedChainId: "11155111";
  readonly expectedHash: string;
  readonly rpcTransaction: unknown;
  readonly observedAt: string;
}): Promise<OnchainTransactionEvidenceV1> {
  boundedRpc(input.rpcTransaction);
  const request = validateWalletTransactionRequestV1(input.walletRequest);
  const transaction = rpcTransactionV1Schema.parse(input.rpcTransaction);
  const requiredRequest = request as WalletTransactionRequestV1;
  const type2 = transaction.type === "0x2";
  const requestAccessList = normalizeAccessList(requiredRequest.accessList);
  const responseAccessList = normalizeAccessList(transaction.accessList);
  const accessListSame = JSON.stringify(requestAccessList) === JSON.stringify(responseAccessList);
  const complete =
    requiredRequest.to !== undefined && requiredRequest.data !== undefined &&
    requiredRequest.value !== undefined && requiredRequest.nonce !== undefined &&
    requiredRequest.type !== undefined && requiredRequest.gas !== undefined &&
    (type2
      ? requiredRequest.maxFeePerGas !== undefined && requiredRequest.maxPriorityFeePerGas !== undefined
      : requiredRequest.gasPrice !== undefined);
  const fields = {
    chainId: BigInt(transaction.chainId) === BigInt(input.expectedChainId) ? "SEMANTIC_MATCH" : "MISMATCH",
    hash: transaction.hash === input.expectedHash.toLowerCase() ? "EXACT_MATCH" : "MISMATCH",
    from: sameAddress(requiredRequest.from, transaction.from) ? "SEMANTIC_MATCH" : "MISMATCH",
    to: sameAddress(requiredRequest.to, transaction.to) ? "SEMANTIC_MATCH" : "MISMATCH",
    input: requiredRequest.data === transaction.input ? "EXACT_MATCH" : "MISMATCH",
    value: sameQuantity(requiredRequest.value, transaction.value) ? "SEMANTIC_MATCH" : "MISMATCH",
    nonce: sameQuantity(requiredRequest.nonce, transaction.nonce) ? "SEMANTIC_MATCH" : "MISMATCH",
    type: requiredRequest.type === transaction.type ? "EXACT_MATCH" : "MISMATCH",
    gas: sameQuantity(requiredRequest.gas, transaction.gas) ? "SEMANTIC_MATCH" : "MISMATCH",
    gasPrice: type2
      ? transaction.gasPrice === undefined ? "NOT_APPLICABLE" : "DERIVED_RESPONSE_FIELD"
      : sameQuantity(requiredRequest.gasPrice, transaction.gasPrice) ? "SEMANTIC_MATCH" : "MISMATCH",
    maxFeePerGas: type2
      ? sameQuantity(requiredRequest.maxFeePerGas, transaction.maxFeePerGas) ? "SEMANTIC_MATCH" : "MISMATCH"
      : "NOT_APPLICABLE",
    maxPriorityFeePerGas: type2
      ? sameQuantity(requiredRequest.maxPriorityFeePerGas, transaction.maxPriorityFeePerGas) ? "SEMANTIC_MATCH" : "MISMATCH"
      : "NOT_APPLICABLE",
    accessList: accessListSame
      ? requiredRequest.accessList === undefined && (transaction.accessList?.length ?? 0) === 0
        ? "SEMANTIC_MATCH" : "EXACT_MATCH"
      : "MISMATCH",
  } as const;
  const comparisonStatus = complete && !Object.values(fields).includes("MISMATCH") ? "MATCH" : "MISMATCH";
  const walletRequestHash = (await hashCanonicalJson(request)).hash;
  const inputHash = await sha256Utf8(transaction.input);
  const accessListHash = (await hashCanonicalJson(responseAccessList)).hash;
  const transactionIdentityHash = (await hashCanonicalJson({
    hash: transaction.hash, chainId: transaction.chainId, from: transaction.from, to: transaction.to,
    inputHash, value: transaction.value, nonce: transaction.nonce, type: transaction.type,
    gas: transaction.gas, gasPrice: transaction.gasPrice ?? null,
    maxFeePerGas: transaction.maxFeePerGas ?? null,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? null,
    accessListHash, blockHash: transaction.blockHash, blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
  })).hash;
  return deepFreeze(onchainTransactionEvidenceV1Schema.parse({
    evidenceVersion: "1.0", observedAt: input.observedAt, walletRequestHash,
    transactionIdentityHash, requestedHash: input.expectedHash.toLowerCase(), returnedHash: transaction.hash,
    chainId: transaction.chainId, from: transaction.from, to: transaction.to, inputHash,
    inputBytes: (transaction.input.length - 2) / 2, value: transaction.value, nonce: transaction.nonce,
    type: transaction.type, gas: transaction.gas, gasPrice: transaction.gasPrice ?? null,
    maxFeePerGas: transaction.maxFeePerGas ?? null,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? null,
    accessListHash, blockHash: transaction.blockHash, blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex, fields, comparisonStatus,
    reconciliationStatus: comparisonStatus === "MATCH" ? "CLEAR" : "REQUIRED",
  }));
}

export function createTransactionReceiptEvidence(input: {
  readonly transaction: OnchainTransactionEvidenceV1;
  readonly rpcReceipt: unknown;
  readonly observedAt: string;
  readonly finalizedBlock?: Readonly<{ hash: string; number: string }>;
}): TransactionReceiptEvidenceV1 {
  boundedRpc(input.rpcReceipt);
  const transaction = onchainTransactionEvidenceV1Schema.parse(input.transaction);
  const receipt = rpcTransactionReceiptV1Schema.parse(input.rpcReceipt);
  const finalized = input.finalizedBlock;
  const identityMatches = transaction.comparisonStatus === "MATCH" &&
    receipt.transactionHash === transaction.returnedHash && receipt.blockHash === transaction.blockHash &&
    receipt.blockNumber === transaction.blockNumber && receipt.transactionIndex === transaction.transactionIndex &&
    receipt.from === transaction.from && receipt.to === transaction.to && receipt.type === transaction.type &&
    BigInt(receipt.gasUsed) <= BigInt(transaction.gas) && receipt.contractAddress === null;
  const finalizedMatches = finalized !== undefined && /^0x[0-9a-f]{64}$/.test(finalized.hash) &&
    quantity.safeParse(finalized.number).success && BigInt(finalized.number) >= BigInt(receipt.blockNumber);
  return deepFreeze(transactionReceiptEvidenceV1Schema.parse({
    evidenceVersion: "1.0", observedAt: input.observedAt, transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, transactionIndex: receipt.transactionIndex,
    from: receipt.from, to: receipt.to, type: receipt.type, gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice, contractAddress: receipt.contractAddress,
    executionStatus: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
    identityStatus: identityMatches ? "MATCH" : "MISMATCH",
    finalityStatus: finalizedMatches ? "FINALIZED" : "INCLUDED",
    finalizedBlockHash: finalizedMatches ? finalized!.hash : null,
    finalizedBlockNumber: finalizedMatches ? finalized!.number : null,
    reconciliationStatus: identityMatches ? "CLEAR" : "REQUIRED",
  }));
}
