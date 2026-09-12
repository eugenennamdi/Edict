import "server-only";

import { createBrickkenServerAdapter } from "../brickken";
import { ExecutionRunService, cryptoIdGenerator, systemClock } from "../execution";
import { getServerEnv } from "../env";
import {
  ExecutionOrchestrator,
  ExecutionV4Orchestrator,
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

/** Called only after the deny-by-default deployment gate has passed. */
export function createRunApiRuntime(): RunApiRuntime {
  const repository = createNeonExecutionRunRepository();
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
      brickken: createBrickkenServerAdapter(),
      writeGate: createPreparationOnlyBrickkenWriteGate(preparationEnabled),
    }),
    walletExecution: new ExecutionV4Orchestrator({
      repository,
      clock,
      ids,
      rpc: createTrustedSepoliaRpcClient(createProductionSepoliaRpcTransport()),
    }),
    nowIso: () => new Date().toISOString(),
  });
}
