import "server-only";

import { createBrickkenServerAdapter } from "../brickken";
import { ExecutionRunService, cryptoIdGenerator, systemClock } from "../execution";
import { getServerEnv } from "../env";
import {
  ExecutionOrchestrator,
  ExecutionV4Orchestrator,
  createProductionSemanticAuthorizationEvaluator,
  createPreparationOnlyBrickkenWriteGate,
} from "../orchestration";
import { createNeonExecutionRunRepository } from "../persistence";
import {
  createProductionSepoliaRpcTransport,
  createTrustedSepoliaRpcClient,
} from "../rpc";
import {
  RunAccessService,
  WalletApprovalService,
  createSecurityTokenMac,
  cryptoNonceSource,
  systemTokenClock,
} from "../security";
import type { SemanticAuthorizationEvaluator } from "../orchestration";

export interface RunApiRuntime {
  readonly runs: ExecutionRunService;
  readonly access: RunAccessService;
  readonly approvals: WalletApprovalService;
  readonly execution?: Pick<ExecutionOrchestrator, "prepareNextOperation">;
  readonly walletExecution?: Pick<
    ExecutionV4Orchestrator,
    | "releaseSendAuthority"
    | "ingestBroadcastHash"
    | "recordBrowserBroadcastUnknown"
    | "promotePreparedRunToV4"
    | "evaluateAndApplyPreparedFreshness"
    | "trackExecution"
  >;
  readonly nowIso: () => string;
}

export function createRuntimeSemanticAuthorization(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SemanticAuthorizationEvaluator {
  return createProductionSemanticAuthorizationEvaluator(environment);
}

/** Called only after the deny-by-default deployment gate has passed. */
export function createRunApiRuntime(): RunApiRuntime {
  const repository = createNeonExecutionRunRepository();
  const brickken = createBrickkenServerAdapter();
  const mac = createSecurityTokenMac();
  const runs = new ExecutionRunService({
    repository,
    clock: systemClock(),
    ids: cryptoIdGenerator(),
  });
  const preparationEnabled = getServerEnv().EDICT_TRANSACTION_PREPARATION_ENABLED === "1";
  const ids = cryptoIdGenerator();
  const clock = systemClock();
  return Object.freeze({
    runs,
    access: new RunAccessService({ mac, clock: systemTokenClock, nonces: cryptoNonceSource }),
    approvals: new WalletApprovalService({ mac, clock: systemTokenClock, nonces: cryptoNonceSource }),
    execution: new ExecutionOrchestrator({
      repository,
      runs,
      brickken,
      writeGate: createPreparationOnlyBrickkenWriteGate(preparationEnabled),
    }),
    walletExecution: new ExecutionV4Orchestrator({
      repository,
      clock,
      ids,
      rpc: createTrustedSepoliaRpcClient(createProductionSepoliaRpcTransport()),
      semanticAuthorization: createRuntimeSemanticAuthorization(),
      brickkenCorrelationSender: {
        async send(pair) {
          const result = await brickken.correlateClientBroadcast(pair);
          if (!result.ok) throw result.error;
          return result.value;
        },
      },
      brickkenStatusFetcher: {
        async fetch(locator) {
          const result = await brickken.getTransactionStatus(locator);
          if (!result.ok) throw result.error;
          return Object.freeze({
            httpStatus: result.value.httpStatus ?? 200,
            responseByteCount: result.value.responseByteCount ?? 0,
            contentType: result.value.contentType ?? "application/json",
            transactionHash: result.value.transactionHash,
            rawStatusText: result.value.status,
            diagnosticError: result.value.diagnosticError ?? result.value.error,
            error: result.value.diagnosticError ?? result.value.error,
          });
        },
      },
      brickkenReadBack: brickken,
    }),
    nowIso: () => new Date().toISOString(),
  });
}
