import type {
  OnchainTransactionEvidenceV1,
  TransactionReceiptEvidenceV1,
} from "./onchain-evidence";
import type {
  FeeAuthorizationV1,
  ImmutableExecutionIdentityV1,
  WalletExecutionIntentV1,
} from "@/shared/wallet/execution-authorization";

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
  | "BROADCAST_UNKNOWN"
  | "PREPARED_STALE"
  | "REPREPARE_INTENT"
  | "RPC_TRANSACTION_VERIFIED"
  | "POLICY_VIOLATION_ONCHAIN"
  | "RPC_TRANSACTION_RECONCILIATION_REQUIRED"
  | "BRICKKEN_CORRELATION_PENDING"
  | "BRICKKEN_CORRELATED";

export type OperationStageV4 = OperationStage;

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

export interface ApprovalRecordV1 {
  readonly planHash: string;
  readonly approvedByWallet: string;
  readonly approvedAt: IsoUtcTimestamp;
  readonly approvalRevision: number;
}

export interface ApprovalProofV1 {
  readonly scheme: "EIP712_EOA";
  readonly proofVersion: "1.0";
  readonly domainVersion: "1";
  readonly runId: string;
  readonly manifestHash: string;
  readonly planHash: string;
  readonly environment: "sandbox";
  readonly chainId: "11155111";
  readonly approvalRevision: number;
  readonly requiredSigner: string;
  readonly recoveredSigner: string;
  readonly challengeNonce: string;
  readonly issuedAt: IsoUtcTimestamp;
  readonly expiresAt: IsoUtcTimestamp;
  readonly verifiedAt: IsoUtcTimestamp;
  readonly typedDataDigest: string;
  readonly publicSignature: string;
}

export interface ApprovalRecordV2 extends ApprovalRecordV1 {
  readonly proof: ApprovalProofV1;
}

export type ApprovalRecord = ApprovalRecordV1 | ApprovalRecordV2;

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

export interface WriteOperationV3 extends WriteOperation {
  readonly onchainTransactionEvidence: OnchainTransactionEvidenceV1 | null;
  readonly transactionReceiptEvidence: TransactionReceiptEvidenceV1 | null;
}

export interface PreparationAttemptV1 {
  readonly attemptId: string;
  readonly sequence: number;
  readonly state: "PREPARED" | "STALE" | "REPREPARE_INTENT" | "PREPARE_UNKNOWN" | "REFUSED";
  readonly txId: string | null;
  readonly unsignedTransaction: Record<string, unknown> | null;
  readonly preparationFingerprint: string | null;
  readonly immutableIdentity: ImmutableExecutionIdentityV1 | null;
  readonly feeAuthorization: FeeAuthorizationV1 | null;
  readonly preparedAt: IsoUtcTimestamp | null;
  readonly preparedRunRevision: number | null;
  readonly freshnessPolicyVersion: string;
  readonly freshnessEvaluatedAt: IsoUtcTimestamp | null;
  readonly nonceFreshnessEvidence: NonceFreshnessEvidenceV1 | null;
  readonly staleAt: IsoUtcTimestamp | null;
  readonly staleReason: "NONCE_MISMATCH" | null;
}

export interface NonceFreshnessEvidenceV1 {
  readonly evidenceVersion: "1.0";
  readonly policyVersion: string;
  readonly authority: "TRUSTED_SERVER_RPC";
  readonly rpcMethod: "eth_getTransactionCount";
  readonly blockTag: "pending";
  readonly chainId: "11155111";
  readonly requiredSigner: string;
  readonly preparedNonce: string;
  readonly observedPendingNonce: string;
  readonly status: "FRESH" | "STALE";
  readonly observedAt: IsoUtcTimestamp;
}

export interface WalletPromptAuthorizationRecordV1 {
  readonly authorizationVersion: "1.0";
  readonly walletIntent: WalletExecutionIntentV1;
  readonly walletIntentHash: string;
  readonly providerInvocation: "PROVEN_NOT_INVOKED" | "INVOKED_OR_UNKNOWN";
  readonly invocationAttemptId: string | null;
  readonly authorityReleasedAt: IsoUtcTimestamp | null;
  readonly unresolvedOutcome:
    | "BROWSER_DISAPPEARED"
    | "CLIENT_CLAIMED_NOT_INVOKED"
    | "PROVIDER_4001"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_ERROR"
    | "HASH_PERSISTENCE_UNCONFIRMED"
    | null;
  readonly unresolvedAt: IsoUtcTimestamp | null;
  readonly recordedAt: IsoUtcTimestamp;
}

export interface RpcTransactionAuthorizationEvidenceV1 {
  readonly evidenceVersion: "1.0";
  readonly observedAt: IsoUtcTimestamp;
  readonly transactionHash: string;
  readonly immutableIdentity: Omit<ImmutableExecutionIdentityV1, "chainId"> & {
    readonly chainId: string;
  };
  readonly immutableIdentityStatus: "MATCH" | "MISMATCH";
  readonly feeAuthorizationStatus: "WITHIN_ENVELOPE" | "POLICY_VIOLATION" | "NOT_EVALUATED";
  readonly feePolicyViolationCode:
    | "LEGACY_GAS_PRICE"
    | "FEE_MODEL_CHANGED"
    | "ACCESS_LIST_CHANGED"
    | "GAS_LIMIT_CAP_EXCEEDED"
    | "MAX_FEE_CAP_EXCEEDED"
    | "PRIORITY_FEE_CAP_EXCEEDED"
    | "NETWORK_FEE_CAP_EXCEEDED"
    | "INVALID_FEE_EVIDENCE"
    | null;
  readonly observedMaximumNetworkFeeWei: string | null;
}

export interface BrickkenCorrelationAttemptV1 {
  readonly attempt: number;
  readonly authorizedAt: IsoUtcTimestamp;
  readonly result: "AUTHORIZED" | "TEMPORARILY_NOT_FOUND" | "TRANSPORT_UNKNOWN";
}

export interface BrickkenCorrelationV1 {
  readonly correlationVersion: "1.0";
  readonly pair: { readonly txId: string; readonly txHash: string };
  readonly lifecycle: "PENDING" | "CORRELATED";
  readonly attempts: readonly BrickkenCorrelationAttemptV1[];
  readonly correlatedAt: IsoUtcTimestamp | null;
}

export interface BrickkenStatusEvidenceV1 {
  readonly evidenceVersion: "1.0";
  readonly observedAt: IsoUtcTimestamp;
  readonly txId: string;
  readonly txHash: string;
  readonly status: "pending" | "success" | "rejected";
}

export interface TokenIdentityV1 {
  readonly identityVersion: "1.0";
  readonly chainId: "11155111";
  readonly tokenAddress: string;
  readonly tokenSymbol: string;
  readonly tokenizerWalletAddress: string;
  readonly tokenizationTxHash: string;
  readonly manifestHash: string;
  readonly planHash: string;
  readonly verifiedAt: IsoUtcTimestamp;
  readonly readBackEvidenceHash: string;
}

export interface WriteOperationV4 extends Omit<WriteOperationV3, "stage"> {
  readonly stage: OperationStageV4;
  readonly preparationAttempts: readonly PreparationAttemptV1[];
  readonly activePreparationAttemptId: string | null;
  readonly walletPromptAuthorization: WalletPromptAuthorizationRecordV1 | null;
  readonly rpcTransactionEvidence: RpcTransactionAuthorizationEvidenceV1 | null;
  readonly brickkenCorrelation: BrickkenCorrelationV1 | null;
  readonly brickkenStatusEvidence: readonly BrickkenStatusEvidenceV1[];
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
  readonly approval: ApprovalRecordV1 | null;
  readonly operations: readonly [WriteOperation, WriteOperation, WriteOperation];
  readonly observations: readonly ObservationRecord[];
  readonly events: readonly AuditEvent[];
  readonly receiptEligible: boolean;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
  readonly revision: number;
}

export interface ExecutionRunV2 extends Omit<ExecutionRunV1, "schemaVersion" | "approval"> {
  readonly schemaVersion: "2.0";
  readonly approval: ApprovalRecordV2 | null;
}

export interface ExecutionRunV3 extends Omit<ExecutionRunV1, "schemaVersion" | "approval" | "operations"> {
  readonly schemaVersion: "3.0";
  readonly approval: ApprovalRecord | null;
  readonly operations: readonly [WriteOperationV3, WriteOperationV3, WriteOperationV3];
}

export interface ExecutionRunV4 extends Omit<ExecutionRunV1, "schemaVersion" | "approval" | "operations"> {
  readonly schemaVersion: "4.0";
  readonly approval: ApprovalRecordV2;
  readonly operations: readonly [WriteOperationV4, WriteOperationV4, WriteOperationV4];
  readonly tokenIdentity: TokenIdentityV1 | null;
}

export type ExecutionRun = ExecutionRunV1 | ExecutionRunV2 | ExecutionRunV3 | ExecutionRunV4;

export type ExecutionRunEvent =
  | {
      readonly type: "APPROVE_PLAN";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly planHash: string;
      readonly approvedByWallet: string;
      readonly proof: ApprovalProofV1;
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
      readonly type: "RECORD_ONCHAIN_TRANSACTION_EVIDENCE";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
      readonly evidence: OnchainTransactionEvidenceV1;
    }
  | {
      readonly type: "RECORD_TRANSACTION_RECEIPT_EVIDENCE";
      readonly id: string;
      readonly at: IsoUtcTimestamp;
      readonly operationKind: OperationKind;
      readonly evidence: TransactionReceiptEvidenceV1;
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
