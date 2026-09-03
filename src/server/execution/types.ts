export type IsoUtcTimestamp = string;

export type RunPhase =
  | "PLAN"
  | "TOKENIZATION"
  | "WHITELIST"
  | "MINT"
  | "VERIFICATION";

export type RunStatus =
  | "AWAITING_APPROVAL"
  | "PREPARING"
  | "AWAITING_WALLET"
  | "BROADCAST_RECORDED"
  | "CONFIRMING"
  | "SUCCEEDED"
  | "TIMED_OUT"
  | "FAILED"
  | "RECONCILIATION_REQUIRED";

export type TerminalOutcome = "FAILED" | "VERIFICATION_FAILED" | "CANCELLED";

export type OperationKind = "TOKENIZE" | "WHITELIST" | "MINT";

export type OperationStage =
  | "NOT_STARTED"
  | "PREPARE_INTENT"
  | "PREPARED"
  | "WALLET_PROMPT_RECORDED"
  | "WALLET_REJECTED"
  | "BROADCAST_HASH_PERSISTED"
  | "CONFIRMATION_SUBMITTED"
  | "PENDING"
  | "CONFIRMED"
  | "READ_BACK_VERIFIED"
  | "REJECTED"
  | "PREPARE_UNKNOWN"
  | "BROADCAST_UNKNOWN";

export type EventActor = "USER" | "SERVER" | "WALLET" | "BRICKKEN";

export type BrickkenConfirmationStatus = "pending" | "success" | "rejected";

export interface ExecutionManifestSnapshot {
  readonly schemaVersion: "1.0";
  readonly environment: "sandbox";
  readonly chainId: "11155111";
  readonly tokenizer: {
    readonly email: string;
    readonly walletAddress: string;
  };
  readonly asset: {
    readonly name: string;
    readonly symbol: string;
    readonly tokenType: "RWA_TOKEN";
    readonly supplyCap: string;
    readonly documentationUrl: string;
  };
  readonly investor: {
    readonly email: string;
    readonly walletAddress: string;
    readonly mintAmount: string;
  };
}

export interface ExecutionPlanSnapshot {
  readonly planVersion: "1.0";
  readonly manifestHash: string;
  readonly environment: "sandbox";
  readonly chainId: "11155111";
  readonly requiredSigner: {
    readonly role: "tokenizer";
    readonly walletAddress: string;
  };
  readonly planHash: string;
}

export interface ApprovalRecord {
  readonly planHash: string;
  readonly approvedByWallet: string;
  readonly approvedAt: IsoUtcTimestamp;
  readonly approvalRevision: number;
}

export interface WriteOperation {
  readonly id: string;
  readonly kind: OperationKind;
  readonly stage: OperationStage;
  readonly preparedTxId: string | null;
  readonly unsignedTransaction: Record<string, unknown> | null;
  readonly blockchainTxHash: string | null;
  readonly brickkenStatus: BrickkenConfirmationStatus | null;
  readonly brickkenError: string | null;
  readonly timeout: boolean;
  readonly prepareIntentAt: IsoUtcTimestamp | null;
  readonly preparedAt: IsoUtcTimestamp | null;
  readonly walletPromptAt: IsoUtcTimestamp | null;
  readonly broadcastAt: IsoUtcTimestamp | null;
  readonly confirmedAt: IsoUtcTimestamp | null;
  readonly verifiedAt: IsoUtcTimestamp | null;
}

export interface AuditEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly at: IsoUtcTimestamp;
  readonly actor: EventActor;
  readonly operationKind: OperationKind | null;
}

export interface ObservationRecord {
  readonly operationKind: OperationKind;
  readonly read: string;
  readonly at: IsoUtcTimestamp;
}

export interface ExecutionRunV1 {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly manifest: ExecutionManifestSnapshot;
  readonly manifestHash: string;
  readonly plan: ExecutionPlanSnapshot;
  readonly planHash: string;
  readonly environment: "sandbox";
  readonly chainId: "11155111";
  readonly requiredSigner: {
    readonly role: "tokenizer";
    readonly walletAddress: string;
  };
  readonly phase: RunPhase;
  readonly status: RunStatus;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly approval: ApprovalRecord | null;
  readonly operations: readonly [WriteOperation, WriteOperation, WriteOperation];
  readonly observations: readonly ObservationRecord[];
  readonly events: readonly AuditEvent[];
  readonly receiptEligible: boolean;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
  readonly revision: number;
}

export type ExecutionRunEvent =
  | {
      readonly type: "APPROVE_PLAN";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly planHash: string;
      readonly approvedByWallet: string;
    }
  | {
      readonly type: "CANCEL_RUN";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
    }
  | {
      readonly type: "BEGIN_PREPARE";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_PREPARED";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
      readonly txId: string;
      readonly unsignedTransaction: Record<string, unknown>;
    }
  | {
      readonly type: "RECORD_PREPARE_UNKNOWN";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_PREPARE_FAILURE";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_WALLET_PROMPT";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_WALLET_REJECTION";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_BROADCAST_HASH";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
      readonly txHash: string;
    }
  | {
      readonly type: "RECORD_BROADCAST_UNKNOWN";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "SUBMIT_CONFIRMATION";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_PENDING";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_CONFIRM_TRANSPORT_FAILURE";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_CONFIRMED";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_REJECTED";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
      readonly error: string;
    }
  | {
      readonly type: "RECORD_POLL_TIMEOUT";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_READ_BACK_VERIFIED";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
      readonly read: string;
    }
  | {
      readonly type: "RECORD_READ_BACK_MISMATCH";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
    }
  | {
      readonly type: "RECORD_FINAL_VERIFICATION";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
    };
