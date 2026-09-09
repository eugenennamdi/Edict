import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createBrickkenServerAdapter } from "./adapter";
import type { ConfirmedWhitelistEvidence } from "./types";
import encodingA from "./test-vectors/prepare/newTokenization.response.json";
import whitelistPrepare from "./test-vectors/prepare/whitelist.response.json";
import mintPrepare from "./test-vectors/prepare/mintToken.response.single.json";
import sendPending from "./test-vectors/send/pending.response.json";
import statusSuccess from "./test-vectors/status/success.response.json";
import statusPending from "./test-vectors/status/pending.response.json";
import statusRejected from "./test-vectors/status/rejected.response.json";
import tokenInfo from "./test-vectors/reads/token-info.asset.response.json";
import tokenizerInfo from "./test-vectors/reads/tokenizer-info.response.json";
import whitelistStatus from "./test-vectors/reads/whitelist-status.boolean.response.json";
import balanceWhitelist from "./test-vectors/reads/balance-whitelist.response.json";
import unauthorized from "./test-vectors/errors/unauthorized-endpoint.401.json";
import credits from "./test-vectors/errors/out-of-credits.message.json";
import unauthorizedSymbol from "./test-vectors/errors/unauthorized-token-symbol.message.json";

const TOKENIZER = "0x1111111111111111111111111111111111111111";
const INVESTOR = "0x2222222222222222222222222222222222222222";
const TEST_KEY = "test-key";

// Sanitized structural fixture from the 2026-09-09 controlled Phase 10C response.
// Only the observed top-level envelope and semantic category are retained;
// nested values and exact upstream prose were deliberately normalized.
const sanitizedLiveLicenseEntitlement400 = {
  errors: {
    messages: ["Sanitized license or entitlement rejection"],
    status: 400,
    name: "Bad Request",
  },
} as const;

const evidence: ConfirmedWhitelistEvidence = {
  runId: "run-1",
  whitelistTxId: "0xwl",
  stage: "READ_BACK_VERIFIED",
  investorWalletAddress: INVESTOR,
  isWhitelisted: true,
  source: "blockchain",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installKey() {
  process.env.BRICKKEN_API_KEY = TEST_KEY;
  process.env.BRICKKEN_BASE_URL = "https://api.sandbox.brickken.com";
}

afterEach(() => {
  delete process.env.BRICKKEN_API_KEY;
  delete process.env.BRICKKEN_BASE_URL;
});

describe("Brickken server adapter", () => {
  it("prepares tokenization against the encoding A fixture", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createBrickkenServerAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return jsonResponse(encodingA);
      },
    });
    installKey();
    const result = await adapter.prepareTokenization({
      signerAddress: TOKENIZER,
      tokenizerEmail: "tokenizer@example.com",
      name: "Example Token",
      tokenSymbol: "EXMPL",
      supplyCap: "1000000",
      documentationUrl: "https://example.com/token-docs",
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain("/prepare-transactions");
    expect(calls[0]?.body).toMatchObject({
      method: "newTokenization",
      chainId: "11155111",
      executionMode: "client-broadcast",
      tokenType: "RWA_TOKEN",
    });
    if (result.ok) {
      expect(result.value.txId).toBe(encodingA.txId);
      expect(result.value.executionMode).toBe("client-broadcast");
    }
  });

  it("prepares whitelist without needKyc", async () => {
    const bodies: unknown[] = [];
    const adapter = createBrickkenServerAdapter({
      fetch: async (_input, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return jsonResponse(whitelistPrepare);
      },
    });
    installKey();
    const result = await adapter.prepareWhitelist({
      signerAddress: TOKENIZER,
      tokenSymbol: "EXMPL",
      investorAddress: INVESTOR,
      investorEmail: "investor@example.com",
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(bodies[0])).not.toContain("needKyc");
    expect(bodies[0]).toMatchObject({
      method: "whitelist",
      userToWhitelist: [{ whitelistStatus: true, investorEmail: "investor@example.com" }],
    });
  });

  it("enforces needWhitelist false and whitelist evidence for mint", async () => {
    const bodies: unknown[] = [];
    const adapter = createBrickkenServerAdapter({
      fetch: async (_input, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return jsonResponse(mintPrepare);
      },
    });
    installKey();
    const denied = await adapter.prepareMint(
      {
        signerAddress: TOKENIZER,
        tokenSymbol: "EXMPL",
        investorAddress: INVESTOR,
        investorEmail: "investor@example.com",
        amount: "25",
      },
      { ...evidence, isWhitelisted: true, investorWalletAddress: TOKENIZER },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("MINT_POLICY_VIOLATION");

    const allowed = await adapter.prepareMint(
      {
        signerAddress: TOKENIZER,
        tokenSymbol: "EXMPL",
        investorAddress: INVESTOR,
        investorEmail: "investor@example.com",
        amount: "25",
      },
      evidence,
    );
    expect(allowed.ok).toBe(true);
    expect(bodies[0]).toMatchObject({
      method: "mintToken",
      userToMint: [{ needWhitelist: false, amount: "25" }],
    });
  });

  it("confirms a client-broadcast pair and parses status variants", async () => {
    const adapter = createBrickkenServerAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/send-transactions")) return jsonResponse(sendPending);
        if (url.includes("status=pending") || url.includes("txId=pending")) {
          return jsonResponse(statusPending);
        }
        if (url.includes("rejected")) return jsonResponse(statusRejected);
        return jsonResponse(statusSuccess);
      },
    });
    installKey();
    const sent = await adapter.confirmBroadcast({
      txId: "0x11769b5c2028a8ed0a3bdc7599e244aee68e2cae80261d8954e44c3b5cb621a4",
      txHash: "0x9f2c1f4b6e8a3d5c7b0e1a2d4f6c8b0a3e5d7c9f1b3a5c7e9d1f3b5a7c9e1d3f",
    });
    expect(sent.ok).toBe(true);
    if (sent.ok) expect(sent.value.status).toBe("pending");

    const success = await adapter.getTransactionStatus({ txId: "0xabc" });
    expect(success.ok).toBe(true);
    if (success.ok) expect(success.value.status).toBe("success");
  });

  it("parses read-back fixtures", async () => {
    const adapter = createBrickkenServerAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/get-token-info")) return jsonResponse(tokenInfo);
        if (url.includes("/get-tokenizer-info")) return jsonResponse(tokenizerInfo);
        if (url.includes("/get-whitelist-status")) {
          expect(url).toContain("address=");
          expect(url).not.toContain("investorAddress=");
          return jsonResponse(whitelistStatus);
        }
        if (url.includes("/get-balance-whitelist")) return jsonResponse(balanceWhitelist);
        return jsonResponse({});
      },
    });
    installKey();
    const token = await adapter.getTokenInfo({ tokenSymbol: "EXMPL" });
    const tokenizer = await adapter.getTokenizerInfo({ tokenSymbol: "EXMPL" });
    const whitelist = await adapter.getWhitelistStatus({
      tokenSymbol: "EXMPL",
      address: INVESTOR,
    });
    const balance = await adapter.getBalanceAndWhitelist({
      tokenSymbol: "EXMPL",
      investorEmail: "investor@example.com",
    });
    expect(token.ok && tokenizer.ok && whitelist.ok && balance.ok).toBe(true);
    if (tokenizer.ok) expect(tokenizer.value.tokenAddress).toContain("0x");
    if (whitelist.ok) expect(whitelist.value.isWhitelisted).toBe(true);
    if (balance.ok) {
      expect(balance.value.tokenBalanceRaw).toBe("500000000000000000000");
      expect(balance.value.tokenDecimals).toBe(18);
    }
  });

  it("maps authentication and credit errors without leaking the key", async () => {
    const adapter = createBrickkenServerAdapter({
      fetch: async () => jsonResponse(unauthorized, 401),
    });
    process.env.BRICKKEN_API_KEY = TEST_KEY;
    process.env.BRICKKEN_BASE_URL = "https://api.sandbox.brickken.com";
    const result = await adapter.getTokenInfo({ tokenSymbol: "EXMPL" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTHENTICATION_REJECTED");
      expect(result.error.message).not.toContain(TEST_KEY);
      expect(JSON.stringify(result.error)).not.toContain(TEST_KEY);
    }

    const creditAdapter = createBrickkenServerAdapter({
      fetch: async () => jsonResponse(credits, 400),
    });
    const credit = await creditAdapter.prepareTokenization({
      signerAddress: TOKENIZER,
      tokenizerEmail: "tokenizer@example.com",
      name: "Example Token",
      tokenSymbol: "EXMPL",
      supplyCap: "1000",
      documentationUrl: "https://example.com/token-docs",
    });
    expect(credit.ok).toBe(false);
    if (!credit.ok) expect(credit.error.code).toBe("CREDITS_EXHAUSTED");

    const symbolAdapter = createBrickkenServerAdapter({
      fetch: async () => jsonResponse(unauthorizedSymbol, 400),
    });
    const symbol = await symbolAdapter.getTokenInfo({ tokenSymbol: "NOPE" });
    expect(symbol.ok).toBe(false);
    if (!symbol.ok) expect(symbol.error.code).toBe("ENTITLEMENT_REJECTED");
  });

  it("classifies the sanitized live HTTP 400 license envelope as a definite entitlement refusal", async () => {
    const adapter = createBrickkenServerAdapter({
      fetch: async () => jsonResponse(sanitizedLiveLicenseEntitlement400, 400),
    });
    installKey();

    const result = await adapter.prepareTokenization({
      signerAddress: TOKENIZER,
      tokenizerEmail: "tokenizer@example.com",
      name: "Example Token",
      tokenSymbol: "EXMPL",
      supplyCap: "1000",
      documentationUrl: "https://example.com/token-docs",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ENTITLEMENT_REJECTED");
      expect(result.error.message).not.toContain("Sanitized license");
      expect(JSON.stringify(result.error)).not.toContain(TEST_KEY);
    }
  });

  it("classifies other SDK HTTP 400 API errors as definite invalid requests", async () => {
    const adapter = createBrickkenServerAdapter({
      fetch: async () => jsonResponse({ errors: { messages: ["A rejected request"] } }, 400),
    });
    installKey();

    const result = await adapter.prepareTokenization({
      signerAddress: TOKENIZER,
      tokenizerEmail: "tokenizer@example.com",
      name: "Example Token",
      tokenSymbol: "EXMPL",
      supplyCap: "1000",
      documentationUrl: "https://example.com/token-docs",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_REQUEST");
  });

  it("refuses upstream values containing the API key instead of returning them", async () => {
    const leakedPrepare = structuredClone(encodingA);
    Object.assign(leakedPrepare.transactions[0], { diagnostic: TEST_KEY });
    const prepareAdapter = createBrickkenServerAdapter({
      fetch: async () => jsonResponse(leakedPrepare),
    });
    installKey();
    const prepared = await prepareAdapter.prepareTokenization({
      signerAddress: TOKENIZER,
      tokenizerEmail: "tokenizer@example.com",
      name: "Example Token",
      tokenSymbol: "EXMPL",
      supplyCap: "1000",
      documentationUrl: "https://example.com/token-docs",
    });
    expect(prepared.ok).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(TEST_KEY);

    const readAdapter = createBrickkenServerAdapter({
      fetch: async () => jsonResponse({ currencyName: TEST_KEY }),
    });
    const read = await readAdapter.getNetworkInfo({ chainId: "11155111" });
    expect(read.ok).toBe(false);
    expect(JSON.stringify(read)).not.toContain(TEST_KEY);
  });

  it("rejects a production base URL and missing key", async () => {
    const adapter = createBrickkenServerAdapter({
      fetch: async () => {
        throw new Error("network should not be used");
      },
    });
    process.env.BRICKKEN_API_KEY = TEST_KEY;
    process.env.BRICKKEN_BASE_URL = "https://api.brickken.com";
    const production = await adapter.getTokenInfo({ tokenSymbol: "EXMPL" });
    expect(production.ok).toBe(false);
    if (!production.ok) expect(production.error.code).toBe("CONFIGURATION_MISSING");

    delete process.env.BRICKKEN_API_KEY;
    process.env.BRICKKEN_BASE_URL = "https://api.sandbox.brickken.com";
    const missing = await adapter.getTokenInfo({ tokenSymbol: "EXMPL" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("CONFIGURATION_MISSING");
  });

  it("uses an explicitly injected sandbox configuration without reading global environment", async () => {
    const requests: string[] = [];
    const adapter = createBrickkenServerAdapter({
      runtimeConfig: {
        apiKey: TEST_KEY,
        baseUrl: "https://api.sandbox.brickken.com",
        chainId: "11155111",
      },
      fetch: async (input) => {
        requests.push(String(input));
        return jsonResponse({
          currencyName: "Sepolia ETH",
          blockExplorerUrl: "https://sepolia.etherscan.io",
        });
      },
    });
    delete process.env.BRICKKEN_API_KEY;
    delete process.env.BRICKKEN_BASE_URL;

    const result = await adapter.getNetworkInfo({ chainId: "11155111" });

    expect(result).toEqual({
      ok: true,
      value: {
        currencyName: "Sepolia ETH",
        blockExplorerHost: "sepolia.etherscan.io",
      },
    });
    expect(requests).toEqual([
      "https://api.sandbox.brickken.com/get-network-info?chainId=11155111",
    ]);
  });

  it("rejects unexpected network-info response fields", async () => {
    const adapter = createBrickkenServerAdapter({
      runtimeConfig: {
        apiKey: TEST_KEY,
        baseUrl: "https://api.sandbox.brickken.com",
        chainId: "11155111",
      },
      fetch: async () => jsonResponse({
        currencyName: "Sepolia ETH",
        blockExplorerUrl: "https://sepolia.etherscan.io",
        signer: TOKENIZER,
      }),
    });

    const result = await adapter.getNetworkInfo({ chainId: "11155111" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_EXTERNAL_RESPONSE");
  });

  it("excludes the live smoke test from the default Vitest config", () => {
    const config = fs.readFileSync(path.resolve(__dirname, "../../../vitest.config.mts"), "utf-8");
    expect(config).toContain("live-read.smoke.test.ts");
  });
});
