import { canonicalizeJson } from "@/core";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

export type WalletTransactionErrorCode =
  | "MALFORMED_PREPARED_TRANSACTION"
  | "PREPARED_TRANSACTION_INCOMPLETE"
  | "CONFLICTING_TRANSACTION_FIELDS"
  | "UNSUPPORTED_SIGNING_FIELD"
  | "SIGNER_MISMATCH"
  | "WRONG_CHAIN";

export class WalletTransactionError extends Error {
  constructor(
    readonly code: WalletTransactionErrorCode,
    readonly path: string,
  ) {
    super(code);
    this.name = "WalletTransactionError";
  }
}

export interface WalletAccessListEntryV1 {
  readonly address: string;
  readonly storageKeys: readonly string[];
}

export interface WalletTransactionRequestV1 {
  readonly from: string;
  readonly to?: string;
  readonly gas?: string;
  readonly gasPrice?: string;
  readonly maxFeePerGas?: string;
  readonly maxPriorityFeePerGas?: string;
  readonly value?: string;
  readonly data?: string;
  readonly nonce?: string;
  readonly type?: "0x0" | "0x1" | "0x2";
  readonly accessList?: readonly WalletAccessListEntryV1[];
}

export interface NormalizedPreparedTransactionV1 {
  readonly chainId: string;
  readonly walletRequest: WalletTransactionRequestV1;
}

const quantitySchema = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/);
const dataSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);

const accessListEntrySchema = z.strictObject({
  address: addressSchema,
  storageKeys: z.array(z.string().regex(/^0x[0-9a-f]{64}$/)),
});

export const walletTransactionRequestV1Schema = z
  .strictObject({
    from: addressSchema,
    to: addressSchema.optional(),
    gas: quantitySchema.optional(),
    gasPrice: quantitySchema.optional(),
    maxFeePerGas: quantitySchema.optional(),
    maxPriorityFeePerGas: quantitySchema.optional(),
    value: quantitySchema.optional(),
    data: dataSchema.optional(),
    nonce: quantitySchema.optional(),
    type: z.enum(["0x0", "0x1", "0x2"]).optional(),
    accessList: z.array(accessListEntrySchema).optional(),
  })
  .superRefine((value, context) => {
    const hasLegacy = value.gasPrice !== undefined;
    const hasMax = value.maxFeePerGas !== undefined || value.maxPriorityFeePerGas !== undefined;
    if (hasLegacy && hasMax) context.addIssue({ code: "custom", message: "mixed fee model" });
    if ((value.maxFeePerGas === undefined) !== (value.maxPriorityFeePerGas === undefined)) {
      context.addIssue({ code: "custom", message: "incomplete fee model" });
    }
    if (value.type === "0x2" && (hasLegacy || !hasMax)) {
      context.addIssue({ code: "custom", message: "invalid type 2 fees" });
    }
    if ((value.type === "0x0" || value.type === "0x1") && hasMax) {
      context.addIssue({ code: "custom", message: "invalid legacy fees" });
    }
  });

const allowed = new Set([
  "from",
  "to",
  "data",
  "input",
  "value",
  "gas",
  "gasLimit",
  "nonce",
  "type",
  "chainId",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "accessList",
]);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function inspectPlainObject(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", path);
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", path);
  }
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key === "symbol") {
      throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", path);
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", `${path}.${key}`);
    }
  }
  return raw as Record<string, unknown>;
}

function read(object: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function quantity(raw: unknown, path: string): string {
  let value: bigint;
  try {
    if (typeof raw === "number") {
      if (!Number.isSafeInteger(raw) || raw < 0) throw new Error();
      value = BigInt(raw);
    } else if (typeof raw === "string" && /^(?:0|[1-9][0-9]*)$/.test(raw)) {
      value = BigInt(raw);
    } else if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) {
      value = BigInt(raw);
    } else if (typeof raw === "object" && raw !== null) {
      const wrapper = inspectPlainObject(raw, path);
      if (Object.keys(wrapper).sort().join(",") !== "hex,type") throw new Error();
      if (read(wrapper, "type") !== "BigNumber") throw new Error();
      const hex = read(wrapper, "hex");
      if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error();
      value = BigInt(hex);
    } else {
      throw new Error();
    }
  } catch {
    throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", path);
  }
  return `0x${value.toString(16)}`;
}

function address(raw: unknown, path: string): string {
  if (typeof raw !== "string" || !isAddress(raw)) {
    throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", path);
  }
  return getAddress(raw).toLowerCase();
}

function data(raw: unknown, path: string): string {
  if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) {
    throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", path);
  }
  return raw.toLowerCase();
}

function arrayDescriptors(raw: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(raw)) throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", path);
  const names = Object.getOwnPropertyNames(raw);
  for (const name of names) {
    if (name === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(name)) {
      throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", `${path}.${name}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", `${path}[${name}]`);
    }
  }
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", `${path}[${index}]`);
    }
  }
  return raw;
}

function accessList(raw: unknown): readonly WalletAccessListEntryV1[] {
  return arrayDescriptors(raw, "$.accessList").map((entry, index) => {
    const object = inspectPlainObject(entry, `$.accessList[${index}]`);
    const keys = Object.keys(object).sort();
    if (keys.join(",") !== "address,storageKeys") {
      throw new WalletTransactionError("UNSUPPORTED_SIGNING_FIELD", `$.accessList[${index}]`);
    }
    const storageKeys = arrayDescriptors(
      read(object, "storageKeys"),
      `$.accessList[${index}].storageKeys`,
    ).map((key, keyIndex) => {
      if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new WalletTransactionError(
          "MALFORMED_PREPARED_TRANSACTION",
          `$.accessList[${index}].storageKeys[${keyIndex}]`,
        );
      }
      return key.toLowerCase();
    });
    return Object.freeze({
      address: address(read(object, "address"), `$.accessList[${index}].address`),
      storageKeys: Object.freeze(storageKeys),
    });
  });
}

function optionalQuantity(object: Record<string, unknown>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(object, key)
    ? quantity(read(object, key), `$.${key}`)
    : undefined;
}

export function projectPreparedTransactionV1(raw: unknown): NormalizedPreparedTransactionV1 {
  const object = inspectPlainObject(raw, "$");
  const keys = Object.keys(object).sort();
  if (keys.length === 0) throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", "$");
  const unknown = keys.find((key) => !allowed.has(key));
  if (unknown) throw new WalletTransactionError("UNSUPPORTED_SIGNING_FIELD", `$.${unknown}`);
  if (!Object.prototype.hasOwnProperty.call(object, "from")) {
    throw new WalletTransactionError("PREPARED_TRANSACTION_INCOMPLETE", "$.from");
  }
  if (!Object.prototype.hasOwnProperty.call(object, "chainId")) {
    throw new WalletTransactionError("PREPARED_TRANSACTION_INCOMPLETE", "$.chainId");
  }

  const from = address(read(object, "from"), "$.from");
  const to = Object.prototype.hasOwnProperty.call(object, "to")
    ? address(read(object, "to"), "$.to")
    : undefined;
  const dataValue = Object.prototype.hasOwnProperty.call(object, "data")
    ? data(read(object, "data"), "$.data")
    : undefined;
  const inputValue = Object.prototype.hasOwnProperty.call(object, "input")
    ? data(read(object, "input"), "$.input")
    : undefined;
  if (dataValue !== undefined && inputValue !== undefined && dataValue !== inputValue) {
    throw new WalletTransactionError("CONFLICTING_TRANSACTION_FIELDS", "$.input");
  }
  const gasValue = optionalQuantity(object, "gas");
  const gasLimitValue = optionalQuantity(object, "gasLimit");
  if (gasValue !== undefined && gasLimitValue !== undefined && gasValue !== gasLimitValue) {
    throw new WalletTransactionError("CONFLICTING_TRANSACTION_FIELDS", "$.gasLimit");
  }
  const typeValue = optionalQuantity(object, "type");
  if (typeValue !== undefined && !["0x0", "0x1", "0x2"].includes(typeValue)) {
    throw new WalletTransactionError("UNSUPPORTED_SIGNING_FIELD", "$.type");
  }
  const gasPrice = optionalQuantity(object, "gasPrice");
  const maxFeePerGas = optionalQuantity(object, "maxFeePerGas");
  const maxPriorityFeePerGas = optionalQuantity(object, "maxPriorityFeePerGas");
  const hasMax = maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined;
  if (gasPrice !== undefined && hasMax) {
    throw new WalletTransactionError("CONFLICTING_TRANSACTION_FIELDS", "$.gasPrice");
  }
  if ((maxFeePerGas === undefined) !== (maxPriorityFeePerGas === undefined)) {
    throw new WalletTransactionError("PREPARED_TRANSACTION_INCOMPLETE", "$.maxFeePerGas");
  }
  if (maxFeePerGas && maxPriorityFeePerGas && BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
    throw new WalletTransactionError("CONFLICTING_TRANSACTION_FIELDS", "$.maxPriorityFeePerGas");
  }
  if (typeValue === "0x2" && (gasPrice !== undefined || !hasMax)) {
    throw new WalletTransactionError("CONFLICTING_TRANSACTION_FIELDS", "$.type");
  }
  if ((typeValue === "0x0" || typeValue === "0x1") && hasMax) {
    throw new WalletTransactionError("CONFLICTING_TRANSACTION_FIELDS", "$.type");
  }

  const request: Record<string, unknown> = { from };
  if (to !== undefined) request.to = to;
  const gas = gasValue ?? gasLimitValue;
  if (gas !== undefined) request.gas = gas;
  if (gasPrice !== undefined) request.gasPrice = gasPrice;
  if (maxFeePerGas !== undefined) request.maxFeePerGas = maxFeePerGas;
  if (maxPriorityFeePerGas !== undefined) request.maxPriorityFeePerGas = maxPriorityFeePerGas;
  const value = optionalQuantity(object, "value");
  if (value !== undefined) request.value = value;
  const calldata = dataValue ?? inputValue;
  if (calldata !== undefined) request.data = calldata;
  const nonce = optionalQuantity(object, "nonce");
  if (nonce !== undefined) request.nonce = nonce;
  if (typeValue !== undefined) request.type = typeValue;
  if (Object.prototype.hasOwnProperty.call(object, "accessList")) {
    request.accessList = accessList(read(object, "accessList"));
  }

  const walletRequest = deepFreeze(walletTransactionRequestV1Schema.parse(request)) as WalletTransactionRequestV1;
  return Object.freeze({
    chainId: quantity(read(object, "chainId"), "$.chainId"),
    walletRequest,
  });
}

export function validateWalletTransactionRequestV1(raw: unknown): WalletTransactionRequestV1 {
  try {
    canonicalizeJson(raw);
  } catch {
    throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", "$.walletRequest");
  }
  const parsed = walletTransactionRequestV1Schema.safeParse(raw);
  if (!parsed.success) throw new WalletTransactionError("MALFORMED_PREPARED_TRANSACTION", "$.walletRequest");
  return deepFreeze(parsed.data) as WalletTransactionRequestV1;
}
