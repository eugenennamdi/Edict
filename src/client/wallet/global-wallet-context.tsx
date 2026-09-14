"use client";

import "client-only";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  GlobalWalletSessionController,
  type GlobalWalletSessionState,
} from "./global-wallet-session-controller";

export { PREFERRED_WALLET_STORAGE_KEY, type GlobalWalletStatus } from "./global-wallet-session-controller";

export interface GlobalWalletContextValue extends GlobalWalletSessionState {
  readonly openSelector: () => void;
  readonly closeSelector: () => void;
  readonly connect: (selectionIdOrRdns: string) => Promise<void>;
  readonly connectLegacy: () => Promise<void>;
  readonly disconnect: () => void;
  readonly switchChain: () => Promise<void>;
  readonly refreshSession: () => Promise<void>;
}

export const defaultGlobalWalletContext: GlobalWalletContextValue = Object.freeze({
  status: "DISCONNECTED",
  providers: Object.freeze([]),
  selectedProvider: null,
  session: null,
  accounts: Object.freeze([]),
  address: null,
  chainId: null,
  isSepolia: false,
  isSelectorOpen: false,
  errorMessage: null,
  openSelector: () => undefined,
  closeSelector: () => undefined,
  connect: async () => undefined,
  connectLegacy: async () => undefined,
  disconnect: () => undefined,
  switchChain: async () => undefined,
  refreshSession: async () => undefined,
});

const GlobalWalletContext = createContext<GlobalWalletContextValue>(defaultGlobalWalletContext);

export function useGlobalWallet(): GlobalWalletContextValue {
  return useContext(GlobalWalletContext);
}

export interface GlobalWalletProviderProps {
  readonly children?: ReactNode;
  readonly controller?: GlobalWalletSessionController;
}

export function GlobalWalletProvider({
  children,
  controller: externalController,
}: GlobalWalletProviderProps) {
  const [controller] = useState(
    () =>
      externalController ??
      new GlobalWalletSessionController({
        events: typeof window !== "undefined" ? window : new EventTarget(),
        storage: typeof window !== "undefined" ? window.localStorage : undefined,
      }),
  );

  const [state, setState] = useState(() => controller.getState());

  useEffect(() => {
    controller.start();
    const unsubscribe = controller.subscribe(() => {
      setState(controller.getState());
    });
    return () => {
      unsubscribe();
      if (!externalController) {
        controller.dispose();
      }
    };
  }, [controller, externalController]);

  const value: GlobalWalletContextValue = useMemo(
    () => ({
      ...state,
      openSelector: () => controller.openSelector(),
      closeSelector: () => controller.closeSelector(),
      connect: (id) => controller.connect(id),
      connectLegacy: () => controller.connectLegacy(),
      disconnect: () => controller.disconnect(),
      switchChain: () => controller.switchChain(),
      refreshSession: () => controller.refreshSession(),
    }),
    [state, controller],
  );

  return <GlobalWalletContext.Provider value={value}>{children}</GlobalWalletContext.Provider>;
}
