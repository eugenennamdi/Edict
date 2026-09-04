import { canonicalizeJson, hashCanonicalJson } from "@/core";
import { z } from "zod";
import type { WalletOperationKind } from "./semantic-policy";
import {
  validateWalletTransactionRequestV1,
  walletTransactionRequestV1Schema,
  type WalletTransactionRequestV1,
} from "./transaction";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);

export interface WalletIntentV1 {
  readonly domain: "edict.wallet-intent.v1";
  readonly runId: string;
  readonly manifestHash: `sha256:${string}`;
  readonly planHash: `sha256:${string}`;
  readonly environment: "sandbox";
  readonly operation: {
    readonly id: string;
    readonly kind: WalletOperationKind;
  };
  readonly preparedTransactionId: string;
  readonly requiredSigner: string;
  readonly chainId: "11155111";
  readonly promptRevision: number;
  readonly walletRequestVersion: "1.0";
  readonly walletRequest: WalletTransactionRequestV1;
}

export interface WalletPromptEnvelopeV1 extends Omit<WalletIntentV1, "domain"> {
  readonly envelopeVersion: "1.0";
  readonly chainRequirement: {
    readonly mode: "PROVIDER_PRECONDITION";
    readonly decimalChainId: "11155111";
    readonly rpcChainId: "0xaa36a7";
  };
  readonly integrity: {
    readonly algorithm: "SHA-256";
    readonly walletIntentHash: `sha256:${string}`;
  };
}

const walletPromptEnvelopeSchema = z.strictObject({
  envelopeVersion: z.literal("1.0"),
  runId: z.string().uuid(),
  manifestHash: digestSchema,
  planHash: digestSchema,
  environment: z.literal("sandbox"),
  operation: z.strictObject({
    id: z.string().uuid(),
    kind: z.enum(["TOKENIZE", "WHITELIST", "MINT"]),
  }),
  preparedTransactionId: z.string().min(1).max(256),
  requiredSigner: addressSchema,
  chainId: z.literal("11155111"),
  promptRevision: z.number().int().positive(),
  walletRequestVersion: z.literal("1.0"),
  walletRequest: walletTransactionRequestV1Schema,
  chainRequirement: z.strictObject({
    mode: z.literal("PROVIDER_PRECONDITION"),
    decimalChainId: z.literal("11155111"),
    rpcChainId: z.literal("0xaa36a7"),
  }),
  integrity: z.strictObject({
    algorithm: z.literal("SHA-256"),
    walletIntentHash: digestSchema,
  }),
});

function intentFromEnvelope(envelope: Omit<WalletPromptEnvelopeV1, "integrity">): WalletIntentV1 {
  return Object.freeze({
    domain: "edict.wallet-intent.v1",
    runId: envelope.runId,
    manifestHash: envelope.manifestHash,
    planHash: envelope.planHash,
    environment: envelope.environment,
    operation: Object.freeze({ ...envelope.operation }),
    preparedTransactionId: envelope.preparedTransactionId,
    requiredSigner: envelope.requiredSigner,
    chainId: envelope.chainId,
    promptRevision: envelope.promptRevision,
    walletRequestVersion: envelope.walletRequestVersion,
    walletRequest: validateWalletTransactionRequestV1(envelope.walletRequest),
  });
}

export async function hashWalletIntentV1(intent: WalletIntentV1) {
  return hashCanonicalJson(intent);
}

export async function createWalletPromptEnvelopeV1(
  input: Omit<WalletPromptEnvelopeV1, "integrity">,
): Promise<WalletPromptEnvelopeV1> {
  const intent = intentFromEnvelope(input);
  const { hash } = await hashWalletIntentV1(intent);
  return Object.freeze({
    ...input,
    operation: intent.operation,
    walletRequest: intent.walletRequest,
    chainRequirement: Object.freeze({ ...input.chainRequirement }),
    integrity: Object.freeze({
      algorithm: "SHA-256" as const,
      walletIntentHash: hash as `sha256:${string}`,
    }),
  });
}

export async function validateWalletPromptEnvelopeV1(raw: unknown): Promise<WalletPromptEnvelopeV1> {
  try {
    canonicalizeJson(raw);
  } catch {
    throw new Error("MALFORMED_PROMPT_ENVELOPE");
  }
  const parsed = walletPromptEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error("MALFORMED_PROMPT_ENVELOPE");
  const rebuilt = await createWalletPromptEnvelopeV1({
    envelopeVersion: parsed.data.envelopeVersion,
    runId: parsed.data.runId,
    manifestHash: parsed.data.manifestHash as `sha256:${string}`,
    planHash: parsed.data.planHash as `sha256:${string}`,
    environment: parsed.data.environment,
    operation: parsed.data.operation,
    preparedTransactionId: parsed.data.preparedTransactionId,
    requiredSigner: parsed.data.requiredSigner,
    chainId: parsed.data.chainId,
    promptRevision: parsed.data.promptRevision,
    walletRequestVersion: parsed.data.walletRequestVersion,
    walletRequest: parsed.data.walletRequest,
    chainRequirement: parsed.data.chainRequirement,
  });
  if (rebuilt.integrity.walletIntentHash !== parsed.data.integrity.walletIntentHash) {
    throw new Error("WALLET_INTENT_HASH_MISMATCH");
  }
  return rebuilt;
}
