"use client";

import "client-only";

import type { DiscoveredWallet } from "@/shared/wallet";
import { InjectedWalletDiscovery } from "./discovery";
import { WalletBoundaryError } from "./errors";
import { SelectedWalletSession } from "./session";

export const PREFERRED_WALLET_STORAGE_KEY = "edict.preferred_wallet_rdns";
const SEPOLIA_HEX = "0xaa36a7";

export type GlobalWalletStatus =
  | "DISCONNECTED"
  | "DISCOVERING"
  | "CONNECTING"
  | "CONNECTED";

export interface GlobalWalletSessionState {
  readonly status: GlobalWalletStatus;
  readonly providers: readonly DiscoveredWallet[];
  readonly selectedProvider: DiscoveredWallet | null;
  readonly session: SelectedWalletSession | null;
  readonly accounts: readonly string[];
  readonly address: string | null;
  readonly chainId: string | null;
  readonly isSepolia: boolean;
  readonly isSelectorOpen: boolean;
  readonly errorMessage: string | null;
}

export interface GlobalWalletSessionControllerOptions {
  readonly events: EventTarget;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly discovery?: InjectedWalletDiscovery;
  readonly readLegacyProvider?: () => unknown;
}

export class GlobalWalletSessionController {
  readonly #discovery: InjectedWalletDiscovery;
  readonly #storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly #listeners = new Set<() => void>();
  #unsubscribeDiscovery: (() => void) | null = null;
  #unsubscribeSession: (() => void) | null = null;
  #session: SelectedWalletSession | null = null;
  #selectedProvider: DiscoveredWallet | null = null;
  #status: GlobalWalletStatus = "DISCONNECTED";
  #accounts: readonly string[] = Object.freeze([]);
  #chainId: string | null = null;
  #isSelectorOpen = false;
  #errorMessage: string | null = null;
  #started = false;
  #disposed = false;
  #passiveCheckInProgress = false;

  constructor(options: GlobalWalletSessionControllerOptions) {
    this.#storage = options.storage;
    this.#discovery =
      options.discovery ??
      new InjectedWalletDiscovery({
        events: options.events,
        readLegacyProvider: options.readLegacyProvider,
      });
  }

  getState(): GlobalWalletSessionState {
    const address = this.#accounts[0] ?? null;
    return Object.freeze({
      status: this.#status,
      providers: this.#discovery.list(),
      selectedProvider: this.#selectedProvider,
      session: this.#session,
      accounts: this.#accounts,
      address,
      chainId: this.#chainId,
      isSepolia: this.#chainId === SEPOLIA_HEX,
      isSelectorOpen: this.#isSelectorOpen,
      errorMessage: this.#errorMessage,
    });
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#unsubscribeDiscovery = this.#discovery.subscribe(this.#onDiscoveryUpdate);
    this.#discovery.start();
    this.#onDiscoveryUpdate();
  }

  openSelector(): void {
    this.#errorMessage = null;
    this.#isSelectorOpen = true;
    this.#notify();
  }

  closeSelector(): void {
    this.#isSelectorOpen = false;
    this.#errorMessage = null;
    this.#notify();
  }

  async connect(selectionIdOrRdns: string): Promise<void> {
    if (this.#disposed) return;
    const list = this.#discovery.list();
    const match = list.find(
      (p) => (p.selectionId === selectionIdOrRdns || p.rdns === selectionIdOrRdns) && p.status === "AVAILABLE",
    );
    if (!match) {
      this.#errorMessage = "The selected wallet is no longer available.";
      this.#notify();
      return;
    }
    this.#status = "CONNECTING";
    this.#errorMessage = null;
    this.#notify();

    let newSession: SelectedWalletSession | null = null;
    try {
      newSession = this.#discovery.selectFromUserAction(match.selectionId);
      const { accounts, chainId } = await newSession.requestAccountsGlobally();
      if (this.#disposed) {
        newSession.dispose();
        return;
      }
      if (accounts.length === 0) {
        newSession.dispose();
        this.#status = "DISCONNECTED";
        this.#errorMessage = "No authorized account was returned by the wallet.";
        this.#notify();
        return;
      }
      this.#attachSession(newSession, match, accounts, chainId);
      try {
        this.#storage?.setItem(PREFERRED_WALLET_STORAGE_KEY, match.rdns ?? match.selectionId);
      } catch {
        // Ignore storage errors.
      }
      this.#isSelectorOpen = false;
      this.#notify();
    } catch (error) {
      newSession?.dispose();
      this.#status = "DISCONNECTED";
      if (error instanceof WalletBoundaryError && error.code === "ACCOUNT_AUTHORIZATION_REJECTED") {
        this.#errorMessage = "Account connection was rejected in your wallet.";
      } else {
        this.#errorMessage = "Failed to connect wallet.";
      }
      this.#notify();
    }
  }

  async connectLegacy(): Promise<void> {
    if (this.#disposed) return;
    this.#status = "CONNECTING";
    this.#errorMessage = null;
    this.#notify();

    let newSession: SelectedWalletSession | null = null;
    try {
      newSession = this.#discovery.selectLegacyProviderFromUserAction();
      const { accounts, chainId } = await newSession.requestAccountsGlobally();
      if (this.#disposed) {
        newSession.dispose();
        return;
      }
      if (accounts.length === 0) {
        newSession.dispose();
        this.#status = "DISCONNECTED";
        this.#errorMessage = "No authorized account was returned by the legacy wallet.";
        this.#notify();
        return;
      }
      const legacyView: DiscoveredWallet = Object.freeze({
        selectionId: newSession.selectionId,
        source: "LEGACY",
        displayName: "Injected Wallet",
        rdns: null,
        iconDataUri: null,
        metadataTrusted: false,
        status: "AVAILABLE",
        capability: "STRUCTURALLY_ELIGIBLE",
      });
      this.#attachSession(newSession, legacyView, accounts, chainId);
      try {
        this.#storage?.setItem(PREFERRED_WALLET_STORAGE_KEY, "legacy");
      } catch {
        // Ignore storage errors.
      }
      this.#isSelectorOpen = false;
      this.#notify();
    } catch (error) {
      newSession?.dispose();
      this.#status = "DISCONNECTED";
      if (error instanceof WalletBoundaryError && error.code === "ACCOUNT_AUTHORIZATION_REJECTED") {
        this.#errorMessage = "Account connection was rejected in your wallet.";
      } else {
        this.#errorMessage = "Failed to connect legacy wallet.";
      }
      this.#notify();
    }
  }

  disconnect(): void {
    this.#clearSession();
    try {
      this.#storage?.removeItem(PREFERRED_WALLET_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
    this.#status = "DISCONNECTED";
    this.#notify();
  }

  async switchChain(): Promise<void> {
    const session = this.#session;
    if (!session || this.#disposed) return;
    try {
      const nextChain = await session.switchChainToSepolia();
      this.#chainId = nextChain;
      this.#notify();
    } catch (error) {
      if (error instanceof WalletBoundaryError && error.code === "CHAIN_SWITCH_REJECTED") {
        this.#errorMessage = "Network switch was rejected in your wallet.";
      } else {
        this.#errorMessage = "Failed to switch network. Please switch to Ethereum Sepolia in your wallet.";
      }
      this.#notify();
    }
  }

  async refreshSession(): Promise<void> {
    const session = this.#session;
    if (!session || this.#disposed) return;
    try {
      const snapshot = await session.getPassiveSnapshot();
      if (snapshot.accounts.length === 0) {
        this.#clearSession();
        this.#status = "DISCONNECTED";
      } else {
        this.#accounts = snapshot.accounts;
        this.#chainId = snapshot.chainId;
      }
      this.#notify();
    } catch {
      this.#clearSession();
      this.#status = "DISCONNECTED";
      this.#notify();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeDiscovery?.();
    this.#unsubscribeDiscovery = null;
    this.#clearSession();
    this.#discovery.dispose();
    this.#listeners.clear();
  }

  #clearSession(): void {
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = null;
    this.#session?.dispose();
    this.#session = null;
    this.#selectedProvider = null;
    this.#accounts = Object.freeze([]);
    this.#chainId = null;
  }

  #attachSession(
    session: SelectedWalletSession,
    provider: DiscoveredWallet,
    accounts: readonly string[],
    chainId: string | null,
  ): void {
    this.#clearSession();
    this.#session = session;
    this.#selectedProvider = provider;
    this.#accounts = Object.freeze([...accounts]);
    this.#chainId = chainId;
    this.#status = "CONNECTED";
    this.#errorMessage = null;

    const onSessionEvent = () => {
      void (async () => {
        if (this.#session !== session || this.#disposed) return;
        try {
          const snapshot = await session.getPassiveSnapshot();
          if (this.#session !== session || this.#disposed) return;
          if (snapshot.accounts.length === 0) {
            this.#clearSession();
            this.#status = "DISCONNECTED";
            this.#notify();
          } else {
            this.#accounts = snapshot.accounts;
            this.#chainId = snapshot.chainId;
            this.#notify();
          }
        } catch {
          if (this.#session === session && !this.#disposed) {
            this.#clearSession();
            this.#status = "DISCONNECTED";
            this.#notify();
          }
        }
      })();
    };

    this.#unsubscribeSession = session.subscribe(onSessionEvent);
  }

  readonly #onDiscoveryUpdate = (): void => {
    if (this.#disposed) return;
    const list = this.#discovery.list();

    // Invalidate active session if provider is now colliding or missing
    if (this.#session && this.#selectedProvider) {
      const current = list.find((p) => p.selectionId === this.#selectedProvider?.selectionId);
      if (this.#selectedProvider.source === "EIP6963" && (!current || current.status !== "AVAILABLE")) {
        this.#clearSession();
        this.#status = "DISCONNECTED";
        this.#notify();
        return;
      }
    }

    // Passive restore on initial discovery if preferred provider is saved
    if (!this.#session && !this.#passiveCheckInProgress) {
      let preferredKey: string | null = null;
      try {
        preferredKey = this.#storage?.getItem(PREFERRED_WALLET_STORAGE_KEY) ?? null;
      } catch {
        preferredKey = null;
      }

      if (preferredKey) {
        const match = list.find(
          (p) => (p.rdns === preferredKey || p.selectionId === preferredKey) && p.status === "AVAILABLE",
        );
        if (match) {
          this.#passiveCheckInProgress = true;
          void (async () => {
            let candidateSession: SelectedWalletSession | null = null;
            try {
              candidateSession = this.#discovery.selectFromUserAction(match.selectionId);
              const snapshot = await candidateSession.getPassiveSnapshot();
              if (this.#disposed) {
                candidateSession.dispose();
                return;
              }
              if (snapshot.accounts.length > 0) {
                this.#attachSession(candidateSession, match, snapshot.accounts, snapshot.chainId);
                this.#notify();
              } else {
                candidateSession.dispose();
                // Retain DISCONNECTED state. Never fall back to another provider!
              }
            } catch {
              candidateSession?.dispose();
            } finally {
              this.#passiveCheckInProgress = false;
            }
          })();
        } else if (preferredKey === "legacy") {
          this.#passiveCheckInProgress = true;
          void (async () => {
            let candidateSession: SelectedWalletSession | null = null;
            try {
              candidateSession = this.#discovery.selectLegacyProviderFromUserAction();
              const snapshot = await candidateSession.getPassiveSnapshot();
              if (this.#disposed) {
                candidateSession.dispose();
                return;
              }
              if (snapshot.accounts.length > 0) {
                const legacyView: DiscoveredWallet = Object.freeze({
                  selectionId: candidateSession.selectionId,
                  source: "LEGACY",
                  displayName: "Injected Wallet",
                  rdns: null,
                  iconDataUri: null,
                  metadataTrusted: false,
                  status: "AVAILABLE",
                  capability: "STRUCTURALLY_ELIGIBLE",
                });
                this.#attachSession(candidateSession, legacyView, snapshot.accounts, snapshot.chainId);
                this.#notify();
              } else {
                candidateSession.dispose();
              }
            } catch {
              candidateSession?.dispose();
            } finally {
              this.#passiveCheckInProgress = false;
            }
          })();
        }
      }
    }

    this.#notify();
  };

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
