import { canonicalizeJson } from "@/core";
import { z } from "zod";
import {
  validateWalletTransactionRequestV1,
  walletTransactionRequestV1Schema,
  type WalletTransactionRequestV1,
} from "./transaction";
import { walletExecutionIntentHashSchema } from "./execution-authorization";
import { assertBoundedWalletValue } from "./bounds";
import { WALLET_BOUNDARY_LIMITS } from "./limits";

const identifierSchema = z.string().min(1).max(1_024);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);

export const sendAuthorizedEnvelopeV1Schema = z.strictObject({
  domain: z.literal("edict.send-authorized-envelope.v1"),
  expectedRevision: z.number().int().safe().positive(),
  invocationAttemptId: identifierSchema,
  walletIntentHash: walletExecutionIntentHashSchema,
  requiredSigner: addressSchema,
  chainRequirement: z.strictObject({
    decimalChainId: z.literal("11155111"),
    rpcChainId: z.literal("0xaa36a7"),
  }),
  walletRequest: walletTransactionRequestV1Schema,
}).superRefine((envelope, context) => {
  if (envelope.walletRequest.from !== envelope.requiredSigner) {
    context.addIssue({ code: "custom", message: "wallet signer mismatch" });
  }
  if (
    envelope.walletRequest.to === undefined ||
    envelope.walletRequest.data === undefined ||
    envelope.walletRequest.value === undefined ||
    envelope.walletRequest.nonce === undefined ||
    envelope.walletRequest.gas === undefined ||
    envelope.walletRequest.type !== "0x2" ||
    envelope.walletRequest.maxFeePerGas === undefined ||
    envelope.walletRequest.maxPriorityFeePerGas === undefined ||
    envelope.walletRequest.gasPrice !== undefined
  ) {
    context.addIssue({ code: "custom", message: "wallet request is incomplete" });
  }
});

export type SendAuthorizedEnvelopeV1 = Readonly<{
  domain: "edict.send-authorized-envelope.v1";
  expectedRevision: number;
  invocationAttemptId: string;
  walletIntentHash: `sha256:${string}`;
  requiredSigner: string;
  chainRequirement: Readonly<{
    decimalChainId: "11155111";
    rpcChainId: "0xaa36a7";
  }>;
  walletRequest: WalletTransactionRequestV1;
}>;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

export function parseSendAuthorizedEnvelopeV1(raw: unknown): SendAuthorizedEnvelopeV1 {
  assertBoundedWalletValue(raw, {
    maxCodeUnits: WALLET_BOUNDARY_LIMITS.calldataBytes * 2 + 32_768,
    maxArrayLength: WALLET_BOUNDARY_LIMITS.storageKeysTotal,
    maxProperties: WALLET_BOUNDARY_LIMITS.transactionPropertyCount,
  });
  canonicalizeJson(raw);
  const parsed = sendAuthorizedEnvelopeV1Schema.parse(raw);
  const walletRequest = validateWalletTransactionRequestV1(parsed.walletRequest);
  return deepFreeze({ ...parsed, walletRequest }) as SendAuthorizedEnvelopeV1;
}
