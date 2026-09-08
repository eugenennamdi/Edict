import { z } from "zod";
import { canonicalizeJson } from "./canonical-json";
import { hashAssetManifestV1, hashCanonicalJson } from "./hashing";
import { deepFreeze, type DeepReadonly } from "./immutable";
import {
  getTrustedManifestSnapshot,
  type NormalizedAssetManifestV1,
} from "./manifest";

const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identitySchema = z.strictObject({
  email: z.string(),
  walletAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
});
const assetSchema = z.strictObject({
  name: z.string(),
  symbol: z.string().regex(/^[A-Z0-9]{3,5}$/),
  tokenType: z.literal("RWA_TOKEN"),
  supplyCap: z.string().regex(/^[1-9][0-9]*$/),
  documentationUrl: z.string(),
});

const tokenizeOperationSchema = z.strictObject({
  sequence: z.literal(1),
  id: z.literal("tokenize"),
  kind: z.literal("TOKENIZE"),
  mode: z.literal("WALLET_TRANSACTION"),
  dependsOn: z.tuple([]),
  signer: z.literal("tokenizer"),
  walletConfirmationRequired: z.literal(true),
  intent: z.strictObject({ tokenizer: identitySchema, asset: assetSchema }),
  summary: z.string(),
});

const confirmTokenizationOperationSchema = z.strictObject({
  sequence: z.literal(2),
  id: z.literal("confirm-tokenization"),
  kind: z.literal("CONFIRM_TOKENIZATION"),
  mode: z.literal("CONFIRM_AND_READ"),
  dependsOn: z.tuple([z.literal("tokenize")]),
  signer: z.null(),
  walletConfirmationRequired: z.literal(false),
  intent: z.strictObject({
    transactionOperationId: z.literal("tokenize"),
    reads: z.tuple([z.literal("TOKEN_INFO"), z.literal("TOKENIZER_INFO")]),
    expected: z.strictObject({
      chainId: z.literal("11155111"),
      tokenizer: identitySchema,
      asset: assetSchema,
      tokenAddressPresent: z.literal(true),
    }),
  }),
  summary: z.string(),
});

const whitelistOperationSchema = z.strictObject({
  sequence: z.literal(3),
  id: z.literal("whitelist-investor"),
  kind: z.literal("WHITELIST_INVESTOR"),
  mode: z.literal("WALLET_TRANSACTION"),
  dependsOn: z.tuple([z.literal("confirm-tokenization")]),
  signer: z.literal("tokenizer"),
  walletConfirmationRequired: z.literal(true),
  intent: z.strictObject({
    tokenSymbol: z.string(),
    investor: identitySchema,
    whitelist: z.literal(true),
  }),
  summary: z.string(),
});

const confirmWhitelistOperationSchema = z.strictObject({
  sequence: z.literal(4),
  id: z.literal("confirm-whitelist"),
  kind: z.literal("CONFIRM_WHITELIST"),
  mode: z.literal("CONFIRM_AND_READ"),
  dependsOn: z.tuple([z.literal("whitelist-investor")]),
  signer: z.null(),
  walletConfirmationRequired: z.literal(false),
  intent: z.strictObject({
    transactionOperationId: z.literal("whitelist-investor"),
    reads: z.tuple([z.literal("WHITELIST_STATUS")]),
    expected: z.strictObject({
      tokenSymbol: z.string(),
      investorWalletAddress: z.string(),
      isWhitelisted: z.literal(true),
    }),
  }),
  summary: z.string(),
});

const mintOperationSchema = z.strictObject({
  sequence: z.literal(5),
  id: z.literal("mint"),
  kind: z.literal("MINT"),
  mode: z.literal("WALLET_TRANSACTION"),
  dependsOn: z.tuple([z.literal("confirm-whitelist")]),
  signer: z.literal("tokenizer"),
  walletConfirmationRequired: z.literal(true),
  intent: z.strictObject({
    tokenSymbol: z.string(),
    investor: identitySchema,
    amount: z.string().regex(/^[1-9][0-9]*$/),
    whitelistPolicy: z.literal("REQUIRE_CONFIRMED_STANDALONE_WHITELIST"),
  }),
  summary: z.string(),
});

const confirmMintOperationSchema = z.strictObject({
  sequence: z.literal(6),
  id: z.literal("confirm-mint"),
  kind: z.literal("CONFIRM_MINT"),
  mode: z.literal("CONFIRM_AND_READ"),
  dependsOn: z.tuple([z.literal("mint")]),
  signer: z.null(),
  walletConfirmationRequired: z.literal(false),
  intent: z.strictObject({
    transactionOperationId: z.literal("mint"),
    reads: z.tuple([z.literal("BALANCE_AND_WHITELIST")]),
    expected: z.strictObject({
      tokenSymbol: z.string(),
      investorEmail: z.string(),
      investorWalletAddress: z.string(),
      isWhitelisted: z.literal(true),
      mintAmount: z.string(),
      balancePolicy: z.literal("EQUALS_MINT_AMOUNT_FOR_NEW_INVESTOR"),
    }),
  }),
  summary: z.string(),
});

const verifyDeploymentOperationSchema = z.strictObject({
  sequence: z.literal(7),
  id: z.literal("verify-deployment"),
  kind: z.literal("VERIFY_DEPLOYMENT"),
  mode: z.literal("FINAL_VERIFICATION"),
  dependsOn: z.tuple([z.literal("confirm-mint")]),
  signer: z.null(),
  walletConfirmationRequired: z.literal(false),
  intent: z.strictObject({
    requires: z.tuple([
      z.literal("TOKENIZATION_CONFIRMED"),
      z.literal("TOKEN_READ_BACK_MATCHED"),
      z.literal("WHITELIST_CONFIRMED"),
      z.literal("WHITELIST_READ_BACK_MATCHED"),
      z.literal("MINT_CONFIRMED"),
      z.literal("BALANCE_READ_BACK_MATCHED"),
    ]),
  }),
  summary: z.string(),
});

const executionPlanBodyV1Schema = z.strictObject({
  planVersion: z.literal("1.0"),
  manifestHash: sha256DigestSchema,
  environment: z.literal("sandbox"),
  chainId: z.literal("11155111"),
  requiredSigner: z.strictObject({
    role: z.literal("tokenizer"),
    walletAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  }),
  operations: z.tuple([
    tokenizeOperationSchema,
    confirmTokenizationOperationSchema,
    whitelistOperationSchema,
    confirmWhitelistOperationSchema,
    mintOperationSchema,
    confirmMintOperationSchema,
    verifyDeploymentOperationSchema,
  ]),
});

const executionPlanV1Schema = executionPlanBodyV1Schema.extend({
  planHash: sha256DigestSchema,
});

type ExecutionPlanV1Data = z.infer<typeof executionPlanV1Schema>;
export type ExecutionPlanV1 = DeepReadonly<ExecutionPlanV1Data>;

export type ExecutionPlanValidationResult =
  | Readonly<{ ok: true; value: ExecutionPlanV1 }>
  | Readonly<{ ok: false }>;

export class ExecutionPlanBuildError extends Error {
  readonly code: "INTERNAL_PLAN_INVARIANT" | "INVALID_NORMALIZED_MANIFEST";
  readonly path = "$";

  constructor(code: "INTERNAL_PLAN_INVARIANT" | "INVALID_NORMALIZED_MANIFEST") {
    super(
      code === "INVALID_NORMALIZED_MANIFEST"
        ? "A manifest produced by validateAssetManifestV1 is required."
        : "The deterministic execution plan violated its runtime schema.",
    );
    this.name = "ExecutionPlanBuildError";
    this.code = code;
  }
}

/**
 * Strictly validates an untrusted JSON representation of an execution plan.
 * This does not derive a plan or grant it authority; callers must separately
 * compare it with the server-derived plan and durable run identity.
 */
export function validateExecutionPlanV1(input: unknown): ExecutionPlanValidationResult {
  try {
    const json = JSON.parse(canonicalizeJson(input));
    const result = executionPlanV1Schema.safeParse(json);
    return result.success
      ? deepFreeze({ ok: true as const, value: deepFreeze(result.data) })
      : deepFreeze({ ok: false as const });
  } catch {
    return deepFreeze({ ok: false as const });
  }
}

export async function buildExecutionPlanV1(
  manifest: NormalizedAssetManifestV1,
): Promise<ExecutionPlanV1> {
  const snapshot = getTrustedManifestSnapshot(manifest);
  if (!snapshot) {
    throw new ExecutionPlanBuildError("INVALID_NORMALIZED_MANIFEST");
  }

  const { hash: manifestHash } = await hashAssetManifestV1(manifest);
  const tokenizer = {
    email: snapshot.tokenizer.email,
    walletAddress: snapshot.tokenizer.walletAddress,
  };
  const investor = {
    email: snapshot.investor.email,
    walletAddress: snapshot.investor.walletAddress,
  };
  const asset = {
    name: snapshot.asset.name,
    symbol: snapshot.asset.symbol,
    tokenType: snapshot.asset.tokenType,
    supplyCap: snapshot.asset.supplyCap,
    documentationUrl: snapshot.asset.documentationUrl,
  };

  const candidateBody = {
    planVersion: "1.0" as const,
    manifestHash,
    environment: "sandbox" as const,
    chainId: "11155111" as const,
    requiredSigner: {
      role: "tokenizer" as const,
      walletAddress: snapshot.tokenizer.walletAddress,
    },
    operations: [
      {
        sequence: 1 as const,
        id: "tokenize" as const,
        kind: "TOKENIZE" as const,
        mode: "WALLET_TRANSACTION" as const,
        dependsOn: [] as const,
        signer: "tokenizer" as const,
        walletConfirmationRequired: true as const,
        intent: {
          tokenizer: { ...tokenizer },
          asset: { ...asset },
        },
        summary: `Tokenize ${asset.name} (${asset.symbol}) on chain 11155111.`,
      },
      {
        sequence: 2 as const,
        id: "confirm-tokenization" as const,
        kind: "CONFIRM_TOKENIZATION" as const,
        mode: "CONFIRM_AND_READ" as const,
        dependsOn: ["tokenize"] as const,
        signer: null,
        walletConfirmationRequired: false as const,
        intent: {
          transactionOperationId: "tokenize" as const,
          reads: ["TOKEN_INFO", "TOKENIZER_INFO"] as const,
          expected: {
            chainId: "11155111" as const,
            tokenizer: { ...tokenizer },
            asset: { ...asset },
            tokenAddressPresent: true as const,
          },
        },
        summary: `Confirm tokenization and verify ${asset.symbol} token and tokenizer read-back.`,
      },
      {
        sequence: 3 as const,
        id: "whitelist-investor" as const,
        kind: "WHITELIST_INVESTOR" as const,
        mode: "WALLET_TRANSACTION" as const,
        dependsOn: ["confirm-tokenization"] as const,
        signer: "tokenizer" as const,
        walletConfirmationRequired: true as const,
        intent: {
          tokenSymbol: asset.symbol,
          investor: { ...investor },
          whitelist: true as const,
        },
        summary: `Whitelist investor ${investor.walletAddress} for ${asset.symbol}.`,
      },
      {
        sequence: 4 as const,
        id: "confirm-whitelist" as const,
        kind: "CONFIRM_WHITELIST" as const,
        mode: "CONFIRM_AND_READ" as const,
        dependsOn: ["whitelist-investor"] as const,
        signer: null,
        walletConfirmationRequired: false as const,
        intent: {
          transactionOperationId: "whitelist-investor" as const,
          reads: ["WHITELIST_STATUS"] as const,
          expected: {
            tokenSymbol: asset.symbol,
            investorWalletAddress: investor.walletAddress,
            isWhitelisted: true as const,
          },
        },
        summary: `Confirm and verify whitelist status for ${investor.walletAddress}.`,
      },
      {
        sequence: 5 as const,
        id: "mint" as const,
        kind: "MINT" as const,
        mode: "WALLET_TRANSACTION" as const,
        dependsOn: ["confirm-whitelist"] as const,
        signer: "tokenizer" as const,
        walletConfirmationRequired: true as const,
        intent: {
          tokenSymbol: asset.symbol,
          investor: { ...investor },
          amount: snapshot.investor.mintAmount,
          whitelistPolicy: "REQUIRE_CONFIRMED_STANDALONE_WHITELIST" as const,
        },
        summary: `Mint ${snapshot.investor.mintAmount} ${asset.symbol} to ${investor.walletAddress}.`,
      },
      {
        sequence: 6 as const,
        id: "confirm-mint" as const,
        kind: "CONFIRM_MINT" as const,
        mode: "CONFIRM_AND_READ" as const,
        dependsOn: ["mint"] as const,
        signer: null,
        walletConfirmationRequired: false as const,
        intent: {
          transactionOperationId: "mint" as const,
          reads: ["BALANCE_AND_WHITELIST"] as const,
          expected: {
            tokenSymbol: asset.symbol,
            investorEmail: investor.email,
            investorWalletAddress: investor.walletAddress,
            isWhitelisted: true as const,
            mintAmount: snapshot.investor.mintAmount,
            balancePolicy: "EQUALS_MINT_AMOUNT_FOR_NEW_INVESTOR" as const,
          },
        },
        summary: `Confirm mint and verify ${investor.walletAddress} holds ${snapshot.investor.mintAmount} ${asset.symbol}.`,
      },
      {
        sequence: 7 as const,
        id: "verify-deployment" as const,
        kind: "VERIFY_DEPLOYMENT" as const,
        mode: "FINAL_VERIFICATION" as const,
        dependsOn: ["confirm-mint"] as const,
        signer: null,
        walletConfirmationRequired: false as const,
        intent: {
          requires: [
            "TOKENIZATION_CONFIRMED",
            "TOKEN_READ_BACK_MATCHED",
            "WHITELIST_CONFIRMED",
            "WHITELIST_READ_BACK_MATCHED",
            "MINT_CONFIRMED",
            "BALANCE_READ_BACK_MATCHED",
          ] as const,
        },
        summary: `Verify the complete ${asset.symbol} deployment against the approved plan.`,
      },
    ] as const,
  };

  const bodyResult = executionPlanBodyV1Schema.safeParse(candidateBody);
  if (!bodyResult.success) {
    throw new ExecutionPlanBuildError("INTERNAL_PLAN_INVARIANT");
  }

  const { hash: planHash } = await hashCanonicalJson(bodyResult.data);
  const planResult = executionPlanV1Schema.safeParse({ ...bodyResult.data, planHash });
  if (!planResult.success) {
    throw new ExecutionPlanBuildError("INTERNAL_PLAN_INVARIANT");
  }

  return deepFreeze(planResult.data);
}
