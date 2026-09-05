import "server-only";

import { z } from "zod";
import { hashCanonicalJson } from "../../src/core/hashing";
import { assertBoundedWalletValue } from "../../src/shared/wallet/bounds";
import {
  createBrickkenServerAdapter,
  type AdapterDependencies,
} from "../../src/server/brickken/adapter";
import {
  SANDBOX_BASE_URL,
  SEPOLIA_CHAIN_ID,
} from "../../src/server/brickken/config";
import type { BrickkenServerAdapter } from "../../src/server/brickken/types";
import {
  BRICKKEN_READ_LIMITATIONS,
  BRICKKEN_READ_REDACTIONS,
  type Phase8ActionEvidenceV1,
} from "./evidence";
import type { Phase8ActionContext, Phase8ActionExecutor } from "./types";

export const BRICKKEN_READ_ADAPTER_VERSION = "1.0";
export const BRICKKEN_READ_SDK_VERSION = "0.2.1";

export type BrickkenReadFailureCode =
  | "BRICKKEN_NETWORK_READ_FAILED"
  | "BRICKKEN_NETWORK_RESPONSE_INVALID"
  | "BRICKKEN_NETWORK_CHAIN_MISMATCH";

export class BrickkenReadExecutorError extends Error {
  readonly code: BrickkenReadFailureCode;

  constructor(code: BrickkenReadFailureCode) {
    super(code);
    this.name = "BrickkenReadExecutorError";
    this.code = code;
  }
}

type AdapterFactory = (dependencies: AdapterDependencies) => BrickkenServerAdapter;

export interface BrickkenReadExecutorDependencies {
  readonly adapterFactory?: AdapterFactory;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const normalizedNetworkResultSchema = z.strictObject({
  ok: z.literal(true),
  value: z.strictObject({
    currencyName: z.string().max(128).nullable(),
    blockExplorerHost: z.string().max(255).nullable(),
  }),
});

function refuse(code: BrickkenReadFailureCode): never {
  throw new BrickkenReadExecutorError(code);
}

function inspectContext(context: Phase8ActionContext): string {
  try {
    assertBoundedWalletValue(context, {
      maxCodeUnits: 16_384,
      maxArrayLength: 8,
      maxProperties: 8,
    });
    if (
      context.target.action !== "BRICKKEN_READ" ||
      context.target.walletRequestHash !== null ||
      Object.keys(context.allowedEnvironment).length !== 1 ||
      !Object.hasOwn(context.allowedEnvironment, "BRICKKEN_API_KEY")
    ) {
      return refuse("BRICKKEN_NETWORK_READ_FAILED");
    }
    const apiKey = context.allowedEnvironment.BRICKKEN_API_KEY;
    if (
      typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > 8_192 ||
      apiKey.trim() !== apiKey
    ) {
      return refuse("BRICKKEN_NETWORK_READ_FAILED");
    }
    return apiKey;
  } catch (error) {
    if (error instanceof BrickkenReadExecutorError) throw error;
    return refuse("BRICKKEN_NETWORK_READ_FAILED");
  }
}

function parseNetworkResult(raw: unknown): z.infer<typeof normalizedNetworkResultSchema> {
  const okDescriptor = raw !== null && typeof raw === "object"
    ? Object.getOwnPropertyDescriptor(raw, "ok")
    : undefined;
  if (!okDescriptor || !("value" in okDescriptor)) {
    return refuse("BRICKKEN_NETWORK_RESPONSE_INVALID");
  }
  if (okDescriptor.value !== true) return refuse("BRICKKEN_NETWORK_READ_FAILED");
  try {
    assertBoundedWalletValue(raw, {
      maxCodeUnits: 4_096,
      maxArrayLength: 8,
      maxProperties: 8,
    });
    return normalizedNetworkResultSchema.parse(raw);
  } catch {
    return refuse("BRICKKEN_NETWORK_RESPONSE_INVALID");
  }
}

export function createBrickkenReadExecutor(
  dependencies: BrickkenReadExecutorDependencies = {},
): Phase8ActionExecutor {
  return Object.freeze({
    async execute(context: Phase8ActionContext): Promise<Phase8ActionEvidenceV1> {
      const apiKey = inspectContext(context);
      const adapterFactory = dependencies.adapterFactory ?? createBrickkenServerAdapter;
      const adapter = adapterFactory({
        runtimeConfig: Object.freeze({
          apiKey,
          baseUrl: SANDBOX_BASE_URL,
          chainId: SEPOLIA_CHAIN_ID,
        }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });

      let rawResult: unknown;
      try {
        rawResult = await adapter.getNetworkInfo({ chainId: "11155111" });
      } catch {
        return refuse("BRICKKEN_NETWORK_READ_FAILED");
      }
      const result = parseNetworkResult(rawResult);
      if (
        result.value.currencyName !== "Sepolia ETH" ||
        result.value.blockExplorerHost !== "sepolia.etherscan.io"
      ) {
        return refuse("BRICKKEN_NETWORK_CHAIN_MISMATCH");
      }

      const details = Object.freeze({
        checkKind: "BRICKKEN_SANDBOX_NETWORK_INFO" as const,
        checkVersion: "1.0" as const,
        environment: "sandbox" as const,
        requestedChainId: "11155111" as const,
        currencyName: "Sepolia ETH" as const,
        blockExplorerHost: "sepolia.etherscan.io" as const,
        authenticatedNetworkRead: true as const,
        resultCategory: "BRICKKEN_NETWORK_READ_PASSED" as const,
        adapterVersion: BRICKKEN_READ_ADAPTER_VERSION,
        sdkVersion: BRICKKEN_READ_SDK_VERSION,
      });
      const fingerprint = await hashCanonicalJson(details);
      const observedAt = (dependencies.now?.() ?? new Date()).toISOString();

      const evidence: Phase8ActionEvidenceV1 = {
        evidenceVersion: "1.0",
        harnessVersion: "1.0",
        observedAt,
        action: "BRICKKEN_READ",
        runId: context.target.runId,
        operation: context.target.operation,
        walletRequestHash: null,
        evidenceStatus: "PASSED",
        resultFingerprint: fingerprint.hash,
        details,
        limitations: [BRICKKEN_READ_LIMITATIONS[0], BRICKKEN_READ_LIMITATIONS[1]],
        redactions: [
          BRICKKEN_READ_REDACTIONS[0],
          BRICKKEN_READ_REDACTIONS[1],
          BRICKKEN_READ_REDACTIONS[2],
          BRICKKEN_READ_REDACTIONS[3],
          BRICKKEN_READ_REDACTIONS[4],
          BRICKKEN_READ_REDACTIONS[5],
          BRICKKEN_READ_REDACTIONS[6],
          BRICKKEN_READ_REDACTIONS[7],
          BRICKKEN_READ_REDACTIONS[8],
          BRICKKEN_READ_REDACTIONS[9],
          BRICKKEN_READ_REDACTIONS[10],
          BRICKKEN_READ_REDACTIONS[11],
        ],
      };
      return Object.freeze(evidence);
    },
  });
}
