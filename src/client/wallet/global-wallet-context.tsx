"use client";

import "client-only";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useAccount, useChainId, useDisconnect, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { sepolia } from "wagmi/chains";
import { createEdictWalletSession } from "./adapter";
import { WalletBoundaryError } from "./errors";
import type { SelectedWalletSession } from "./session";

export interface GlobalWalletContextValue {
  readonly isConnected: boolean;
  readonly address: string | null;
  readonly chainId: string | null;
  readonly isSepolia: boolean;
  readonly status: "connected" | "disconnected" | "connecting" | "reconnecting";
  readonly connectorId: string | null;
  readonly connectorName: string | null;
  readonly getWalletSession: () => Promise<SelectedWalletSession>;
  readonly switchChain: () => Promise<void>;
  readonly disconnect: () => void;
  readonly openConnectModal: () => void;
}

const GlobalWalletContext = createContext<GlobalWalletContextValue | null>(null);

export function GlobalWalletProvider({ children }: { readonly children: ReactNode }) {
  const { address, connector, isConnected, status } = useAccount();
  const currentChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const connectModal = useConnectModal();

  const sessionRef = useRef<{
    connectorId: string;
    provider: unknown;
    session: SelectedWalletSession;
  } | null>(null);

  useEffect(() => {
    if (!isConnected && sessionRef.current) {
      sessionRef.current.session.dispose();
      sessionRef.current = null;
    }
  }, [isConnected]);

  const normalizedAddress = useMemo(() => {
    return address ? address.toLowerCase() : null;
  }, [address]);

  const normalizedChainId = useMemo(() => {
    if (typeof currentChainId !== "number") return null;
    return `0x${currentChainId.toString(16)}`;
  }, [currentChainId]);

  const isSepolia = currentChainId === sepolia.id;

  const getWalletSession = useCallback(async (): Promise<SelectedWalletSession> => {
    if (!connector || !isConnected) {
      throw new WalletBoundaryError("WALLET_DISCONNECTED");
    }
    const rawProvider = await connector.getProvider();
    if (
      !sessionRef.current ||
      sessionRef.current.provider !== rawProvider ||
      sessionRef.current.connectorId !== connector.id
    ) {
      if (sessionRef.current) {
        sessionRef.current.session.dispose();
      }
      const session = createEdictWalletSession(connector.id, rawProvider);
      sessionRef.current = {
        connectorId: connector.id,
        provider: rawProvider,
        session,
      };
    }
    return sessionRef.current.session;
  }, [connector, isConnected]);

  const switchChain = useCallback(async () => {
    if (!switchChainAsync) {
      throw new WalletBoundaryError("CHAIN_SWITCH_UNSUPPORTED");
    }
    try {
      await switchChainAsync({ chainId: sepolia.id });
    } catch {
      throw new WalletBoundaryError("CHAIN_SWITCH_REJECTED");
    }
  }, [switchChainAsync]);

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.session.dispose();
      sessionRef.current = null;
    }
    wagmiDisconnect();
  }, [wagmiDisconnect]);

  const openConnectModal = useCallback(() => {
    connectModal.openConnectModal?.();
  }, [connectModal]);

  const value = useMemo<GlobalWalletContextValue>(() => ({
    isConnected,
    address: normalizedAddress,
    chainId: normalizedChainId,
    isSepolia,
    status,
    connectorId: connector?.id ?? null,
    connectorName: connector?.name ?? null,
    getWalletSession,
    switchChain,
    disconnect,
    openConnectModal,
  }), [
    isConnected,
    normalizedAddress,
    normalizedChainId,
    isSepolia,
    status,
    connector,
    getWalletSession,
    switchChain,
    disconnect,
    openConnectModal,
  ]);

  return (
    <GlobalWalletContext.Provider value={value}>
      {children}
    </GlobalWalletContext.Provider>
  );
}

const defaultWalletContext: GlobalWalletContextValue = Object.freeze({
  isConnected: false,
  address: null,
  chainId: null,
  isSepolia: false,
  status: "disconnected",
  connectorId: null,
  connectorName: null,
  getWalletSession: async () => {
    throw new WalletBoundaryError("WALLET_DISCONNECTED");
  },
  switchChain: async () => {},
  disconnect: () => {},
  openConnectModal: () => {},
});

export function useGlobalWallet(): GlobalWalletContextValue {
  const context = useContext(GlobalWalletContext);
  return context ?? defaultWalletContext;
}
