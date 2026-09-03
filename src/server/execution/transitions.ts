import { IllegalStateTransitionError, InvalidApprovalError } from "./errors";
import { jsonClone } from "./infrastructure";
import type {
  AuditEvent,
  EventActor,
  ExecutionRunEvent,
  ExecutionRunV1,
  OperationKind,
  WriteOperation,
} from "./types";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const WALLET = /^0x[0-9a-f]{40}$/;
const OPERATION_ORDER: readonly OperationKind[] = ["TOKENIZE", "WHITELIST", "MINT"];

function cloneRun(run: ExecutionRunV1): ExecutionRunV1 {
  return jsonClone(run);
}

function operationIndex(kind: OperationKind): 0 | 1 | 2 {
  if (kind === "TOKENIZE") return 0;
  if (kind === "WHITELIST") return 1;
  return 2;
}

function phaseForKind(kind: OperationKind): ExecutionRunV1["phase"] {
  if (kind === "TOKENIZE") return "TOKENIZATION";
  if (kind === "WHITELIST") return "WHITELIST";
  return "MINT";
}

function replaceOperation(
  run: ExecutionRunV1,
  kind: OperationKind,
  patch: Partial<WriteOperation>,
): ExecutionRunV1 {
  const index = operationIndex(kind);
  const current = run.operations[index];
  const nextOp: WriteOperation = { ...current, ...patch, kind: current.kind, id: current.id };
  const operations: ExecutionRunV1["operations"] = [
    index === 0 ? nextOp : run.operations[0],
    index === 1 ? nextOp : run.operations[1],
    index === 2 ? nextOp : run.operations[2],
  ];
  return { ...run, operations };
}

function actorFor(type: ExecutionRunEvent["type"]): EventActor {
  switch (type) {
    case "APPROVE_PLAN":
    case "CANCEL_RUN":
    case "RECORD_WALLET_PROMPT":
    case "RECORD_WALLET_REJECTION":
      return "USER";
    case "RECORD_BROADCAST_HASH":
    case "RECORD_BROADCAST_UNKNOWN":
      return "WALLET";
    case "RECORD_PENDING":
    case "RECORD_CONFIRMED":
    case "RECORD_REJECTED":
      return "BRICKKEN";
    default:
      return "SERVER";
  }
}

function appendEvent(
  run: ExecutionRunV1,
  event: ExecutionRunEvent,
  operationKind: OperationKind | null,
): ExecutionRunV1 {
  const audit: AuditEvent = {
    id: event.id,
    sequence: run.events.length + 1,
    type: event.type,
    at: event.at,
    actor: actorFor(event.type),
    operationKind,
  };
  return {
    ...run,
    updatedAt: event.at,
    events: [...run.events, audit],
  };
}

function op(run: ExecutionRunV1, kind: OperationKind): WriteOperation {
  return run.operations[operationIndex(kind)];
}

function predecessorVerified(run: ExecutionRunV1, kind: OperationKind): boolean {
  if (kind === "TOKENIZE") return true;
  if (kind === "WHITELIST") return op(run, "TOKENIZE").stage === "READ_BACK_VERIFIED";
  return op(run, "WHITELIST").stage === "READ_BACK_VERIFIED";
}

function hasAnyBroadcastHash(run: ExecutionRunV1): boolean {
  return run.operations.some((operation) => operation.blockchainTxHash !== null);
}

function assertNotTerminal(run: ExecutionRunV1): void {
  if (run.terminalOutcome !== null) {
    throw new IllegalStateTransitionError();
  }
}

function assertNotBlocked(run: ExecutionRunV1): void {
  assertNotTerminal(run);
  if (run.status === "RECONCILIATION_REQUIRED") {
    throw new IllegalStateTransitionError();
  }
}

function assertMatchingPhase(run: ExecutionRunV1, kind: OperationKind): void {
  if (run.phase !== phaseForKind(kind)) {
    throw new IllegalStateTransitionError();
  }
}

function assertApproved(run: ExecutionRunV1): void {
  if (run.approval === null) {
    throw new IllegalStateTransitionError();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function approve(run: ExecutionRunV1, event: Extract<ExecutionRunEvent, { type: "APPROVE_PLAN" }>): ExecutionRunV1 {
  if (run.phase !== "PLAN" || run.status !== "AWAITING_APPROVAL" || run.approval !== null) {
    throw new InvalidApprovalError();
  }
  if (event.planHash !== run.planHash) {
    throw new InvalidApprovalError();
  }
  const wallet = event.approvedByWallet.toLowerCase();
  if (!WALLET.test(wallet) || wallet !== run.requiredSigner.walletAddress) {
    throw new InvalidApprovalError();
  }
  const next: ExecutionRunV1 = {
    ...run,
    phase: "TOKENIZATION",
    status: "PREPARING",
    approval: {
      planHash: run.planHash,
      approvedByWallet: wallet,
      approvedAt: event.at,
      approvalRevision: run.revision,
    },
  };
  return appendEvent(next, event, null);
}

function cancel(run: ExecutionRunV1, event: Extract<ExecutionRunEvent, { type: "CANCEL_RUN" }>): ExecutionRunV1 {
  assertNotBlocked(run);
  if (hasAnyBroadcastHash(run)) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    {
      ...run,
      status: "FAILED",
      terminalOutcome: "CANCELLED",
    },
    event,
    null,
  );
}

function beginPrepare(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "BEGIN_PREPARE" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  assertApproved(run);
  const kind = event.operationKind;
  assertMatchingPhase(run, kind);
  if (!predecessorVerified(run, kind)) {
    throw new IllegalStateTransitionError();
  }
  const current = op(run, kind);
  if (current.stage !== "NOT_STARTED" || current.preparedTxId !== null) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "PREPARING" },
      kind,
      { stage: "PREPARE_INTENT", prepareIntentAt: event.at },
    ),
    event,
    kind,
  );
}

function recordPrepared(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_PREPARED" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.stage !== "PREPARE_INTENT") {
    throw new IllegalStateTransitionError();
  }
  if (typeof event.txId !== "string" || event.txId.length === 0 || Array.isArray(event.txId)) {
    throw new IllegalStateTransitionError();
  }
  if (!isPlainObject(event.unsignedTransaction)) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "AWAITING_WALLET" },
      kind,
      {
        stage: "PREPARED",
        preparedTxId: event.txId,
        unsignedTransaction: jsonClone(event.unsignedTransaction),
        preparedAt: event.at,
      },
    ),
    event,
    kind,
  );
}

function recordPrepareUnknown(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_PREPARE_UNKNOWN" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  if (op(run, kind).stage !== "PREPARE_INTENT") {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "RECONCILIATION_REQUIRED" },
      kind,
      { stage: "PREPARE_UNKNOWN" },
    ),
    event,
    kind,
  );
}

function recordPrepareFailure(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_PREPARE_FAILURE" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  if (op(run, kind).stage !== "PREPARE_INTENT") {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "FAILED", terminalOutcome: "FAILED" },
      kind,
      { stage: "PREPARE_UNKNOWN" },
    ),
    event,
    kind,
  );
}

function recordWalletPrompt(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_WALLET_PROMPT" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.blockchainTxHash !== null) {
    throw new IllegalStateTransitionError();
  }
  if (current.stage !== "PREPARED" && current.stage !== "WALLET_REJECTED") {
    throw new IllegalStateTransitionError();
  }
  if (current.preparedTxId === null) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "AWAITING_WALLET" },
      kind,
      { stage: "WALLET_PROMPT_RECORDED", walletPromptAt: event.at },
    ),
    event,
    kind,
  );
}

function recordWalletRejection(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_WALLET_REJECTION" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.stage !== "WALLET_PROMPT_RECORDED" || current.blockchainTxHash !== null) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "AWAITING_WALLET" },
      kind,
      { stage: "WALLET_REJECTED" },
    ),
    event,
    kind,
  );
}

function recordBroadcastHash(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_BROADCAST_HASH" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.stage !== "WALLET_PROMPT_RECORDED") {
    throw new IllegalStateTransitionError();
  }
  if (current.blockchainTxHash !== null) {
    throw new IllegalStateTransitionError();
  }
  if (!TX_HASH.test(event.txHash)) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "BROADCAST_RECORDED" },
      kind,
      {
        stage: "BROADCAST_HASH_PERSISTED",
        blockchainTxHash: event.txHash.toLowerCase(),
        broadcastAt: event.at,
      },
    ),
    event,
    kind,
  );
}

function recordBroadcastUnknown(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_BROADCAST_UNKNOWN" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  if (op(run, kind).stage !== "WALLET_PROMPT_RECORDED") {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "RECONCILIATION_REQUIRED" },
      kind,
      { stage: "BROADCAST_UNKNOWN" },
    ),
    event,
    kind,
  );
}

function submitConfirmation(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "SUBMIT_CONFIRMATION" }>,
): ExecutionRunV1 {
  assertNotTerminal(run);
  if (run.status === "RECONCILIATION_REQUIRED") {
    throw new IllegalStateTransitionError();
  }
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.stage !== "BROADCAST_HASH_PERSISTED") {
    throw new IllegalStateTransitionError();
  }
  if (current.preparedTxId === null || current.blockchainTxHash === null) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "CONFIRMING" },
      kind,
      { stage: "CONFIRMATION_SUBMITTED" },
    ),
    event,
    kind,
  );
}

function recordPending(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_PENDING" }>,
): ExecutionRunV1 {
  assertNotTerminal(run);
  if (run.status === "RECONCILIATION_REQUIRED") {
    throw new IllegalStateTransitionError();
  }
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.stage !== "CONFIRMATION_SUBMITTED" && current.stage !== "PENDING") {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "CONFIRMING", terminalOutcome: null },
      kind,
      { stage: "PENDING", brickkenStatus: "pending", timeout: false },
    ),
    event,
    kind,
  );
}

function recordConfirmTransportFailure(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_CONFIRM_TRANSPORT_FAILURE" }>,
): ExecutionRunV1 {
  assertNotTerminal(run);
  if (run.status === "RECONCILIATION_REQUIRED") {
    throw new IllegalStateTransitionError();
  }
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.stage !== "CONFIRMATION_SUBMITTED") {
    throw new IllegalStateTransitionError();
  }
  if (current.preparedTxId === null || current.blockchainTxHash === null) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "BROADCAST_RECORDED" },
      kind,
      { stage: "BROADCAST_HASH_PERSISTED" },
    ),
    event,
    kind,
  );
}

function recordConfirmed(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_CONFIRMED" }>,
): ExecutionRunV1 {
  assertNotTerminal(run);
  if (run.status === "RECONCILIATION_REQUIRED") {
    throw new IllegalStateTransitionError();
  }
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.stage !== "PENDING" && current.stage !== "CONFIRMATION_SUBMITTED") {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "CONFIRMING" },
      kind,
      {
        stage: "CONFIRMED",
        brickkenStatus: "success",
        timeout: false,
        confirmedAt: event.at,
      },
    ),
    event,
    kind,
  );
}

function recordRejected(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_REJECTED" }>,
): ExecutionRunV1 {
  assertNotTerminal(run);
  if (run.status === "RECONCILIATION_REQUIRED") {
    throw new IllegalStateTransitionError();
  }
  const kind = event.operationKind;
  const current = op(run, kind);
  if (current.stage !== "PENDING" && current.stage !== "CONFIRMATION_SUBMITTED") {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "FAILED", terminalOutcome: "FAILED" },
      kind,
      {
        stage: "REJECTED",
        brickkenStatus: "rejected",
        brickkenError: event.error,
      },
    ),
    event,
    kind,
  );
}

function recordPollTimeout(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_POLL_TIMEOUT" }>,
): ExecutionRunV1 {
  assertNotTerminal(run);
  if (run.status === "RECONCILIATION_REQUIRED") {
    throw new IllegalStateTransitionError();
  }
  const kind = event.operationKind;
  if (op(run, kind).stage !== "PENDING") {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    replaceOperation(
      { ...run, status: "TIMED_OUT" },
      kind,
      { timeout: true },
    ),
    event,
    kind,
  );
}

function recordReadBackVerified(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_READ_BACK_VERIFIED" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  if (op(run, kind).stage !== "CONFIRMED") {
    throw new IllegalStateTransitionError();
  }
  let next: ExecutionRunV1 = replaceOperation(run, kind, {
    stage: "READ_BACK_VERIFIED",
    verifiedAt: event.at,
  });
  next = {
    ...next,
    observations: [
      ...next.observations,
      { operationKind: kind, read: event.read, at: event.at },
    ],
  };
  if (kind === "TOKENIZE") {
    next = { ...next, phase: "WHITELIST", status: "PREPARING" };
  } else if (kind === "WHITELIST") {
    next = { ...next, phase: "MINT", status: "PREPARING" };
  } else {
    next = { ...next, phase: "VERIFICATION", status: "SUCCEEDED" };
  }
  return appendEvent(next, event, kind);
}

function recordReadBackMismatch(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_READ_BACK_MISMATCH" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  const kind = event.operationKind;
  if (op(run, kind).stage !== "CONFIRMED") {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    { ...run, status: "FAILED", terminalOutcome: "VERIFICATION_FAILED" },
    event,
    kind,
  );
}

function recordFinalVerification(
  run: ExecutionRunV1,
  event: Extract<ExecutionRunEvent, { type: "RECORD_FINAL_VERIFICATION" }>,
): ExecutionRunV1 {
  assertNotBlocked(run);
  if (run.phase !== "VERIFICATION") {
    throw new IllegalStateTransitionError();
  }
  const allVerified = OPERATION_ORDER.every(
    (kind) => op(run, kind).stage === "READ_BACK_VERIFIED",
  );
  if (!allVerified) {
    throw new IllegalStateTransitionError();
  }
  return appendEvent(
    {
      ...run,
      receiptEligible: true,
      status: "SUCCEEDED",
    },
    event,
    null,
  );
}

export function applyRunEvent(run: ExecutionRunV1, event: ExecutionRunEvent): ExecutionRunV1 {
  const current = cloneRun(run);
  switch (event.type) {
    case "APPROVE_PLAN":
      return approve(current, event);
    case "CANCEL_RUN":
      return cancel(current, event);
    case "BEGIN_PREPARE":
      return beginPrepare(current, event);
    case "RECORD_PREPARED":
      return recordPrepared(current, event);
    case "RECORD_PREPARE_UNKNOWN":
      return recordPrepareUnknown(current, event);
    case "RECORD_PREPARE_FAILURE":
      return recordPrepareFailure(current, event);
    case "RECORD_WALLET_PROMPT":
      return recordWalletPrompt(current, event);
    case "RECORD_WALLET_REJECTION":
      return recordWalletRejection(current, event);
    case "RECORD_BROADCAST_HASH":
      return recordBroadcastHash(current, event);
    case "RECORD_BROADCAST_UNKNOWN":
      return recordBroadcastUnknown(current, event);
    case "SUBMIT_CONFIRMATION":
      return submitConfirmation(current, event);
    case "RECORD_PENDING":
      return recordPending(current, event);
    case "RECORD_CONFIRM_TRANSPORT_FAILURE":
      return recordConfirmTransportFailure(current, event);
    case "RECORD_CONFIRMED":
      return recordConfirmed(current, event);
    case "RECORD_REJECTED":
      return recordRejected(current, event);
    case "RECORD_POLL_TIMEOUT":
      return recordPollTimeout(current, event);
    case "RECORD_READ_BACK_VERIFIED":
      return recordReadBackVerified(current, event);
    case "RECORD_READ_BACK_MISMATCH":
      return recordReadBackMismatch(current, event);
    case "RECORD_FINAL_VERIFICATION":
      return recordFinalVerification(current, event);
    default: {
      const exhaustive: never = event;
      throw new IllegalStateTransitionError(String(exhaustive));
    }
  }
}

export function persistedConfirmationPair(
  run: ExecutionRunV1,
  kind: OperationKind,
): { txId: string; txHash: string } | null {
  const current = op(run, kind);
  if (current.preparedTxId === null || current.blockchainTxHash === null) {
    return null;
  }
  return { txId: current.preparedTxId, txHash: current.blockchainTxHash };
}

export { OPERATION_ORDER };
