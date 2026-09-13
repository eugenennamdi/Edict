import "server-only";

export type OrchestrationErrorCode =
  | "BRICKKEN_OPERATION_FAILED"
  | "EXECUTION_INVARIANT_FAILED"
  | "READ_BACK_FAILED"
  | "READ_BACK_BINDING_UNRESOLVED"
  | "AUTHORIZATION_DENIED"
  | "CORRELATION_FAILED"
  | "STATUS_CONTRADICTION";

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;

  constructor(code: OrchestrationErrorCode) {
    const messages: Record<OrchestrationErrorCode, string> = {
      BRICKKEN_OPERATION_FAILED: "The sandbox operation did not complete safely.",
      EXECUTION_INVARIANT_FAILED: "The persisted run does not match its approved plan.",
      READ_BACK_FAILED: "The sandbox read-back could not be verified.",
      READ_BACK_BINDING_UNRESOLVED:
        "The deployed token address cannot be bound to the finalized tokenization transaction.",
      AUTHORIZATION_DENIED: "Semantic authorization denied execution of the requested operation.",
      CORRELATION_FAILED: "Brickken transaction correlation failed.",
      STATUS_CONTRADICTION: "Brickken status evidence contradicted durable execution identity.",
    };
    super(messages[code]);
    this.name = "OrchestrationError";
    this.code = code;
  }
}
