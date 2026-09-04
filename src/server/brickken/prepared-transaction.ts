import { SEPOLIA_CHAIN_ID, SEPOLIA_CHAIN_ID_HEX } from "./config";
import { assertBoundedWalletValue, WALLET_BOUNDARY_LIMITS } from "@/shared/wallet";
import { BrickkenAdapterError, safeErrorMessage } from "./errors";
import type { AdapterResult, EdictPreparedTransaction, PreparedOperation } from "./types";
import { prepareResponseSchema, unsignedTransactionSchema } from "./wire-schemas";

const REQUIRED_WALLET_FIELDS = [
  "from",
  "to",
  "data",
  "value",
  "nonce",
  "chainId",
  "type",
  "gasLimit",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
] as const;

function fail(
  code: BrickkenAdapterError["code"],
  secret?: string,
): AdapterResult<PreparedOperation> {
  return { ok: false, error: safeErrorMessage(code, secret) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSepoliaChainId(value: unknown): "11155111" | null {
  if (value === 11155111 || value === SEPOLIA_CHAIN_ID) return SEPOLIA_CHAIN_ID;
  if (typeof value === "string" && value.toLowerCase() === SEPOLIA_CHAIN_ID_HEX) {
    return SEPOLIA_CHAIN_ID;
  }
  return null;
}

function cloneRaw(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function hasField(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
}

export function parsePreparedOperation(
  raw: unknown,
  secret?: string,
): AdapterResult<PreparedOperation> {
  try {
    assertBoundedWalletValue(raw, {
      maxCodeUnits: WALLET_BOUNDARY_LIMITS.brickkenResponseCodeUnits,
      maxArrayLength: 64,
      maxProperties: 64,
    });
  } catch {
    return fail("INVALID_EXTERNAL_RESPONSE", secret);
  }
  const parsed = prepareResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("INVALID_EXTERNAL_RESPONSE", secret);
  }
  if (Array.isArray(parsed.data.txId) || parsed.data.transactions.length !== 1) {
    return fail("UNSUPPORTED_TRANSACTION_BATCH", secret);
  }
  if (parsed.data.txId.length === 0) {
    return fail("PREPARED_TRANSACTION_INCOMPLETE", secret);
  }
  const [transaction] = parsed.data.transactions;
  if (!isRecord(transaction)) {
    return fail("INVALID_EXTERNAL_RESPONSE", secret);
  }
  const txParsed = unsignedTransactionSchema.safeParse(transaction);
  if (!txParsed.success) {
    return fail("INVALID_EXTERNAL_RESPONSE", secret);
  }
  const chainId = normalizeSepoliaChainId(txParsed.data.chainId);
  if (txParsed.data.chainId !== undefined && chainId === null) {
    return fail("UNSUPPORTED_CHAIN", secret);
  }
  const incomplete = REQUIRED_WALLET_FIELDS.some((field) => !hasField(transaction, field));
  if (incomplete || chainId === null) {
    return fail("PREPARED_TRANSACTION_INCOMPLETE", secret);
  }
  const edictTx: EdictPreparedTransaction = {
    from: txParsed.data.from ?? null,
    to: txParsed.data.to ?? null,
    data: txParsed.data.data ?? null,
    value: hasField(transaction, "value") ? transaction.value : null,
    nonce: hasField(transaction, "nonce") ? transaction.nonce : null,
    chainId: hasField(transaction, "chainId") ? transaction.chainId : null,
    type: hasField(transaction, "type") ? transaction.type : null,
    gasLimit: hasField(transaction, "gasLimit") ? transaction.gasLimit : null,
    maxFeePerGas: hasField(transaction, "maxFeePerGas") ? transaction.maxFeePerGas : null,
    maxPriorityFeePerGas: hasField(transaction, "maxPriorityFeePerGas")
      ? transaction.maxPriorityFeePerGas
      : null,
    gasPrice: hasField(transaction, "gasPrice") ? transaction.gasPrice : null,
    normalizedChainId: chainId,
    rawUnsigned: cloneRaw(transaction),
  };
  return {
    ok: true,
    value: {
      txId: parsed.data.txId,
      executionMode: "client-broadcast",
      transaction: edictTx,
    },
  };
}
