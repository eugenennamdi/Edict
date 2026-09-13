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
import { createBrickkenReadTransport } from "./brickken-read-transport";
import {
  brickkenReadFingerprintProjection,
  type Phase8ActionEvidenceV1,
} from "./evidence";
import type { Phase8ActionContext, Phase8ActionExecutor } from "./types";

import { BRICKKEN_READ_DETAILS, brickkenReadEvidence } from "./public-output";

export const BRICKKEN_READ_ADAPTER_VERSION = BRICKKEN_READ_DETAILS.adapterVersion;
export const BRICKKEN_READ_SDK_VERSION = BRICKKEN_READ_DETAILS.sdkVersion;
export const BRICKKEN_READ_DEADLINE_MS = 15_000;

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
  readonly deadlineMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly allowEmptyResponseUrl?: boolean;
}

const normalizedNetworkResultSchema = z.strictObject({
  ok: z.literal(true),
  value: z.strictObject({
    currencyName: z.string().max(128).nullable(),
    blockExplorerHost: z.string().max(255).nullable(),
    factoryAddress: z.string().regex(/^0x[0-9a-f]{40}$/).nullable().optional(),
  }),
});

function refuse(code: BrickkenReadFailureCode): never {
  throw new BrickkenReadExecutorError(code);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function inspectContext(context: Phase8ActionContext): {
  readonly apiKey: string;
  readonly target: Phase8ActionContext["target"];
  readonly signal: AbortSignal | undefined;
} {
  try {
    const targetDescriptor = Object.getOwnPropertyDescriptor(context, "target");
    const environmentDescriptor = Object.getOwnPropertyDescriptor(context, "allowedEnvironment");
    const signalDescriptor = Object.getOwnPropertyDescriptor(context, "signal");
    if (
      !targetDescriptor || !("value" in targetDescriptor) ||
      !environmentDescriptor || !("value" in environmentDescriptor) ||
      (signalDescriptor !== undefined && !("value" in signalDescriptor))
    ) {
      return refuse("BRICKKEN_NETWORK_READ_FAILED");
    }
    const target = targetDescriptor.value as Phase8ActionContext["target"];
    const allowedEnvironment = environmentDescriptor.value as Phase8ActionContext["allowedEnvironment"];
    const signal = signalDescriptor?.value as AbortSignal | undefined;
    assertBoundedWalletValue(target, {
      maxCodeUnits: 16_384,
      maxArrayLength: 8,
      maxProperties: 8,
    });
    assertBoundedWalletValue(allowedEnvironment, {
      maxCodeUnits: 16_384,
      maxArrayLength: 8,
      maxProperties: 8,
    });
    if (
      target.action !== "BRICKKEN_READ" ||
      target.walletRequestHash !== null ||
      Object.keys(allowedEnvironment).length !== 1 ||
      !Object.hasOwn(allowedEnvironment, "BRICKKEN_API_KEY") ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) {
      return refuse("BRICKKEN_NETWORK_READ_FAILED");
    }
    const apiKey = allowedEnvironment.BRICKKEN_API_KEY;
    if (
      typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > 8_192 ||
      apiKey.trim() !== apiKey || !/^[\x21-\x7e]+$/.test(apiKey)
    ) {
      return refuse("BRICKKEN_NETWORK_READ_FAILED");
    }
    return { apiKey, target, signal };
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
      const inspected = inspectContext(context);
      const { apiKey } = inspected;
      const deadlineMs = dependencies.deadlineMs ?? BRICKKEN_READ_DEADLINE_MS;
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
        return refuse("BRICKKEN_NETWORK_READ_FAILED");
      }
      const deadlineAbort = new AbortController();
      const executionSignal = inspected.signal === undefined
        ? deadlineAbort.signal
        : AbortSignal.any([inspected.signal, deadlineAbort.signal]);
      const underlyingFetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
      const transport = createBrickkenReadTransport({
        fetch: underlyingFetch,
        apiKey,
        signal: executionSignal,
        allowEmptyResponseUrl: dependencies.allowEmptyResponseUrl ?? dependencies.fetch !== undefined,
      });
      const adapterFactory = dependencies.adapterFactory ?? createBrickkenServerAdapter;
      const adapter = adapterFactory({
        runtimeConfig: Object.freeze({
          apiKey,
          baseUrl: SANDBOX_BASE_URL,
          chainId: SEPOLIA_CHAIN_ID,
        }),
        fetch: transport,
      });

      let rawResult: unknown;
      const setTimer = dependencies.setTimeout ?? globalThis.setTimeout;
      const clearTimer = dependencies.clearTimeout ?? globalThis.clearTimeout;
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new BrickkenReadExecutorError("BRICKKEN_NETWORK_READ_FAILED"));
        if (executionSignal.aborted) abortListener();
        else executionSignal.addEventListener("abort", abortListener, { once: true });
      });
      const timer = setTimer(() => deadlineAbort.abort(), deadlineMs);
      try {
        const operation = adapter.getNetworkInfo({ chainId: "11155111" });
        rawResult = await Promise.race([operation, aborted]);
      } catch {
        return refuse("BRICKKEN_NETWORK_READ_FAILED");
      } finally {
        clearTimer(timer);
        if (abortListener) executionSignal.removeEventListener("abort", abortListener);
      }
      const result = parseNetworkResult(rawResult);
      if (
        result.value.currencyName !== "Sepolia ETH" ||
        result.value.blockExplorerHost !== "sepolia.etherscan.io"
      ) {
        return refuse("BRICKKEN_NETWORK_CHAIN_MISMATCH");
      }

      const details = BRICKKEN_READ_DETAILS;
      const fingerprint = await hashCanonicalJson(brickkenReadFingerprintProjection(details));
      const observedAt = (dependencies.now?.() ?? new Date()).toISOString();

      const evidence = brickkenReadEvidence({
        observedAt, runId: inspected.target.runId, operation: inspected.target.operation,
        resultFingerprint: fingerprint.hash,
      });
      return deepFreeze(evidence);
    },
  });
}
