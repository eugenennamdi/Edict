import "server-only";

export type OrchestrationErrorCode =
  | "BRICKKEN_OPERATION_FAILED"
  | "EXECUTION_INVARIANT_FAILED"
  | "READ_BACK_FAILED";

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;

  constructor(code: OrchestrationErrorCode) {
    const messages: Record<OrchestrationErrorCode, string> = {
      BRICKKEN_OPERATION_FAILED: "The sandbox operation did not complete safely.",
      EXECUTION_INVARIANT_FAILED: "The persisted run does not match its approved plan.",
      READ_BACK_FAILED: "The sandbox read-back could not be verified.",
    };
    super(messages[code]);
    this.name = "OrchestrationError";
    this.code = code;
  }
}
