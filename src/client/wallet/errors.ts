"use client";

import "client-only";

export type WalletErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "NO_COMPATIBLE_WALLETS_DISCOVERED"
  | "SELECTED_PROVIDER_DISAPPEARED"
  | "PROVIDER_METADATA_MALFORMED"
  | "ACCOUNT_AUTHORIZATION_REJECTED"
  | "UNSUPPORTED_METHOD"
  | "WALLET_DISCONNECTED"
  | "REQUIRED_ACCOUNT_UNAVAILABLE"
  | "WRONG_CHAIN"
  | "CHAIN_SWITCH_UNSUPPORTED"
  | "CHAIN_SWITCH_REJECTED"
  | "APPROVAL_CHALLENGE_MALFORMED"
  | "APPROVAL_CHALLENGE_EXPIRED"
  | "TYPED_DATA_MISMATCH"
  | "TYPED_DATA_SIGNING_UNSUPPORTED"
  | "SIGNATURE_REJECTED"
  | "ATTEMPT_INVALIDATED";

const messages: Readonly<Record<WalletErrorCode, string>> = Object.freeze({
  PROVIDER_UNAVAILABLE: "The selected wallet provider is unavailable.",
  NO_COMPATIBLE_WALLETS_DISCOVERED: "No compatible injected wallet was discovered.",
  SELECTED_PROVIDER_DISAPPEARED: "The selected wallet provider is no longer available.",
  PROVIDER_METADATA_MALFORMED: "A wallet announcement was malformed.",
  ACCOUNT_AUTHORIZATION_REJECTED: "Wallet account authorization was rejected.",
  UNSUPPORTED_METHOD: "The selected wallet does not support the required method.",
  WALLET_DISCONNECTED: "The selected wallet is disconnected.",
  REQUIRED_ACCOUNT_UNAVAILABLE: "The approved tokenizer account is not available in the wallet.",
  WRONG_CHAIN: "The selected wallet is not connected to Ethereum Sepolia.",
  CHAIN_SWITCH_UNSUPPORTED: "The wallet cannot switch to Ethereum Sepolia automatically.",
  CHAIN_SWITCH_REJECTED: "The Ethereum Sepolia switch was rejected.",
  APPROVAL_CHALLENGE_MALFORMED: "The approval challenge is malformed.",
  APPROVAL_CHALLENGE_EXPIRED: "The approval challenge has expired.",
  TYPED_DATA_MISMATCH: "The approval request does not match the current run.",
  TYPED_DATA_SIGNING_UNSUPPORTED: "The wallet does not support the required approval signature.",
  SIGNATURE_REJECTED: "The approval signature was rejected.",
  ATTEMPT_INVALIDATED: "Wallet state changed during the operation.",
});

export class WalletBoundaryError extends Error {
  constructor(readonly code: WalletErrorCode) {
    super(messages[code]);
    this.name = "WalletBoundaryError";
  }
}

export function providerErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "number"
    ? descriptor.value
    : null;
}
