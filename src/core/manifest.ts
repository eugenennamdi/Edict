import { z } from "zod";
import { deepFreeze, isDeepFrozen, type DeepReadonly } from "./immutable";

const normalizedManifestInstances = new WeakSet<object>();

const normalizeHumanString = (value: string): string => value.normalize("NFC").trim();
const codePointLength = (value: string): number => Array.from(value).length;

const normalizedEmailSchema = z
  .string()
  .transform(normalizeHumanString)
  .transform((value) => value.toLowerCase())
  .pipe(z.email());

const walletAddressSchema = z
  .string()
  .transform(normalizeHumanString)
  .transform((value) => value.toLowerCase())
  .pipe(z.string().regex(/^0x[0-9a-f]{40}$/));

const assetNameSchema = z
  .string()
  .transform(normalizeHumanString)
  .transform((value) => value.replace(/\s+/gu, " "))
  .refine((value) => codePointLength(value) > 0 && codePointLength(value) <= 120);

const tokenSymbolSchema = z
  .string()
  .transform(normalizeHumanString)
  .pipe(z.string().regex(/^[A-Za-z0-9]{3,5}$/))
  .transform((value) => value.toUpperCase());

const positiveDecimalIntegerSchema = z
  .string()
  .refine((value) => /^[0-9]+$/.test(value))
  .transform((value) => value.replace(/^0+(?=\d)/, ""))
  .refine((value) => value !== "0");

function parseDocumentationUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      ? parsed
      : null;
  } catch {
    return null;
  }
}

const documentationUrlSchema = z
  .string()
  .transform(normalizeHumanString)
  .refine((value) => parseDocumentationUrl(value) !== null)
  .transform((value) => parseDocumentationUrl(value)!.href);

const assetManifestV1Schema = z
  .strictObject({
    schemaVersion: z.literal("1.0"),
    environment: z.literal("sandbox"),
    chainId: z.literal("11155111"),
    tokenizer: z.strictObject({
      email: normalizedEmailSchema,
      walletAddress: walletAddressSchema,
    }),
    asset: z.strictObject({
      name: assetNameSchema,
      symbol: tokenSymbolSchema,
      tokenType: z.literal("RWA_TOKEN"),
      supplyCap: positiveDecimalIntegerSchema,
      documentationUrl: documentationUrlSchema,
    }),
    investor: z.strictObject({
      email: normalizedEmailSchema,
      walletAddress: walletAddressSchema,
      mintAmount: positiveDecimalIntegerSchema,
    }),
  })
  .superRefine((manifest, context) => {
    if (manifest.tokenizer.email === manifest.investor.email) {
      context.addIssue({
        code: "custom",
        path: ["investor", "email"],
        message: "EMAILS_MUST_DIFFER",
      });
    }

    if (
      /^[1-9][0-9]*$/.test(manifest.investor.mintAmount) &&
      /^[1-9][0-9]*$/.test(manifest.asset.supplyCap) &&
      BigInt(manifest.investor.mintAmount) > BigInt(manifest.asset.supplyCap)
    ) {
      context.addIssue({
        code: "custom",
        path: ["investor", "mintAmount"],
        message: "MINT_EXCEEDS_SUPPLY",
      });
    }
  });

type AssetManifestV1Data = z.infer<typeof assetManifestV1Schema>;
declare const normalizedAssetManifestV1Brand: unique symbol;

export type NormalizedAssetManifestV1 = DeepReadonly<AssetManifestV1Data> & {
  readonly [normalizedAssetManifestV1Brand]: "NormalizedAssetManifestV1";
};

export type ManifestValidationErrorCode =
  | "EMAILS_MUST_DIFFER"
  | "INVALID_ASSET_NAME"
  | "INVALID_CHAIN_ID"
  | "INVALID_DOCUMENTATION_URL"
  | "INVALID_ENVIRONMENT"
  | "INVALID_FIELD_TYPE"
  | "INVALID_INVESTOR_EMAIL"
  | "INVALID_POSITIVE_INTEGER"
  | "INVALID_ROOT"
  | "INVALID_SCHEMA_VERSION"
  | "INVALID_TOKENIZER_EMAIL"
  | "INVALID_TOKEN_SYMBOL"
  | "INVALID_TOKEN_TYPE"
  | "INVALID_WALLET_ADDRESS"
  | "MINT_EXCEEDS_SUPPLY"
  | "REQUIRED_FIELD"
  | "UNKNOWN_FIELD";

export type ManifestValidationError = Readonly<{
  code: ManifestValidationErrorCode;
  path: string;
  message: string;
}>;

export type ManifestValidationResult =
  | Readonly<{ ok: true; value: NormalizedAssetManifestV1 }>
  | Readonly<{ ok: false; errors: readonly ManifestValidationError[] }>;

const errorMessages: Readonly<Record<ManifestValidationErrorCode, string>> = {
  EMAILS_MUST_DIFFER: "Investor email must differ from tokenizer email.",
  INVALID_ASSET_NAME: "Asset name must contain 1 to 120 Unicode code points.",
  INVALID_CHAIN_ID: "Chain ID must be 11155111.",
  INVALID_DOCUMENTATION_URL: "Documentation URL must be an absolute HTTPS URL without credentials.",
  INVALID_ENVIRONMENT: "Environment must be sandbox.",
  INVALID_FIELD_TYPE: "Field has an invalid type.",
  INVALID_INVESTOR_EMAIL: "Investor email is invalid.",
  INVALID_POSITIVE_INTEGER: "Value must be a positive whole-token decimal string.",
  INVALID_ROOT: "Manifest must be a plain object.",
  INVALID_SCHEMA_VERSION: "Schema version must be 1.0.",
  INVALID_TOKENIZER_EMAIL: "Tokenizer email is invalid.",
  INVALID_TOKEN_SYMBOL: "Token symbol must contain 3 to 5 uppercase ASCII letters or digits.",
  INVALID_TOKEN_TYPE: "Token type must be RWA_TOKEN.",
  INVALID_WALLET_ADDRESS: "Wallet address must contain 0x followed by 40 hexadecimal characters.",
  MINT_EXCEEDS_SUPPLY: "Mint amount must not exceed the supply cap.",
  REQUIRED_FIELD: "Required field is missing.",
  UNKNOWN_FIELD: "Unknown field is not allowed.",
};

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "$";
  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") return `${result}[${segment}]`;
    const key = String(segment);
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
      ? result === "$"
        ? key
        : `${result}.${key}`
      : `${result}[${JSON.stringify(key)}]`;
  }, "$" as string).replace(/^\$\./, "");
}

function hasOwnPath(input: unknown, path: readonly PropertyKey[]): boolean {
  let current = input;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (!descriptor) return false;
    if (!("value" in descriptor)) return true;
    current = descriptor.value;
  }
  return true;
}

function codeForPath(
  path: string,
  issue: z.core.$ZodIssue,
  input: unknown,
): ManifestValidationErrorCode {
  if (issue.code === "custom" && issue.message === "EMAILS_MUST_DIFFER") {
    return "EMAILS_MUST_DIFFER";
  }
  if (issue.code === "custom" && issue.message === "MINT_EXCEEDS_SUPPLY") {
    return "MINT_EXCEEDS_SUPPLY";
  }
  if (issue.code === "invalid_type") {
    if (path === "$") return "INVALID_ROOT";
    return hasOwnPath(input, issue.path) ? "INVALID_FIELD_TYPE" : "REQUIRED_FIELD";
  }

  switch (path) {
    case "schemaVersion":
      return "INVALID_SCHEMA_VERSION";
    case "environment":
      return "INVALID_ENVIRONMENT";
    case "chainId":
      return "INVALID_CHAIN_ID";
    case "tokenizer.email":
      return "INVALID_TOKENIZER_EMAIL";
    case "investor.email":
      return "INVALID_INVESTOR_EMAIL";
    case "tokenizer.walletAddress":
    case "investor.walletAddress":
      return "INVALID_WALLET_ADDRESS";
    case "asset.name":
      return "INVALID_ASSET_NAME";
    case "asset.symbol":
      return "INVALID_TOKEN_SYMBOL";
    case "asset.tokenType":
      return "INVALID_TOKEN_TYPE";
    case "asset.supplyCap":
    case "investor.mintAmount":
      return "INVALID_POSITIVE_INTEGER";
    case "asset.documentationUrl":
      return "INVALID_DOCUMENTATION_URL";
    default:
      return path === "$" ? "INVALID_ROOT" : "INVALID_FIELD_TYPE";
  }
}

function mapValidationErrors(error: z.ZodError, input: unknown): readonly ManifestValidationError[] {
  const errors: ManifestValidationError[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of [...issue.keys].sort()) {
        const path = formatPath([...issue.path, key]);
        errors.push({ code: "UNKNOWN_FIELD", path, message: errorMessages.UNKNOWN_FIELD });
      }
      continue;
    }

    const path = formatPath(issue.path);
    const code = codeForPath(path, issue, input);
    errors.push({ code, path, message: errorMessages[code] });
  }

  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  errors.sort(
    (left, right) =>
      compare(left.path, right.path) ||
      compare(left.code, right.code) ||
      compare(left.message, right.message),
  );

  return deepFreeze(errors);
}

function copyManifest(manifest: AssetManifestV1Data): AssetManifestV1Data {
  return {
    schemaVersion: manifest.schemaVersion,
    environment: manifest.environment,
    chainId: manifest.chainId,
    tokenizer: {
      email: manifest.tokenizer.email,
      walletAddress: manifest.tokenizer.walletAddress,
    },
    asset: {
      name: manifest.asset.name,
      symbol: manifest.asset.symbol,
      tokenType: manifest.asset.tokenType,
      supplyCap: manifest.asset.supplyCap,
      documentationUrl: manifest.asset.documentationUrl,
    },
    investor: {
      email: manifest.investor.email,
      walletAddress: manifest.investor.walletAddress,
      mintAmount: manifest.investor.mintAmount,
    },
  };
}

export function validateAssetManifestV1(input: unknown): ManifestValidationResult {
  const result = assetManifestV1Schema.safeParse(input);
  if (!result.success) {
    return deepFreeze({ ok: false, errors: mapValidationErrors(result.error, input) });
  }

  const value = deepFreeze(copyManifest(result.data)) as NormalizedAssetManifestV1;
  normalizedManifestInstances.add(value);
  return deepFreeze({ ok: true, value });
}

export function getTrustedManifestSnapshot(
  value: unknown,
): AssetManifestV1Data | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !normalizedManifestInstances.has(value) ||
    !isDeepFrozen(value)
  ) {
    return null;
  }

  const result = assetManifestV1Schema.safeParse(value);
  if (!result.success) return null;

  const candidate = value as AssetManifestV1Data;
  const normalized = result.data;
  const unchanged =
    candidate.schemaVersion === normalized.schemaVersion &&
    candidate.environment === normalized.environment &&
    candidate.chainId === normalized.chainId &&
    candidate.tokenizer.email === normalized.tokenizer.email &&
    candidate.tokenizer.walletAddress === normalized.tokenizer.walletAddress &&
    candidate.asset.name === normalized.asset.name &&
    candidate.asset.symbol === normalized.asset.symbol &&
    candidate.asset.tokenType === normalized.asset.tokenType &&
    candidate.asset.supplyCap === normalized.asset.supplyCap &&
    candidate.asset.documentationUrl === normalized.asset.documentationUrl &&
    candidate.investor.email === normalized.investor.email &&
    candidate.investor.walletAddress === normalized.investor.walletAddress &&
    candidate.investor.mintAmount === normalized.investor.mintAmount;

  return unchanged ? copyManifest(normalized) : null;
}
