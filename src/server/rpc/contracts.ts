import "server-only";

import {
  assertBoundedWalletValue,
  WALLET_BOUNDARY_LIMITS,
  type WalletAccessListEntryV1,
} from "@/shared/wallet";
import { z } from "zod";
import {
  SEPOLIA_DECIMAL_CHAIN_ID,
  SEPOLIA_HEX_CHAIN_ID,
  type NormalizedRpcBlock,
  type NormalizedRpcReceipt,
  type NormalizedRpcTransaction,
} from "./types";

const MAX_UINT256 = (1n << 256n) - 1n;

export const rpcQuantitySchema = z
  .string()
  .max(66)
  .regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/)
  .refine((value) => BigInt(value) <= MAX_UINT256, {
    message: "Quantity exceeds uint256 maximum value.",
  });

/**
 * Validates exactly 20-byte Ethereum address hexadecimal syntax and
 * normalizes to canonical lowercase for deterministic comparison and hashing.
 *
 * NOTE: Normalizes to canonical lowercase, NOT EIP-55 checksummed.
 */
export const rpcAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { message: "Expected 20-byte Ethereum address hex syntax." })
  .transform((value) => value.toLowerCase());

export const rpcNullableAddressSchema = z.union([rpcAddressSchema, z.null()]);

export const rpcHash32Schema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase());

export const rpcCalldataSchema = z
  .string()
  .max(2 + WALLET_BOUNDARY_LIMITS.calldataBytes * 2)
  .regex(/^0x(?:[0-9a-f]{2})*$/i)
  .transform((value) => value.toLowerCase());

export const rpcAccessListEntrySchema = z.strictObject({
  address: rpcAddressSchema,
  storageKeys: z
    .array(rpcHash32Schema)
    .max(WALLET_BOUNDARY_LIMITS.storageKeysPerEntry),
});

export const rpcAccessListSchema = z
  .array(rpcAccessListEntrySchema)
  .max(WALLET_BOUNDARY_LIMITS.accessListEntries)
  .superRefine((entries, context) => {
    const total = entries.reduce((count, entry) => count + entry.storageKeys.length, 0);
    if (total > WALLET_BOUNDARY_LIMITS.storageKeysTotal) {
      context.addIssue({ code: "custom", message: "access list storage-key limit exceeded" });
    }
  });

export const rawRpcChainIdSchema = z
  .string()
  .max(66)
  .regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/)
  .transform((value) => {
    const decimal = BigInt(value).toString(10);
    const hex = `0x${BigInt(value).toString(16)}`;
    return { decimal, hex };
  });

export const rawRpcTransactionSchema = z
  .strictObject({
    hash: rpcHash32Schema,
    chainId: z.union([rpcQuantitySchema, rawRpcChainIdSchema.transform((c) => c.hex)]),
    from: rpcAddressSchema,
    to: rpcNullableAddressSchema,
    input: rpcCalldataSchema,
    value: rpcQuantitySchema,
    nonce: rpcQuantitySchema,
    type: z.enum(["0x0", "0x1", "0x2"]),
    gas: rpcQuantitySchema,
    gasPrice: rpcQuantitySchema.nullable().optional(),
    maxFeePerGas: rpcQuantitySchema.nullable().optional(),
    maxPriorityFeePerGas: rpcQuantitySchema.nullable().optional(),
    accessList: rpcAccessListSchema.optional(),
    blockHash: rpcHash32Schema.nullable(),
    blockNumber: rpcQuantitySchema.nullable(),
    transactionIndex: rpcQuantitySchema.nullable(),
    v: z.string().optional(),
    r: z.string().optional(),
    s: z.string().optional(),
    yParity: z.string().optional(),
  })
  .superRefine((tx, context) => {
    const hasBlockHash = tx.blockHash !== null;
    const hasBlockNumber = tx.blockNumber !== null;
    const hasTxIndex = tx.transactionIndex !== null;
    if (hasBlockHash !== hasBlockNumber || hasBlockHash !== hasTxIndex) {
      context.addIssue({
        code: "custom",
        message: "inconsistent mined location fields: blockHash, blockNumber, and transactionIndex must all be null (unmined) or all non-null (mined)",
      });
    }
  });

export const rawRpcReceiptSchema = z.strictObject({
  transactionHash: rpcHash32Schema,
  transactionIndex: rpcQuantitySchema,
  blockHash: rpcHash32Schema,
  blockNumber: rpcQuantitySchema,
  from: rpcAddressSchema,
  to: rpcNullableAddressSchema,
  cumulativeGasUsed: rpcQuantitySchema,
  gasUsed: rpcQuantitySchema,
  effectiveGasPrice: rpcQuantitySchema,
  contractAddress: rpcNullableAddressSchema,
  logs: z.array(z.strictObject({
    address: rpcAddressSchema,
    topics: z.array(rpcHash32Schema).max(4),
    data: rpcCalldataSchema,
    blockNumber: rpcQuantitySchema,
    transactionHash: rpcHash32Schema,
    transactionIndex: rpcQuantitySchema,
    blockHash: rpcHash32Schema,
    logIndex: rpcQuantitySchema,
    removed: z.literal(false).optional(),
  })).max(4_096),
  logsBloom: z.string().optional(),
  type: z.enum(["0x0", "0x1", "0x2"]),
  status: z.enum(["0x0", "0x1"]),
  root: rpcHash32Schema.optional(),
  blobGasUsed: rpcQuantitySchema.optional(),
  blobGasPrice: rpcQuantitySchema.optional(),
}).superRefine((receipt, context) => {
  const seenLogIndexes = new Set<string>();
  for (const [index, log] of receipt.logs.entries()) {
    if (
      log.transactionHash !== receipt.transactionHash ||
      log.transactionIndex !== receipt.transactionIndex ||
      log.blockHash !== receipt.blockHash ||
      log.blockNumber !== receipt.blockNumber
    ) {
      context.addIssue({
        code: "custom",
        path: ["logs", index],
        message: "receipt log identity does not match its containing receipt",
      });
    }
    if (seenLogIndexes.has(log.logIndex)) {
      context.addIssue({
        code: "custom",
        path: ["logs", index, "logIndex"],
        message: "duplicate receipt log index",
      });
    }
    seenLogIndexes.add(log.logIndex);
  }
});

export const rawRpcBlockSchema = z.strictObject({
  number: rpcQuantitySchema,
  hash: rpcHash32Schema,
  parentHash: rpcHash32Schema,
  baseFeePerGas: rpcQuantitySchema.nullable().optional(),
  nonce: z.string().optional(),
  sha3Uncles: z.string().optional(),
  logsBloom: z.string().optional(),
  transactionsRoot: z.string().optional(),
  stateRoot: z.string().optional(),
  receiptsRoot: z.string().optional(),
  miner: z.string().optional(),
  difficulty: z.string().optional(),
  totalDifficulty: z.string().optional(),
  extraData: z.string().optional(),
  size: z.string().optional(),
  gasLimit: z.string().optional(),
  gasUsed: z.string().optional(),
  timestamp: z.string().optional(),
  transactions: z.array(z.unknown()).optional(),
  uncles: z.array(z.unknown()).optional(),
});

/**
 * Defense-in-depth bounding check for already parsed RPC payloads.
 * (Note: Primary raw response size bounding <= 1 MiB must be done by the transport).
 */
export function assertBoundedRpcPayload(raw: unknown): void {
  assertBoundedWalletValue(raw, {
    maxCodeUnits: WALLET_BOUNDARY_LIMITS.rpcResponseCodeUnits,
    maxArrayLength: 4_096,
    maxProperties: 128,
  });
}

export function normalizeRpcTransaction(raw: unknown): NormalizedRpcTransaction {
  assertBoundedRpcPayload(raw);
  const parsed = rawRpcTransactionSchema.parse(raw);
  const chainIdBigInt = BigInt(parsed.chainId);
  const decimalChainId = chainIdBigInt.toString(10);
  const hexChainId = `0x${chainIdBigInt.toString(16)}`;
  const presence = parsed.blockHash === null ? "UNMINED" : "MINED";

  const accessList: readonly WalletAccessListEntryV1[] = (parsed.accessList ?? []).map((entry) => ({
    address: entry.address,
    storageKeys: Object.freeze([...entry.storageKeys]),
  }));

  return Object.freeze({
    hash: parsed.hash,
    chainId: decimalChainId,
    rpcChainId: hexChainId,
    from: parsed.from,
    to: parsed.to,
    input: parsed.input,
    value: parsed.value,
    nonce: parsed.nonce,
    type: parsed.type,
    gas: parsed.gas,
    gasPrice: parsed.gasPrice ?? null,
    maxFeePerGas: parsed.maxFeePerGas ?? null,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? null,
    accessList: Object.freeze(accessList),
    blockHash: parsed.blockHash,
    blockNumber: parsed.blockNumber,
    transactionIndex: parsed.transactionIndex,
    presence,
  });
}

export function normalizeRpcReceipt(raw: unknown): NormalizedRpcReceipt {
  assertBoundedRpcPayload(raw);
  const parsed = rawRpcReceiptSchema.parse(raw);
  return Object.freeze({
    transactionHash: parsed.transactionHash,
    transactionIndex: parsed.transactionIndex,
    blockHash: parsed.blockHash,
    blockNumber: parsed.blockNumber,
    from: parsed.from,
    to: parsed.to,
    cumulativeGasUsed: parsed.cumulativeGasUsed,
    gasUsed: parsed.gasUsed,
    effectiveGasPrice: parsed.effectiveGasPrice,
    contractAddress: parsed.contractAddress,
    logs: Object.freeze(parsed.logs.map((log) => Object.freeze({
      address: log.address,
      topics: Object.freeze([...log.topics]),
      data: log.data,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      blockHash: log.blockHash,
      logIndex: log.logIndex,
      removed: false as const,
    }))),
    type: parsed.type,
    status: parsed.status,
  });
}

export function normalizeRpcBlock(raw: unknown): NormalizedRpcBlock {
  assertBoundedRpcPayload(raw);
  const parsed = rawRpcBlockSchema.parse(raw);
  return Object.freeze({
    number: parsed.number,
    hash: parsed.hash,
    parentHash: parsed.parentHash,
    baseFeePerGas: parsed.baseFeePerGas ?? null,
  });
}

export function parseSepoliaChainId(raw: unknown): { decimal: "11155111"; hex: "0xaa36a7" } {
  assertBoundedRpcPayload(raw);
  const parsed = rawRpcChainIdSchema.parse(raw);
  if (parsed.decimal !== SEPOLIA_DECIMAL_CHAIN_ID || parsed.hex !== SEPOLIA_HEX_CHAIN_ID) {
    throw new Error(
      `Unsupported chain ID: expected ${SEPOLIA_DECIMAL_CHAIN_ID} (${SEPOLIA_HEX_CHAIN_ID}), got ${parsed.decimal} (${parsed.hex})`
    );
  }
  return {
    decimal: SEPOLIA_DECIMAL_CHAIN_ID,
    hex: SEPOLIA_HEX_CHAIN_ID,
  };
}
