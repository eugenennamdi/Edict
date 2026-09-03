import { describe, expect, it } from "vitest";
import { validateAssetManifestV1 } from "./manifest";
import {
  createValidRawManifest,
  INVESTOR_ADDRESS,
  TOKENIZER_ADDRESS,
} from "./test-fixtures";

function expectInvalid(input: unknown, code: string, path: string): void {
  const result = validateAssetManifestV1(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, path })]),
    );
  }
}

describe("validateAssetManifestV1", () => {
  it("returns a fresh, normalized, deeply frozen manifest", () => {
    const raw = createValidRawManifest();
    const result = validateAssetManifestV1(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      schemaVersion: "1.0",
      environment: "sandbox",
      chainId: "11155111",
      tokenizer: {
        email: "tokenizer@example.com",
        walletAddress: TOKENIZER_ADDRESS,
      },
      asset: {
        name: "Café Receivables",
        symbol: "ED1",
        tokenType: "RWA_TOKEN",
        supplyCap: "1000",
        documentationUrl: "https://docs.example.com/asset?b=2&a=1",
      },
      investor: {
        email: "investor@example.com",
        walletAddress: INVESTOR_ADDRESS,
        mintAmount: "25",
      },
    });
    expect(result.value).not.toBe(raw);
    expect(result.value.tokenizer).not.toBe(raw.tokenizer);
    expect(result.value.asset).not.toBe(raw.asset);
    expect(result.value.investor).not.toBe(raw.investor);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.tokenizer)).toBe(true);
    expect(Object.isFrozen(result.value.asset)).toBe(true);
    expect(Object.isFrozen(result.value.investor)).toBe(true);
  });

  it("normalizes canonically equivalent Unicode asset names", () => {
    const composed = createValidRawManifest();
    composed.asset.name = "Café Receivables";
    const decomposed = createValidRawManifest();
    decomposed.asset.name = "Cafe\u0301 Receivables";

    const left = validateAssetManifestV1(composed);
    const right = validateAssetManifestV1(decomposed);
    expect(left.ok && right.ok && left.value.asset.name).toBe("Café Receivables");
    expect(left.ok && right.ok && left.value).toEqual(right.ok ? right.value : null);
  });

  it("expands and deterministically orders unknown keys", () => {
    const raw = createValidRawManifest() as ReturnType<typeof createValidRawManifest> & {
      zeta?: boolean;
      alpha?: boolean;
    };
    raw.zeta = true;
    raw.alpha = true;
    Object.assign(raw.asset, { zulu: true, alpha: true });

    const result = validateAssetManifestV1(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.filter((error) => error.code === "UNKNOWN_FIELD")).toEqual([
        { code: "UNKNOWN_FIELD", path: "alpha", message: "Unknown field is not allowed." },
        { code: "UNKNOWN_FIELD", path: "asset.alpha", message: "Unknown field is not allowed." },
        { code: "UNKNOWN_FIELD", path: "asset.zulu", message: "Unknown field is not allowed." },
        { code: "UNKNOWN_FIELD", path: "zeta", message: "Unknown field is not allowed." },
      ]);
    }
  });

  it.each([
    [null, "INVALID_ROOT", "$"],
    [[], "INVALID_ROOT", "$"],
    ["manifest", "INVALID_ROOT", "$"],
  ])("rejects an invalid root %#", (input, code, path) => {
    expectInvalid(input, code, path);
  });

  it.each([
    ["schemaVersion", "2.0", "INVALID_SCHEMA_VERSION"],
    ["environment", "production", "INVALID_ENVIRONMENT"],
    ["chainId", "1", "INVALID_CHAIN_ID"],
  ])("rejects invalid fixed field %s", (field, value, code) => {
    const raw = createValidRawManifest();
    Object.assign(raw, { [field]: value });
    expectInvalid(raw, code, field);
  });

  it("distinguishes missing fields from fields with the wrong type", () => {
    const missing = createValidRawManifest();
    Reflect.deleteProperty(missing.asset, "name");
    expectInvalid(missing, "REQUIRED_FIELD", "asset.name");

    const wrongType = createValidRawManifest();
    Object.assign(wrongType.asset, { name: 42 });
    expectInvalid(wrongType, "INVALID_FIELD_TYPE", "asset.name");
  });

  it("requires distinct normalized email addresses", () => {
    const raw = createValidRawManifest();
    raw.investor.email = " tokenizer@example.com ";
    expectInvalid(raw, "EMAILS_MUST_DIFFER", "investor.email");
  });

  it("rejects invalid email addresses", () => {
    const tokenizer = createValidRawManifest();
    tokenizer.tokenizer.email = "not-an-email";
    expectInvalid(tokenizer, "INVALID_TOKENIZER_EMAIL", "tokenizer.email");

    const investor = createValidRawManifest();
    investor.investor.email = "not-an-email";
    expectInvalid(investor, "INVALID_INVESTOR_EMAIL", "investor.email");
  });

  it("allows tokenizer and investor to use the same valid wallet", () => {
    const raw = createValidRawManifest();
    raw.investor.walletAddress = raw.tokenizer.walletAddress;
    const result = validateAssetManifestV1(raw);
    expect(result.ok).toBe(true);
  });

  it.each(["0x1234", "1111111111111111111111111111111111111111", `0x${"g".repeat(40)}`])(
    "rejects invalid wallet address %s",
    (walletAddress) => {
      const raw = createValidRawManifest();
      raw.investor.walletAddress = walletAddress;
      expectInvalid(raw, "INVALID_WALLET_ADDRESS", "investor.walletAddress");
    },
  );

  it("enforces the Edict 120-code-point asset-name limit", () => {
    const empty = createValidRawManifest();
    empty.asset.name = " \t ";
    expectInvalid(empty, "INVALID_ASSET_NAME", "asset.name");

    const tooLong = createValidRawManifest();
    tooLong.asset.name = "a".repeat(121);
    expectInvalid(tooLong, "INVALID_ASSET_NAME", "asset.name");
  });

  it.each(["AB", "ABCDEF", "AB-C", "A B", "ßA"])("rejects invalid token symbol %s", (symbol) => {
    const raw = createValidRawManifest();
    raw.asset.symbol = symbol;
    expectInvalid(raw, "INVALID_TOKEN_SYMBOL", "asset.symbol");
  });

  it.each(["0", "000", "-1", "+1", "1.0", "1e3", "1,000", " 1", "1 ", "١"])(
    "rejects invalid whole-token quantity %s",
    (supplyCap) => {
      const raw = createValidRawManifest();
      raw.asset.supplyCap = supplyCap;
      expectInvalid(raw, "INVALID_POSITIVE_INTEGER", "asset.supplyCap");
    },
  );

  it("never converts JavaScript numbers into financial strings", () => {
    const raw = createValidRawManifest();
    Object.assign(raw.asset, { supplyCap: 1000 });
    expectInvalid(raw, "INVALID_FIELD_TYPE", "asset.supplyCap");
  });

  it("accepts mint equal to supply and rejects mint greater than supply", () => {
    const equal = createValidRawManifest();
    equal.asset.supplyCap = "25";
    equal.investor.mintAmount = "25";
    expect(validateAssetManifestV1(equal).ok).toBe(true);

    const greater = createValidRawManifest();
    greater.asset.supplyCap = "24";
    greater.investor.mintAmount = "25";
    expectInvalid(greater, "MINT_EXCEEDS_SUPPLY", "investor.mintAmount");
  });

  it.each([
    "http://docs.example.com/asset",
    "/relative/asset",
    "not a url",
    "https://user@docs.example.com/asset",
    "https://user:password@docs.example.com/asset",
  ])("rejects invalid or credential-bearing documentation URL %s", (documentationUrl) => {
    const raw = createValidRawManifest();
    raw.asset.documentationUrl = documentationUrl;
    expectInvalid(raw, "INVALID_DOCUMENTATION_URL", "asset.documentationUrl");
  });

  it("returns stable frozen errors without input values or Zod details", () => {
    const raw = createValidRawManifest();
    raw.investor.email = "classified-invalid-email";
    const result = validateAssetManifestV1(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.isFrozen(result.errors)).toBe(true);
      expect(result.errors[0]).toEqual({
        code: "INVALID_INVESTOR_EMAIL",
        path: "investor.email",
        message: "Investor email is invalid.",
      });
      expect(JSON.stringify(result.errors)).not.toContain("classified-invalid-email");
      expect(JSON.stringify(result.errors)).not.toContain("Zod");
    }
  });
});
