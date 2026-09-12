import "server-only";

import {
  ApiError,
  AuthError,
  Brickken,
  CreditsExhaustedError,
  UnauthorizedTokenSymbolError,
  ValidationError,
} from "brickken-sdk";
import { assertBoundedWalletValue, WALLET_BOUNDARY_LIMITS } from "@/shared/wallet";
import {
  isSandboxBaseUrl,
  readBrickkenRuntimeConfig,
  SANDBOX_BASE_URL,
  SEPOLIA_CHAIN_ID,
  type BrickkenRuntimeConfig,
} from "./config";
import { BrickkenAdapterError, safeErrorMessage } from "./errors";
import { parsePreparedOperation } from "./prepared-transaction";
import {
  brickkenCorrelationRequestSchema,
  classifyCorrelationResponse,
  classifyCorrelationTransportError,
} from "./correlation";
import {
  buildTransactionStatusPath,
  parseTransactionStatusResponse,
  type BrickkenTransactionLocatorInput,
} from "./status";
import { executeBrickkenDirectRequest } from "./transport";
import type {
  AdapterResult,
  BalanceWhitelistView,
  BrickkenServerAdapter,
  BroadcastConfirmation,
  NetworkInfoView,
  PreparedOperation,
  TokenInfoView,
  TokenizerInfoView,
  TransactionStatusView,
  WhitelistStatusView,
} from "./types";
import {
  balanceWhitelistSchema,
  networkInfoSchema,
  sendResponseSchema,
  tokenInfoAssetSchema,
  tokenizerInfoSchema,
  whitelistStatusSchema,
} from "./wire-schemas";

export interface AdapterDependencies {
  readonly fetch?: typeof fetch;
  readonly runtimeConfig?: BrickkenRuntimeConfig;
}

const RETRY = { attempts: 1, baseDelayMs: 500, jitter: false };
const WRITE_OPTIONS = {
  execute: false as const,
  executionMode: "client-broadcast" as const,
};

function fail<T>(code: BrickkenAdapterError["code"], secret?: string): AdapterResult<T> {
  return { ok: false, error: safeErrorMessage(code, secret) };
}

function mapCaughtError(error: unknown, secret?: string): BrickkenAdapterError {
  if (error instanceof BrickkenAdapterError) return error;
  if (error instanceof Error && error.message.includes("STATUS_CONTRADICTION")) {
    return safeErrorMessage("STATUS_CONTRADICTION", secret);
  }
  if (error instanceof AuthError) return safeErrorMessage("AUTHENTICATION_REJECTED", secret);
  if (error instanceof CreditsExhaustedError) return safeErrorMessage("CREDITS_EXHAUSTED", secret);
  if (error instanceof UnauthorizedTokenSymbolError) {
    return safeErrorMessage("ENTITLEMENT_REJECTED", secret);
  }
  if (error instanceof ValidationError) return safeErrorMessage("INVALID_REQUEST", secret);
  if (error instanceof ApiError && error.status === 400) {
    if (/licen[cs]e|subscription|entitlement/i.test(error.message)) {
      return safeErrorMessage("ENTITLEMENT_REJECTED", secret);
    }
    return safeErrorMessage("INVALID_REQUEST", secret);
  }
  return safeErrorMessage("INVALID_EXTERNAL_RESPONSE", secret);
}

function assertNoSecret(value: unknown, secret?: string): void {
  if (!secret) return;
  let rendered: string;
  try {
    rendered = JSON.stringify(value);
  } catch {
    throw safeErrorMessage("INVALID_EXTERNAL_RESPONSE", secret);
  }
  if (rendered.includes(secret)) {
    throw safeErrorMessage("INVALID_EXTERNAL_RESPONSE", secret);
  }
}

function assertBoundedBrickkenResponse(value: unknown): void {
  assertBoundedWalletValue(value, {
    maxCodeUnits: WALLET_BOUNDARY_LIMITS.brickkenResponseCodeUnits,
    maxArrayLength: 256,
    maxProperties: 128,
  });
}

export function createBrickkenServerAdapter(
  deps: AdapterDependencies = {},
): BrickkenServerAdapter {
  const injectedFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const runtimeConfig = (): BrickkenRuntimeConfig => deps.runtimeConfig ?? readBrickkenRuntimeConfig();

  const resolveClient = (config: BrickkenRuntimeConfig): AdapterResult<Brickken> => {
    if (!config.apiKey) return fail("CONFIGURATION_MISSING");
    if (!isSandboxBaseUrl(config.baseUrl)) return fail("CONFIGURATION_MISSING", config.apiKey);
    const client = new Brickken({
      env: "sandbox",
      baseUrl: SANDBOX_BASE_URL,
      apiKey: config.apiKey,
      fetch: injectedFetch,
      retry: RETRY,
    });
    return { ok: true, value: client };
  };

  const withClient = async <T>(
    operation: (client: Brickken, apiKey: string) => Promise<AdapterResult<T>>,
  ): Promise<AdapterResult<T>> => {
    const config = runtimeConfig();
    const client = resolveClient(config);
    if (!client.ok) return client;
    try {
      const result = await operation(client.value, config.apiKey ?? "");
      assertNoSecret(result, config.apiKey);
      return result;
    } catch (error) {
      return { ok: false, error: mapCaughtError(error, config.apiKey) };
    }
  };

  const parsePrepared = (raw: unknown, secret?: string): AdapterResult<PreparedOperation> => {
    assertBoundedBrickkenResponse(raw);
    assertNoSecret(raw, secret);
    return parsePreparedOperation(raw, secret);
  };

  return {
    async prepareTokenization(input) {
      return withClient(async (client, apiKey) => {
        const result = await client.tokenization.create(
          {
            chainId: SEPOLIA_CHAIN_ID,
            tokenizerEmail: input.tokenizerEmail,
            name: input.name,
            tokenSymbol: input.tokenSymbol,
            tokenType: "RWA_TOKEN",
            supplyCap: input.supplyCap,
            url: input.documentationUrl,
          },
          { ...WRITE_OPTIONS, signerAddress: input.signerAddress as `0x${string}` },
        );
        return parsePrepared(result.raw, apiKey);
      });
    },

    async prepareWhitelist(input) {
      return withClient(async (client, apiKey) => {
        const result = await client.tokenization.whitelist(
          {
            chainId: SEPOLIA_CHAIN_ID,
            tokenSymbol: input.tokenSymbol,
            userToWhitelist: [
              {
                investorAddress: input.investorAddress,
                investorEmail: input.investorEmail,
                whitelistStatus: true,
              },
            ],
          },
          { ...WRITE_OPTIONS, signerAddress: input.signerAddress as `0x${string}` },
        );
        return parsePrepared(result.raw, apiKey);
      });
    },

    async prepareMint(input, evidence) {
      // EDICT_DECISION: standalone whitelist then mint with needWhitelist: false.
      // Awaiting authenticated write-contract validation (Phase 3 C21).
      if (
        evidence.stage !== "READ_BACK_VERIFIED" ||
        evidence.isWhitelisted !== true ||
        evidence.source !== "blockchain" ||
        evidence.investorWalletAddress.toLowerCase() !== input.investorAddress.toLowerCase()
      ) {
        return fail("MINT_POLICY_VIOLATION");
      }
      return withClient(async (client, apiKey) => {
        const result = await client.tokenization.mint(
          {
            chainId: SEPOLIA_CHAIN_ID,
            tokenSymbol: input.tokenSymbol,
            userToMint: [
              {
                investorEmail: input.investorEmail,
                investorAddress: input.investorAddress,
                amount: input.amount,
                needWhitelist: false,
              },
            ],
          },
          { ...WRITE_OPTIONS, signerAddress: input.signerAddress as `0x${string}` },
        );
        return parsePrepared(result.raw, apiKey);
      });
    },

    async correlateClientBroadcast(input) {
      const parsedInput = brickkenCorrelationRequestSchema.safeParse(input);
      if (!parsedInput.success) {
        return fail("INVALID_REQUEST");
      }

      const config = runtimeConfig();
      if (!config.apiKey) return fail("CONFIGURATION_MISSING");
      if (!isSandboxBaseUrl(config.baseUrl)) return fail("CONFIGURATION_MISSING", config.apiKey);

      const correlatedAt = input.correlatedAt ?? new Date().toISOString();

      try {
        const directRes = await executeBrickkenDirectRequest({
          path: "/send-transactions",
          method: "POST",
          body: {
            txId: parsedInput.data.txId,
            txHash: parsedInput.data.txHash,
          },
          fetch: injectedFetch,
          runtimeConfig: config,
        });

        const classified = classifyCorrelationResponse({
          requestedTxHash: parsedInput.data.txHash,
          txId: parsedInput.data.txId,
          status: directRes.status,
          bodyText: directRes.bodyText,
          json: directRes.json,
          correlatedAt,
        });

        return { ok: true, value: classified };
      } catch (error) {
        const classified = classifyCorrelationTransportError(error);
        return { ok: true, value: classified };
      }
    },

    /**
     * @deprecated Legacy alias. Use `correlateClientBroadcast` for all client-broadcast execution.
     * Note: In client-broadcast execution mode, Brickken NEVER broadcasts or rebroadcasts transactions
     * on-chain; this call strictly delegates to correlation semantics with Brickken's Sepolia RPC.
     * No future production service should call this method by preference.
     */
    async confirmBroadcast(input) {
      if (typeof input.txId !== "string" || typeof input.txHash !== "string") {
        return fail("INVALID_REQUEST");
      }
      return withClient(async (client, apiKey) => {
        const result = await client.tx.send({ txId: input.txId, txHash: input.txHash });
        assertBoundedBrickkenResponse(result.raw);
        const parsed = sendResponseSchema.safeParse(result.raw);
        if (!parsed.success) return fail("INVALID_EXTERNAL_RESPONSE", apiKey);
        assertNoSecret(parsed.data, apiKey);
        return {
          ok: true,
          value: {
            txHash: parsed.data.txHash ?? null,
            status: parsed.data.status ?? null,
          } satisfies BroadcastConfirmation,
        };
      });
    },

    async getTransactionStatus(query) {
      if (
        (query.txId === undefined && query.hash === undefined) ||
        (query.txId !== undefined && query.hash !== undefined)
      ) {
        return fail("INVALID_REQUEST");
      }

      const locator: BrickkenTransactionLocatorInput =
        query.txId !== undefined
          ? { txId: query.txId }
          : { hash: query.hash! };

      const config = runtimeConfig();
      if (!config.apiKey) return fail("CONFIGURATION_MISSING");
      if (!isSandboxBaseUrl(config.baseUrl)) return fail("CONFIGURATION_MISSING", config.apiKey);

      try {
        const path = buildTransactionStatusPath(locator);
        const directRes = await executeBrickkenDirectRequest({
          path,
          method: "GET",
          fetch: injectedFetch,
          runtimeConfig: config,
        });

        if (!directRes.ok) {
          if (directRes.status === 401 || directRes.status === 403) {
            return fail("AUTHENTICATION_REJECTED", config.apiKey);
          }
          if (directRes.status === 400 || directRes.status === 422) {
            return fail("INVALID_REQUEST", config.apiKey);
          }
          return fail("INVALID_EXTERNAL_RESPONSE", config.apiKey);
        }

        const parsed = parseTransactionStatusResponse({
          json: directRes.json,
          locator,
          expectedTxHash: "expectedTxHash" in query ? query.expectedTxHash : undefined,
          httpStatus: directRes.status,
          responseByteCount: directRes.bodyText.length,
          contentType: directRes.headers.get("content-type"),
        });
        return {
          ok: true,
          value: {
            status: parsed.rawStatusText,
            transactionHash: parsed.transactionHash,
            diagnosticError: parsed.diagnosticError,
            error: parsed.diagnosticError,
            httpStatus: parsed.httpStatus,
            responseByteCount: parsed.responseByteCount,
            contentType: parsed.contentType,
          } satisfies TransactionStatusView,
        };
      } catch (error) {
        return { ok: false, error: mapCaughtError(error, config.apiKey) };
      }
    },

    async getTokenInfo(query) {
      return withClient(async (client, apiKey) => {
        const raw = await client.tokenization.info({ tokenSymbol: query.tokenSymbol });
        assertBoundedBrickkenResponse(raw);
        const parsed = tokenInfoAssetSchema.safeParse(raw);
        if (!parsed.success) return fail("INVALID_EXTERNAL_RESPONSE", apiKey);
        return {
          ok: true,
          value: {
            name: parsed.data.name ?? null,
            tokenName: parsed.data.tokenName ?? null,
            tokenSymbol: parsed.data.tokenSymbol,
            tokenType: parsed.data.tokenType ?? null,
            tokenizerEmail: parsed.data.tokenizerEmail ?? null,
            companyWalletAddress: parsed.data.companyWalletAddress ?? null,
            maxTokenSupply: parsed.data.maxTokenSupply ?? null,
            paymentChainId: parsed.data.paymentToken?.blockchain?.chainId ?? null,
          } satisfies TokenInfoView,
        };
      });
    },

    async getTokenizerInfo(query) {
      return withClient(async (client, apiKey) => {
        const raw = await client.tokenization.tokenizer({ tokenSymbol: query.tokenSymbol });
        assertBoundedBrickkenResponse(raw);
        const parsed = tokenizerInfoSchema.safeParse(raw);
        if (!parsed.success) return fail("INVALID_EXTERNAL_RESPONSE", apiKey);
        if (!/^0x[a-fA-F0-9]{40}$/.test(parsed.data.tokenAddress)) {
          return fail("INVALID_EXTERNAL_RESPONSE", apiKey);
        }
        if (parsed.data.tokenAddress === "0x0000000000000000000000000000000000000000") {
          return fail("INVALID_EXTERNAL_RESPONSE", apiKey);
        }
        return {
          ok: true,
          value: {
            companyWalletAddress: parsed.data.companyWalletAddress,
            tokenAddress: parsed.data.tokenAddress,
            paymentTokenAddress: parsed.data.paymentTokenAddress ?? null,
            chainId: String(parsed.data.chainId),
            email: parsed.data.email ?? null,
          } satisfies TokenizerInfoView,
        };
      });
    },

    async getWhitelistStatus(query) {
      return withClient(async (_client, apiKey) => {
        const url = new URL("/get-whitelist-status", SANDBOX_BASE_URL);
        url.searchParams.set("tokenSymbol", query.tokenSymbol);
        url.searchParams.set("address", query.address);
        const response = await injectedFetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-api-key": apiKey,
          },
        });
        const body: unknown = await response.json();
        assertBoundedBrickkenResponse(body);
        if (!response.ok) {
          return fail(
            response.status === 401 || response.status === 403
              ? "AUTHENTICATION_REJECTED"
              : "INVALID_EXTERNAL_RESPONSE",
            apiKey,
          );
        }
        const parsed = whitelistStatusSchema.safeParse(body);
        if (!parsed.success) return fail("INVALID_EXTERNAL_RESPONSE", apiKey);
        return {
          ok: true,
          value: {
            isWhitelisted: parsed.data.isWhitelisted,
            address: parsed.data.address,
            tokenSymbol: parsed.data.tokenSymbol,
            source: "blockchain",
          } satisfies WhitelistStatusView,
        };
      });
    },

    async getBalanceAndWhitelist(query) {
      return withClient(async (client, apiKey) => {
        const raw = await client.tokenization.balanceAndWhitelist({
          tokenSymbol: query.tokenSymbol,
          investorEmail: query.investorEmail,
        });
        assertBoundedBrickkenResponse(raw);
        const parsed = balanceWhitelistSchema.safeParse(raw);
        if (!parsed.success) return fail("INVALID_EXTERNAL_RESPONSE", apiKey);
        return {
          ok: true,
          value: {
            walletAddress: parsed.data.walletAddress,
            tokenAddress: parsed.data.tokenAddress,
            tokenDecimals: parsed.data.tokenDecimals,
            tokenBalanceRaw: parsed.data.tokenBalanceRaw,
            isWhitelisted: parsed.data.isWhitelisted,
            balanceSource: "blockchain",
          } satisfies BalanceWhitelistView,
        };
      });
    },

    async getNetworkInfo(query) {
      if (query.chainId !== SEPOLIA_CHAIN_ID) return fail("UNSUPPORTED_CHAIN");
      return withClient(async (client, apiKey) => {
        const raw = await client.network.info({ chainId: SEPOLIA_CHAIN_ID });
        assertBoundedBrickkenResponse(raw);
        const parsed = networkInfoSchema.safeParse(raw);
        if (!parsed.success) return fail("INVALID_EXTERNAL_RESPONSE", apiKey);
        let host: string | null = null;
        if (parsed.data.blockExplorerUrl) {
          try {
            host = new URL(parsed.data.blockExplorerUrl).host;
          } catch {
            host = null;
          }
        }
        return {
          ok: true,
          value: {
            currencyName: parsed.data.currencyName ?? null,
            blockExplorerHost: host,
          } satisfies NetworkInfoView,
        };
      });
    },
  };
}
