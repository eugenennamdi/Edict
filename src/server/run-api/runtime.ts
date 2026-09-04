import "server-only";

import { ExecutionRunService, cryptoIdGenerator, systemClock } from "../execution";
import { createNeonExecutionRunRepository } from "../persistence";
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
  readonly nowIso: () => string;
}

/** Called only after the deny-by-default deployment gate has passed. */
export function createRunApiRuntime(): RunApiRuntime {
  const repository = createNeonExecutionRunRepository();
  const mac = createSecurityTokenMac();
  return Object.freeze({
    runs: new ExecutionRunService({ repository, clock: systemClock(), ids: cryptoIdGenerator() }),
    access: new RunAccessService({ mac, clock: systemTokenClock, nonces: cryptoNonceSource }),
    approvals: new WalletApprovalService({ mac, clock: systemTokenClock, nonces: cryptoNonceSource }),
    nowIso: () => new Date().toISOString(),
  });
}
