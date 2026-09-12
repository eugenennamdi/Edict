export type WalletExecutionViewState =
  | "WALLET_REQUIRED"
  | "PROVIDER_SELECTION"
  | "ACCOUNT_ACCESS_REQUIRED"
  | "WRONG_CHAIN"
  | "REQUIRED_SIGNER_UNAVAILABLE"
  | "READY"
  | "AUTHORIZATION_UNAVAILABLE"
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
  | Readonly<{ type: "REFRESH_REQUIRED" }>
  | Readonly<{ type: "AMBIGUOUS" }>
  | Readonly<{ type: "HASH_RECORDED" }>
  | Readonly<{ type: "DURABLE_RECONCILIATION" }>;

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
