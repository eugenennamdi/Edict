import "server-only";

export type OrchestrationErrorCode =
  | "TRACKING_BUDGET_EXHAUSTED"
  | "BRICKKEN_OPERATION_FAILED"
  | "EXECUTION_INVARIANT_FAILED"
  | "READ_BACK_FAILED"
  | "READ_BACK_MISMATCH"
  | "READ_BACK_BINDING_UNRESOLVED"
  | "AUTHORIZATION_DENIED"
  | "AUTHORIZATION_POLICY_REFUSED"
  | "FRESHNESS_CHECK_FAILED"
  | "CORRELATION_FAILED"
  | "STATUS_CONTRADICTION"
  | "AUTHENTICATION_REJECTED"
  | "ENTITLEMENT_REJECTED"
  | "CREDITS_EXHAUSTED"
  | "INVALID_REQUEST"
  | "SIGNER_NOT_APPROVED"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_SERVER_ERROR"
  | "PREPARATION_REFUSED"
  | "PREPARATION_UNCONFIRMED";

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: OrchestrationErrorCode, options?: { readonly retryAfterSeconds?: number }) {
    const messages: Record<OrchestrationErrorCode, string> = {
      TRACKING_BUDGET_EXHAUSTED: "Automatic tracking is paused. This run has reached its server tracking limit.",
      BRICKKEN_OPERATION_FAILED: "The sandbox operation did not complete safely.",
      EXECUTION_INVARIANT_FAILED: "The persisted run does not match its approved plan.",
      READ_BACK_FAILED: "The sandbox read-back could not be verified.",
      READ_BACK_MISMATCH: "Sandbox read-back contradicted the approved mandate.",
      READ_BACK_BINDING_UNRESOLVED:
        "The deployed token address cannot be bound to the finalized tokenization transaction.",
      AUTHORIZATION_DENIED: "Semantic authorization denied execution of the requested operation.",
      AUTHORIZATION_POLICY_REFUSED: "The durable TOKENIZE run is not authorized for wallet submission.",
      FRESHNESS_CHECK_FAILED: "Server freshness check could not be completed. No wallet transaction request was made.",
      CORRELATION_FAILED: "Brickken transaction correlation failed.",
      STATUS_CONTRADICTION: "Brickken status evidence contradicted durable execution identity.",
      AUTHENTICATION_REJECTED: "Brickken rejected the sandbox credential.",
      ENTITLEMENT_REJECTED: "Brickken rejected the licensed account entitlement.",
      CREDITS_EXHAUSTED: "The Brickken sandbox account has no remaining credits.",
      INVALID_REQUEST: "Brickken rejected the preparation request as invalid.",
      SIGNER_NOT_APPROVED: "Brickken rejected the requested signer.",
      UPSTREAM_RATE_LIMITED: "Brickken rate-limited the preparation request.",
      UPSTREAM_SERVER_ERROR: "Brickken returned a server error during preparation.",
      PREPARATION_REFUSED: "Brickken refused the preparation request.",
      PREPARATION_UNCONFIRMED: "The preparation outcome could not be confirmed.",
    };
    super(messages[code]);
    this.name = "OrchestrationError";
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}
