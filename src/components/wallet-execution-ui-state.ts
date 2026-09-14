export type WalletExecutionViewState =
  | "WALLET_REQUIRED"
  | "PROVIDER_SELECTION"
  | "ACCOUNT_ACCESS_REQUIRED"
  | "WRONG_CHAIN"
  | "REQUIRED_SIGNER_UNAVAILABLE"
  | "READY"
  | "AUTHORIZATION_UNAVAILABLE"
  | "AUTHORIZATION_POLICY_REFUSED"
  | "FRESHNESS_CHECK_FAILED"
  | "DURABLE_REFRESH_REQUIRED"
  | "PROMPT_IN_PROGRESS"
  | "HASH_RECORDED"
  | "BROADCAST_UNCERTAIN"
  | "RECONCILIATION_REQUIRED";

export interface WalletExecutionUiModel {
  readonly state: WalletExecutionViewState;
  readonly locked: boolean;
  readonly inProgress: boolean;
}

export type WalletExecutionUiEvent =
  | Readonly<{ type: "LOCAL_STATE"; state: WalletExecutionViewState }>
  | Readonly<{ type: "START" }>
  | Readonly<{ type: "AUTHORIZATION_UNAVAILABLE" }>
  | Readonly<{ type: "AUTHORIZATION_POLICY_REFUSED" }>
  | Readonly<{ type: "FRESHNESS_CHECK_FAILED" }>
  | Readonly<{ type: "REFRESH_REQUIRED" }>
  | Readonly<{ type: "AMBIGUOUS" }>
  | Readonly<{ type: "HASH_RECORDED" }>
  | Readonly<{ type: "DURABLE_RECONCILIATION" }>;

export interface WalletExecutionErrorDetail {
  readonly title: string;
  readonly description: string;
  readonly onChainSubmission: "NO" | "YES" | "UNKNOWN";
  readonly nextStep: string;
  readonly retryAllowed: boolean;
}

export function classifyWalletExecutionErrorDetail(
  code: string,
): WalletExecutionErrorDetail {
  if (code === "BROADCAST_OUTCOME_UNKNOWN" || code === "RECONCILIATION_REQUIRED") {
    return Object.freeze({
      title: "Transaction broadcast outcome unknown",
      description: "The wallet may have broadcast the transaction, but Edict could not confirm the transaction hash.",
      onChainSubmission: "UNKNOWN",
      nextStep: "Do not submit another transaction. Check your wallet activity or Sepolia block explorer for your address.",
      retryAllowed: false,
    });
  }
  if (code === "EXECUTION_AUTHORIZATION_UNAVAILABLE") {
    return Object.freeze({
      title: "Execution authorization unavailable",
      description: "Mandate execution authorization is disabled or unavailable on the server.",
      onChainSubmission: "NO",
      nextStep: "No transaction was submitted to the network. Contact administrator or verify server environment.",
      retryAllowed: false,
    });
  }
  if (code === "SEMANTIC_POLICY_REFUSED") {
    return Object.freeze({
      title: "Transaction policy validation refused",
      description: "The prepared transaction parameters or contract destination did not satisfy strict safety policy.",
      onChainSubmission: "NO",
      nextStep: "No transaction was submitted to the network. This execution requires attention; review technical details or create a new mandate.",
      retryAllowed: false,
    });
  }
  if (code === "FRESHNESS_CHECK_FAILED") {
    return Object.freeze({
      title: "Transaction preparation expired",
      description: "On-chain state (such as the price report or account nonce) changed since preparation.",
      onChainSubmission: "NO",
      nextStep: "No transaction was submitted. Click Reprepare to refresh the transaction with current chain state.",
      retryAllowed: true,
    });
  }
  if (
    [
      "AUTHORIZATION_STATE_CHANGED",
      "AUTHORIZATION_RESPONSE_UNKNOWN",
      "AUTHORIZATION_RESPONSE_MALFORMED",
      "AUTHORIZATION_REQUEST_REFUSED",
    ].includes(code)
  ) {
    return Object.freeze({
      title: "Authorization synchronization conflict",
      description: "The server mandate record changed or could not be safely synchronized.",
      onChainSubmission: "NO",
      nextStep: "No transaction was submitted. Refresh this record before trying again.",
      retryAllowed: true,
    });
  }
  if (code === "TRANSACTION_REJECTED") {
    return Object.freeze({
      title: "Transaction signature declined",
      description: "The transaction prompt was rejected in your wallet.",
      onChainSubmission: "NO",
      nextStep: "No transaction was submitted and no gas was spent. You can safely try again whenever you are ready.",
      retryAllowed: true,
    });
  }
  if (code === "REQUIRED_ACCOUNT_UNAVAILABLE" || code === "ACCOUNT_AUTHORIZATION_REJECTED") {
    return Object.freeze({
      title: "Required signer account not active",
      description: "Your connected wallet is not currently active with the approved tokenizer address.",
      onChainSubmission: "NO",
      nextStep: "Open your wallet, select the approved signer account, and click Confirm in wallet.",
      retryAllowed: true,
    });
  }
  if (code === "WRONG_CHAIN" || code === "CHAIN_SWITCH_REJECTED" || code === "CHAIN_SWITCH_UNSUPPORTED") {
    return Object.freeze({
      title: "Wrong network selected",
      description: "Your wallet is not connected to Ethereum Sepolia.",
      onChainSubmission: "NO",
      nextStep: "Switch your wallet network to Ethereum Sepolia, then click Confirm in wallet.",
      retryAllowed: true,
    });
  }
  return Object.freeze({
    title: "Wallet execution could not proceed",
    description: "Edict could not safely proceed with the wallet transaction.",
    onChainSubmission: "NO",
    nextStep: "No confirmed wallet transaction was recorded. Check your wallet, ensure it is unlocked on Sepolia, and try again.",
    retryAllowed: true,
  });
}

export function classifyWalletExecutionFailure(code: string): Readonly<{
  event: WalletExecutionUiEvent;
  refresh: boolean;
}> {
  if (code === "BROADCAST_OUTCOME_UNKNOWN" || code === "RECONCILIATION_REQUIRED") {
    return Object.freeze({ event: Object.freeze({ type: "AMBIGUOUS" }), refresh: true });
  }
  if (code === "EXECUTION_AUTHORIZATION_UNAVAILABLE") {
    return Object.freeze({
      event: Object.freeze({ type: "AUTHORIZATION_UNAVAILABLE" }),
      refresh: false,
    });
  }
  if (code === "SEMANTIC_POLICY_REFUSED") {
    return Object.freeze({
      event: Object.freeze({ type: "AUTHORIZATION_POLICY_REFUSED" }),
      refresh: false,
    });
  }
  if (code === "FRESHNESS_CHECK_FAILED") {
    return Object.freeze({
      event: Object.freeze({ type: "FRESHNESS_CHECK_FAILED" }),
      refresh: false,
    });
  }
  if ([
    "AUTHORIZATION_STATE_CHANGED",
    "AUTHORIZATION_RESPONSE_UNKNOWN",
    "AUTHORIZATION_RESPONSE_MALFORMED",
    "AUTHORIZATION_REQUEST_REFUSED",
  ].includes(code)) {
    return Object.freeze({ event: Object.freeze({ type: "REFRESH_REQUIRED" }), refresh: true });
  }
  return Object.freeze({
    event: Object.freeze({ type: "LOCAL_STATE", state: "REQUIRED_SIGNER_UNAVAILABLE" }),
    refresh: false,
  });
}

export const initialWalletExecutionUiModel: WalletExecutionUiModel = Object.freeze({
  state: "WALLET_REQUIRED",
  locked: false,
  inProgress: false,
});

export function reduceWalletExecutionUi(
  current: WalletExecutionUiModel,
  event: WalletExecutionUiEvent,
): WalletExecutionUiModel {
  if (event.type === "LOCAL_STATE") {
    return current.locked || current.inProgress
      ? current
      : Object.freeze({ ...current, state: event.state });
  }
  if (event.type === "START") {
    return current.locked || current.inProgress || current.state !== "READY"
      ? current
      : Object.freeze({ state: "PROMPT_IN_PROGRESS", locked: false, inProgress: true });
  }
  if (event.type === "AUTHORIZATION_UNAVAILABLE") {
    return Object.freeze({ state: "AUTHORIZATION_UNAVAILABLE", locked: true, inProgress: false });
  }
  if (event.type === "AUTHORIZATION_POLICY_REFUSED") {
    return Object.freeze({ state: "AUTHORIZATION_POLICY_REFUSED", locked: true, inProgress: false });
  }
  if (event.type === "FRESHNESS_CHECK_FAILED") {
    return Object.freeze({ state: "FRESHNESS_CHECK_FAILED", locked: true, inProgress: false });
  }
  if (event.type === "REFRESH_REQUIRED") {
    return Object.freeze({ state: "DURABLE_REFRESH_REQUIRED", locked: true, inProgress: false });
  }
  if (event.type === "AMBIGUOUS") {
    return Object.freeze({ state: "BROADCAST_UNCERTAIN", locked: true, inProgress: false });
  }
  if (event.type === "DURABLE_RECONCILIATION") {
    return Object.freeze({ state: "RECONCILIATION_REQUIRED", locked: true, inProgress: false });
  }
  return Object.freeze({ state: "HASH_RECORDED", locked: true, inProgress: false });
}
