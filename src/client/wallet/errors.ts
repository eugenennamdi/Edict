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
  | "ATTEMPT_INVALIDATED"
  | "MALFORMED_PROMPT_ENVELOPE"
  | "WALLET_INTENT_HASH_MISMATCH"
  | "SEMANTIC_POLICY_REFUSED"
  | "PRE_SEND_ABORTED"
  | "TRANSACTION_REJECTED"
  | "BROADCAST_OUTCOME_UNKNOWN"
  | "INVALID_TRANSACTION_HASH"
  | "DURABLE_PROMPT_RECORDING_FAILED"
  | "DURABLE_HASH_HANDOFF_FAILED"
  | "RECONCILIATION_REQUIRED"
  | "MALFORMED_PREPARED_TRANSACTION"
  | "PREPARED_TRANSACTION_INCOMPLETE"
  | "CONFLICTING_TRANSACTION_FIELDS"
  | "UNSUPPORTED_SIGNING_FIELD"
  | "SIGNER_MISMATCH";

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
  MALFORMED_PROMPT_ENVELOPE: "The durable wallet prompt is malformed.",
  WALLET_INTENT_HASH_MISMATCH: "The durable wallet prompt failed its integrity check.",
  SEMANTIC_POLICY_REFUSED: "The transaction is not authorized by the semantic policy.",
  PRE_SEND_ABORTED: "The transaction was not submitted because validation changed before invocation.",
  TRANSACTION_REJECTED: "The wallet transaction was rejected.",
  BROADCAST_OUTCOME_UNKNOWN: "The wallet may have broadcast the transaction.",
  INVALID_TRANSACTION_HASH: "The wallet returned an invalid transaction hash.",
  DURABLE_PROMPT_RECORDING_FAILED: "The wallet prompt could not be recorded durably.",
  DURABLE_HASH_HANDOFF_FAILED: "The transaction hash could not be confirmed durable.",
  RECONCILIATION_REQUIRED: "Manual transaction reconciliation is required.",
  MALFORMED_PREPARED_TRANSACTION: "The prepared transaction is malformed.",
  PREPARED_TRANSACTION_INCOMPLETE: "The prepared transaction is incomplete.",
  CONFLICTING_TRANSACTION_FIELDS: "The prepared transaction contains conflicting fields.",
  UNSUPPORTED_SIGNING_FIELD: "The prepared transaction contains an unsupported signing field.",
  SIGNER_MISMATCH: "The prepared transaction signer does not match the approved tokenizer.",
});

export class WalletBoundaryError extends Error {
  readonly reconciliationRequired: boolean;

  constructor(readonly code: WalletErrorCode) {
    super(messages[code]);
    this.name = "WalletBoundaryError";
    this.reconciliationRequired = [
      "BROADCAST_OUTCOME_UNKNOWN",
      "INVALID_TRANSACTION_HASH",
      "DURABLE_HASH_HANDOFF_FAILED",
      "RECONCILIATION_REQUIRED",
    ].includes(code);
  }
}

export function providerErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "number"
    ? descriptor.value
    : null;
}
