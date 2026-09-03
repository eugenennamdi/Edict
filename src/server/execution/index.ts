import "server-only";

export {
  ExecutionError,
  IllegalStateTransitionError,
  InvalidApprovalError,
  InvalidRunSnapshotError,
  RepositoryNotFoundError,
  RepositoryRevisionConflictError,
  RunBlockedError,
  type ExecutionErrorCode,
} from "./errors";
export {
  cryptoIdGenerator,
  systemClock,
  type Clock,
  type IdGenerator,
} from "./infrastructure";
export { InMemoryExecutionRunRepository, type ExecutionRunRepository } from "./repository";
export { ExecutionRunService, type ExecutionRunServiceDeps } from "./run-service";
export { applyRunEvent, persistedConfirmationPair } from "./transitions";
export type {
  ApprovalRecord,
  AuditEvent,
  ExecutionRunEvent,
  ExecutionRunV1,
  IsoUtcTimestamp,
  OperationKind,
  OperationStage,
  RunPhase,
  RunStatus,
  TerminalOutcome,
  WriteOperation,
} from "./types";
