"use client";

import "client-only";

import { getAddress, isAddress } from "viem";
import type { EdictEip1193Provider, WalletReadiness, WalletSource } from "@/shared/wallet";
import { WalletBoundaryError, providerErrorCode } from "./errors";

const SEPOLIA_HEX = "0xaa36a7";

function normalizeAddress(value: unknown): string | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value).toLowerCase() : null;
}

function normalizeChain(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    return null;
  }
}

export class SelectedWalletSession {
  readonly #provider: EdictEip1193Provider;
  readonly #requestReference: EdictEip1193Provider["request"];
  readonly #listeners = new Set<() => void>();
  readonly #providerListeners: Array<readonly [string, (...args: readonly unknown[]) => void]> = [];
  #generation = 0;
  #disposed = false;

  constructor(
    readonly selectionId: string,
    readonly source: WalletSource,
    provider: EdictEip1193Provider,
  ) {
    this.#provider = provider;
    this.#requestReference = provider.request;
    for (const event of ["connect", "disconnect", "accountsChanged", "chainChanged"] as const) {
      const listener = () => {
        this.#generation += 1;
        for (const notify of this.#listeners) notify();
      };
      provider.on?.(event, listener);
      this.#providerListeners.push([event, listener]);
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
    const accountsRaw = await this.#request("eth_accounts");
    const chainRaw = await this.#request("eth_chainId");
    return this.#readiness(accountsRaw, chainRaw, requiredSigner);
  }

  async requestAccountsFromUserAction(requiredSigner: string): Promise<WalletReadiness> {
    this.#assertAvailable();
    let accountsRaw: unknown;
    try {
      accountsRaw = await this.#provider.request({ method: "eth_requestAccounts" });
    } catch (error) {
      const code = providerErrorCode(error);
      if (code === 4001) throw new WalletBoundaryError("ACCOUNT_AUTHORIZATION_REJECTED");
      if (code === 4100) throw new WalletBoundaryError("REQUIRED_ACCOUNT_UNAVAILABLE");
      if (code === 4200) throw new WalletBoundaryError("UNSUPPORTED_METHOD");
      if (code === 4900 || code === 4901) throw new WalletBoundaryError("WALLET_DISCONNECTED");
      throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    }
    const chainRaw = await this.#request("eth_chainId");
    return this.#readiness(accountsRaw, chainRaw, requiredSigner);
  }

  async switchToSepoliaFromUserAction(requiredSigner: string): Promise<WalletReadiness> {
    this.#assertAvailable();
    try {
      await this.#provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_HEX }],
      });
    } catch (error) {
      const code = providerErrorCode(error);
      if (code === 4001) throw new WalletBoundaryError("CHAIN_SWITCH_REJECTED");
      if (code === 4200) throw new WalletBoundaryError("CHAIN_SWITCH_UNSUPPORTED");
      if (code === 4900 || code === 4901) throw new WalletBoundaryError("WALLET_DISCONNECTED");
      throw new WalletBoundaryError("CHAIN_SWITCH_UNSUPPORTED");
    }
    return this.inspect(requiredSigner);
  }

  async requestExplicit(method: "eth_signTypedData_v4" | "eth_sendTransaction", params: readonly unknown[]) {
    this.#assertAvailable();
    return this.#provider.request({ method, params });
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [event, listener] of this.#providerListeners) {
      this.#provider.removeListener?.(event, listener);
    }
    this.#listeners.clear();
  }

  #assertAvailable(): void {
    if (
      this.#disposed ||
      this.#provider.request !== this.#requestReference ||
      typeof this.#provider.request !== "function"
    ) {
      throw new WalletBoundaryError("SELECTED_PROVIDER_DISAPPEARED");
    }
  }

  async #request(method: "eth_accounts" | "eth_chainId"): Promise<unknown> {
    try {
      return await this.#provider.request({ method });
    } catch (error) {
      const code = providerErrorCode(error);
      if (code === 4100) throw new WalletBoundaryError("REQUIRED_ACCOUNT_UNAVAILABLE");
      if (code === 4200) throw new WalletBoundaryError("UNSUPPORTED_METHOD");
      if (code === 4900 || code === 4901) throw new WalletBoundaryError("WALLET_DISCONNECTED");
      throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    }
  }

  #readiness(accountsRaw: unknown, chainRaw: unknown, requiredSignerRaw: string): WalletReadiness {
    const requiredSigner = normalizeAddress(requiredSignerRaw);
    if (requiredSigner === null || !Array.isArray(accountsRaw)) {
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
      generation: this.#generation,
    });
  }
}

export function isEdictProvider(value: unknown): value is EdictEip1193Provider {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  try {
    return typeof (value as { request?: unknown }).request === "function";
  } catch {
    return false;
  }
}
