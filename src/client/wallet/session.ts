"use client";

import "client-only";

import { getAddress, isAddress } from "viem";
import {
  WALLET_BOUNDARY_LIMITS,
  WALLET_PROVIDER_DEADLINES_MS,
  type EdictEip1193Provider,
  type WalletReadiness,
  type WalletSource,
  type WalletTransactionRequestV1,
} from "@/shared/wallet";
import { WalletBoundaryError, providerErrorCode } from "./errors";

const SEPOLIA_HEX = "0xaa36a7";
const MAX_UINT256 = (1n << 256n) - 1n;

type ProviderRequest = EdictEip1193Provider["request"];
type ProviderListenerMethod = NonNullable<EdictEip1193Provider["on"]>;

export interface WalletProviderTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface SelectedWalletSessionOptions {
  readonly timers?: WalletProviderTimers;
  readonly deadlinesMs?: Partial<Record<keyof typeof WALLET_PROVIDER_DEADLINES_MS, number>>;
}

const defaultTimers: WalletProviderTimers = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function dataMethod(object: object, key: "request"): ProviderRequest;
function dataMethod(object: object, key: "on" | "removeListener"): ProviderListenerMethod | null;
function dataMethod(object: object, key: "request" | "on" | "removeListener") {
  try {
    let current: object | null = object;
    for (let depth = 0; current !== null && depth < 16; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          if (key === "request") throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
          return null;
        }
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch (error) {
    if (error instanceof WalletBoundaryError) throw error;
    throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
  }
  if (key === "request") throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
  return null;
}

function normalizeAddress(value: unknown): string | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value).toLowerCase() : null;
}

function normalizeChain(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > WALLET_BOUNDARY_LIMITS.chainResponseCodeUnits ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_UINT256 ? `0x${parsed.toString(16)}` : null;
  } catch {
    return null;
  }
}

export class SelectedWalletSession {
  readonly #provider: EdictEip1193Provider;
  readonly #requestReference: ProviderRequest;
  readonly #onReference: ProviderListenerMethod | null;
  readonly #removeListenerReference: ProviderListenerMethod | null;
  readonly #timers: WalletProviderTimers;
  readonly #deadlines: Readonly<Record<keyof typeof WALLET_PROVIDER_DEADLINES_MS, number>>;
  readonly #listeners = new Set<() => void>();
  readonly #providerListeners: Array<readonly [string, (...args: readonly unknown[]) => void]> = [];
  #generation = 0;
  #disposed = false;

  constructor(
    readonly selectionId: string,
    readonly source: WalletSource,
    provider: EdictEip1193Provider,
    options: SelectedWalletSessionOptions = {},
  ) {
    this.#provider = provider;
    this.#requestReference = dataMethod(provider, "request");
    this.#onReference = dataMethod(provider, "on");
    this.#removeListenerReference = dataMethod(provider, "removeListener");
    if ((this.#onReference === null) !== (this.#removeListenerReference === null)) {
      throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    }
    this.#timers = options.timers ?? defaultTimers;
    this.#deadlines = Object.freeze({ ...WALLET_PROVIDER_DEADLINES_MS, ...options.deadlinesMs });
    try {
      for (const event of ["connect", "disconnect", "accountsChanged", "chainChanged"] as const) {
        const listener = () => {
          this.#generation += 1;
          for (const notify of this.#listeners) notify();
        };
        this.#onReference?.call(provider, event, listener);
        if (this.#onReference) this.#providerListeners.push([event, listener]);
      }
    } catch {
      for (const [event, listener] of this.#providerListeners) {
        try {
          this.#removeListenerReference?.call(provider, event, listener);
        } catch {
          // A hostile provider can defeat cleanup in the same realm; selection is still refused.
        }
      }
      this.#providerListeners.length = 0;
      throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    }
  }

  get generation(): number {
    return this.#generation;
  }

  assertGeneration(expected: number): void {
    this.#assertAvailable();
    if (this.#generation !== expected) throw new WalletBoundaryError("ATTEMPT_INVALIDATED");
  }

  async inspect(requiredSigner: string): Promise<WalletReadiness> {
    this.#assertAvailable();
    const generation = this.#generation;
    const accountsRaw = await this.#request("eth_accounts");
    this.assertGeneration(generation);
    const chainRaw = await this.#request("eth_chainId");
    this.assertGeneration(generation);
    return this.#readiness(accountsRaw, chainRaw, requiredSigner, generation);
  }

  async requestAccountsFromUserAction(requiredSigner: string): Promise<WalletReadiness> {
    this.#assertAvailable();
    const generation = this.#generation;
    let accountsRaw: unknown;
    try {
      accountsRaw = await this.#invoke({ method: "eth_requestAccounts" }, this.#deadlines.accountAccess);
    } catch (error) {
      if (error instanceof WalletBoundaryError) throw error;
      const code = providerErrorCode(error);
      if (code === 4001) throw new WalletBoundaryError("ACCOUNT_AUTHORIZATION_REJECTED");
      if (code === 4100) throw new WalletBoundaryError("REQUIRED_ACCOUNT_UNAVAILABLE");
      if (code === 4200) throw new WalletBoundaryError("UNSUPPORTED_METHOD");
      if (code === 4900 || code === 4901) throw new WalletBoundaryError("WALLET_DISCONNECTED");
      throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    }
    this.assertGeneration(generation);
    const chainRaw = await this.#request("eth_chainId");
    this.assertGeneration(generation);
    return this.#readiness(accountsRaw, chainRaw, requiredSigner, generation);
  }

  async switchToSepoliaFromUserAction(requiredSigner: string): Promise<WalletReadiness> {
    this.#assertAvailable();
    const generation = this.#generation;
    try {
      await this.#invoke(
        { method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] },
        this.#deadlines.chainSwitch,
      );
    } catch (error) {
      if (error instanceof WalletBoundaryError) throw error;
      const code = providerErrorCode(error);
      if (code === 4001) throw new WalletBoundaryError("CHAIN_SWITCH_REJECTED");
      if (code === 4200) throw new WalletBoundaryError("CHAIN_SWITCH_UNSUPPORTED");
      if (code === 4900 || code === 4901) throw new WalletBoundaryError("WALLET_DISCONNECTED");
      throw new WalletBoundaryError("CHAIN_SWITCH_UNSUPPORTED");
    }
    this.assertGeneration(generation);
    return this.inspect(requiredSigner);
  }

  async requestExplicit(method: "eth_signTypedData_v4", params: readonly unknown[]) {
    this.#assertAvailable();
    return this.#invoke({ method, params }, this.#deadlines.typedDataSignature);
  }

  async sendTransactionOnce(input: {
    readonly expectedGeneration: number;
    readonly requiredSigner: string;
    readonly walletRequest: WalletTransactionRequestV1;
  }): Promise<unknown> {
    this.assertGeneration(input.expectedGeneration);
    const chainRaw = await this.#request("eth_chainId");
    this.assertGeneration(input.expectedGeneration);
    const accountsRaw = await this.#request("eth_accounts");
    this.assertGeneration(input.expectedGeneration);
    const readiness = this.#readiness(
      accountsRaw,
      chainRaw,
      input.requiredSigner,
      input.expectedGeneration,
    );
    if (readiness.state === "WRONG_CHAIN") throw new WalletBoundaryError("WRONG_CHAIN");
    if (readiness.state !== "READY") {
      throw new WalletBoundaryError("REQUIRED_ACCOUNT_UNAVAILABLE");
    }
    this.assertGeneration(input.expectedGeneration);
    return this.#invoke(
      { method: "eth_sendTransaction", params: [input.walletRequest] },
      this.#deadlines.sendTransaction,
      input.expectedGeneration,
    );
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [event, listener] of this.#providerListeners) {
      try {
        this.#removeListenerReference?.call(this.#provider, event, listener);
      } catch {
        // Disposal does not expose provider failures.
      }
    }
    this.#providerListeners.length = 0;
    this.#listeners.clear();
  }

  #assertAvailable(): void {
    if (this.#disposed) {
      throw new WalletBoundaryError("SELECTED_PROVIDER_DISAPPEARED");
    }
    try {
      if (
        dataMethod(this.#provider, "request") !== this.#requestReference ||
        dataMethod(this.#provider, "on") !== this.#onReference ||
        dataMethod(this.#provider, "removeListener") !== this.#removeListenerReference
      ) throw new Error("provider mutated");
    } catch {
      throw new WalletBoundaryError("SELECTED_PROVIDER_DISAPPEARED");
    }
  }

  async #request(method: "eth_accounts" | "eth_chainId"): Promise<unknown> {
    try {
      return await this.#invoke({ method }, this.#deadlines.passiveRead);
    } catch (error) {
      if (error instanceof WalletBoundaryError) throw error;
      const code = providerErrorCode(error);
      if (code === 4100) throw new WalletBoundaryError("REQUIRED_ACCOUNT_UNAVAILABLE");
      if (code === 4200) throw new WalletBoundaryError("UNSUPPORTED_METHOD");
      if (code === 4900 || code === 4901) throw new WalletBoundaryError("WALLET_DISCONNECTED");
      throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    }
  }

  async #invoke(
    input: { readonly method: string; readonly params?: readonly unknown[] | Record<string, unknown> },
    deadlineMs: number,
    expectedGeneration?: number,
  ): Promise<unknown> {
    this.#assertAvailable();
    let timer: unknown;
    let expired = false;
    const providerPromise = Promise.resolve().then(() => {
      if (expectedGeneration !== undefined) this.assertGeneration(expectedGeneration);
      return this.#requestReference.call(this.#provider, input);
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = this.#timers.setTimeout(() => {
        expired = true;
        reject(new WalletBoundaryError("ATTEMPT_INVALIDATED"));
      }, deadlineMs);
    });
    try {
      const result = await Promise.race([providerPromise, timeoutPromise]);
      if (expired) throw new WalletBoundaryError("ATTEMPT_INVALIDATED");
      return result;
    } finally {
      if (timer !== undefined) this.#timers.clearTimeout(timer);
      void providerPromise.catch(() => undefined);
    }
  }

  #readiness(
    accountsRaw: unknown,
    chainRaw: unknown,
    requiredSignerRaw: string,
    generation: number,
  ): WalletReadiness {
    const requiredSigner = normalizeAddress(requiredSignerRaw);
    if (
      requiredSigner === null ||
      !Array.isArray(accountsRaw) ||
      accountsRaw.length > WALLET_BOUNDARY_LIMITS.accountCount
    ) {
      throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    }
    const accounts = accountsRaw.map(normalizeAddress);
    if (accounts.some((account) => account === null)) {
      throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    }
    const normalizedAccounts = accounts as string[];
    const chainId = normalizeChain(chainRaw);
    const state =
      normalizedAccounts.length === 0
        ? "UNAUTHORIZED"
        : !normalizedAccounts.includes(requiredSigner)
          ? "REQUIRED_ACCOUNT_UNAVAILABLE"
          : chainId !== SEPOLIA_HEX
            ? "WRONG_CHAIN"
            : "READY";
    return Object.freeze({
      state,
      accounts: Object.freeze([...normalizedAccounts]),
      chainId,
      requiredSigner,
      generation,
    });
  }
}

export function isEdictProvider(value: unknown): value is EdictEip1193Provider {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  try {
    dataMethod(value as object, "request");
    const on = dataMethod(value as object, "on");
    const remove = dataMethod(value as object, "removeListener");
    return (on === null) === (remove === null);
  } catch {
    return false;
  }
}
