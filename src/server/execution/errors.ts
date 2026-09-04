export type ExecutionErrorCode =
  | "CONFIGURATION_MISSING"
  | "ILLEGAL_STATE_TRANSITION"
  | "INVALID_APPROVAL"
  | "INVALID_RUN_SNAPSHOT"
  | "PERSISTENCE_DATA_INVALID"
  | "PERSISTENCE_UNAVAILABLE"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_REVISION_CONFLICT"
  | "RUN_BLOCKED";

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}

export class IllegalStateTransitionError extends ExecutionError {
  constructor(message = "The requested execution-run transition is not allowed.") {
    super("ILLEGAL_STATE_TRANSITION", message);
    this.name = "IllegalStateTransitionError";
  }
}

export class InvalidApprovalError extends ExecutionError {
  constructor(message = "The approval does not match the persisted plan and signer.") {
    super("INVALID_APPROVAL", message);
    this.name = "InvalidApprovalError";
  }
}

export class RepositoryNotFoundError extends ExecutionError {
  constructor() {
    super("REPOSITORY_NOT_FOUND", "No execution run exists for the supplied identifier.");
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryRevisionConflictError extends ExecutionError {
  constructor() {
    super(
      "REPOSITORY_REVISION_CONFLICT",
      "The execution run was updated against a stale revision.",
    );
    this.name = "RepositoryRevisionConflictError";
  }
}

export class InvalidRunSnapshotError extends ExecutionError {
  constructor() {
    super(
      "INVALID_RUN_SNAPSHOT",
      "The execution run is not a valid persistence snapshot.",
    );
    this.name = "InvalidRunSnapshotError";
  }
}

export class PersistenceConfigurationError extends ExecutionError {
  constructor() {
    super("CONFIGURATION_MISSING", "Durable execution persistence is not configured.");
    this.name = "PersistenceConfigurationError";
  }
}

export class PersistenceDataError extends ExecutionError {
  constructor() {
    super("PERSISTENCE_DATA_INVALID", "Stored execution data failed validation.");
    this.name = "PersistenceDataError";
  }
}

export class PersistenceUnavailableError extends ExecutionError {
  constructor() {
    super("PERSISTENCE_UNAVAILABLE", "Durable execution persistence is unavailable.");
    this.name = "PersistenceUnavailableError";
  }
}

export class RunBlockedError extends ExecutionError {
  constructor() {
    super(
      "RUN_BLOCKED",
      "The execution run requires manual reconciliation and cannot continue automatically.",
    );
    this.name = "RunBlockedError";
  }
}
