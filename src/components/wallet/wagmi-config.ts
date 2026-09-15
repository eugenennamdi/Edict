"use client";

import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  okxWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";

const publicProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || "";

// If a public WalletConnect projectId is configured, full cloud/mobile connectors are enabled.
// Otherwise, Edict intentionally configures installed injected / EIP-6963 browser wallets only
// (injectedWallet, rabbyWallet), which operate directly without cloud credentials.
const wallets = publicProjectId
  ? [
      injectedWallet,
      okxWallet,
      rabbyWallet,
      metaMaskWallet,
      rainbowWallet,
      walletConnectWallet,
    ]
  : [injectedWallet, rabbyWallet];

const connectors = connectorsForWallets(
  [
    {
      groupName: "Supported Wallets",
      wallets,
    },
  ],
  {
    appName: "Edict",
    projectId: publicProjectId,
  },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [sepolia],
  transports: {
    [sepolia.id]: http(),
  },
  ssr: true,
});
