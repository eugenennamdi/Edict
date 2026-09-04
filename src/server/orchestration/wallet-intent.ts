import "server-only";

import {
  createWalletPromptEnvelopeV1,
  projectPreparedTransactionV1,
  type WalletPromptEnvelopeV1,
  type WalletSemanticPolicy,
} from "@/shared/wallet";
import type { ExecutionRun, OperationKind } from "../execution/types";
import { OrchestrationError } from "./errors";

function operationIndex(kind: OperationKind): 0 | 1 | 2 {
  if (kind === "TOKENIZE") return 0;
  if (kind === "WHITELIST") return 1;
  return 2;
}

export async function deriveWalletPromptEnvelopeFromRun(
  run: ExecutionRun,
  kind: OperationKind,
  semanticPolicy: WalletSemanticPolicy,
): Promise<WalletPromptEnvelopeV1> {
  const operation = run.operations[operationIndex(kind)];
  if (
    operation.kind !== kind ||
    operation.stage !== "WALLET_PROMPT_RECORDED" ||
    operation.preparedTxId === null ||
    operation.unsignedTransaction === null ||
    run.approval === null ||
    run.environment !== "sandbox" ||
    run.chainId !== "11155111"
  ) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  const normalized = projectPreparedTransactionV1(operation.unsignedTransaction);
  if (
    normalized.chainId !== "0xaa36a7" ||
    normalized.walletRequest.from !== run.requiredSigner.walletAddress
  ) {
    throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");
  }
  const semantic = semanticPolicy.authorize({
    operationKind: kind,
    chainId: run.chainId,
    walletRequest: normalized.walletRequest,
  });
  if (!semantic.allowed) throw new OrchestrationError("EXECUTION_INVARIANT_FAILED");

  return createWalletPromptEnvelopeV1({
    envelopeVersion: "1.0",
    runId: run.id,
    manifestHash: run.manifestHash as `sha256:${string}`,
    planHash: run.planHash as `sha256:${string}`,
    environment: run.environment,
    operation: Object.freeze({ id: operation.id, kind }),
    preparedTransactionId: operation.preparedTxId,
    requiredSigner: run.requiredSigner.walletAddress,
    chainId: run.chainId,
    promptRevision: run.revision,
    walletRequestVersion: "1.0",
    walletRequest: normalized.walletRequest,
    chainRequirement: Object.freeze({
      mode: "PROVIDER_PRECONDITION",
      decimalChainId: "11155111",
      rpcChainId: "0xaa36a7",
    }),
  });
}
