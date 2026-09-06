import { PHASE8_ACTIONS, PHASE8_OPERATIONS, type Phase8Action, type Phase8HarnessConfig } from "./types";
import { PHASE8_STATIC_PUBLIC_OUTPUTS } from "./public-output";
import { Phase8OutputCollisionError } from "./safe-terminal";

export type Phase8EnvironmentSource = Readonly<Record<string, string | undefined>>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

export function assertNoSensitivePublicCollision(
  publicValues: readonly string[],
  sensitiveValues: readonly string[],
): void {
  for (const sensitive of sensitiveValues) {
    if (
      sensitive.length === 0 ||
      publicValues.some((value) => value.includes(sensitive) || sensitive.includes(value))
    ) {
      throw new Phase8OutputCollisionError("PHASE8_PUBLIC_METADATA_COLLISION");
    }
  }
}

export function assertNoSensitiveOutputCollision(
  publicValues: readonly string[],
  sensitiveValues: readonly string[],
): void {
  for (const sensitive of sensitiveValues) {
    if (sensitive.length === 0 || publicValues.some((value) => value.includes(sensitive))) {
      throw new Phase8OutputCollisionError("PHASE8_PUBLIC_METADATA_COLLISION");
    }
  }
}

export function assertPhase8PublicMetadataSafe(
  config: Phase8HarnessConfig,
  additionalPublicValues: readonly string[] = [],
): void {
  const authority = config.host === "::1" ? `[::1]:${config.port}` : `${config.host}:${config.port}`;
  assertNoSensitivePublicCollision([
    config.mode,
    config.host,
    String(config.port),
    authority,
    `http://${authority}`,
    config.target.action,
    config.target.runId,
    config.target.operation,
    ...(config.target.walletRequestHash === null ? [] : [config.target.walletRequestHash]),
    JSON.stringify(config.target),
    ...additionalPublicValues,
  ], Object.values(config.allowedEnvironment));
}

const ACTION_ENVIRONMENT: Readonly<Record<Phase8Action, readonly string[]>> = Object.freeze({
  BRICKKEN_READ: ["BRICKKEN_API_KEY"],
  BRICKKEN_PREPARE: ["DATABASE_URL", "BRICKKEN_API_KEY"],
  WALLET_APPROVAL: ["DATABASE_URL"],
  WALLET_SEND: ["DATABASE_URL"],
  RPC_TRANSACTION_COMPARE: ["DATABASE_URL", "EDICT_SEPOLIA_RPC_URL"],
  BRICKKEN_CONFIRM: ["DATABASE_URL", "BRICKKEN_API_KEY"],
  BRICKKEN_POLL: ["DATABASE_URL", "BRICKKEN_API_KEY"],
  RPC_FINALITY: ["DATABASE_URL", "EDICT_SEPOLIA_RPC_URL"],
  BRICKKEN_READ_BACK: ["DATABASE_URL", "BRICKKEN_API_KEY"],
});

function required(source: Phase8EnvironmentSource, name: string, maximum: number): string {
  const value = source[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error("PHASE8_CONFIGURATION_INVALID");
  }
  return value;
}

function action(value: string): Phase8Action {
  if (!PHASE8_ACTIONS.includes(value as Phase8Action)) throw new Error("PHASE8_CONFIGURATION_INVALID");
  return value as Phase8Action;
}

export function readPhase8HarnessConfig(source: Phase8EnvironmentSource): Phase8HarnessConfig {
  if (required(source, "EDICT_PHASE8_MODE", 16) !== "sandbox") {
    throw new Error("PHASE8_PRODUCTION_REFUSED");
  }
  const host = required(source, "EDICT_PHASE8_HOST", 45);
  if (!LOOPBACK.has(host)) throw new Error("PHASE8_LOOPBACK_REQUIRED");
  const rawPort = required(source, "EDICT_PHASE8_PORT", 5);
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65_535) {
    throw new Error("PHASE8_CONFIGURATION_INVALID");
  }
  const selectedAction = action(required(source, "EDICT_PHASE8_ACTION", 64));
  const runId = required(source, "EDICT_PHASE8_RUN_ID", 128);
  if (!RUN_ID.test(runId)) throw new Error("PHASE8_CONFIGURATION_INVALID");
  const operation = required(source, "EDICT_PHASE8_OPERATION_KIND", 16);
  if (!PHASE8_OPERATIONS.includes(operation as (typeof PHASE8_OPERATIONS)[number])) {
    throw new Error("PHASE8_CONFIGURATION_INVALID");
  }
  const requestHash = source.EDICT_PHASE8_WALLET_REQUEST_HASH;
  const hashRequired = selectedAction === "WALLET_SEND" || selectedAction === "RPC_TRANSACTION_COMPARE";
  if ((hashRequired && (typeof requestHash !== "string" || !HASH.test(requestHash))) ||
      (!hashRequired && requestHash !== undefined)) {
    throw new Error("PHASE8_CONFIGURATION_INVALID");
  }

  const allowedEnvironment: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of ACTION_ENVIRONMENT[selectedAction]) {
    allowedEnvironment[name] = required(source, name, 8_192);
  }
  const config = Object.freeze({
    mode: "sandbox",
    host: host as "127.0.0.1" | "::1",
    port: Number(rawPort),
    target: Object.freeze({
      action: selectedAction,
      runId,
      operation: operation as (typeof PHASE8_OPERATIONS)[number],
      walletRequestHash: hashRequired ? requestHash as `sha256:${string}` : null,
    }),
    allowedEnvironment: Object.freeze(allowedEnvironment),
  });
  assertPhase8PublicMetadataSafe(config);
  assertNoSensitiveOutputCollision(
    PHASE8_STATIC_PUBLIC_OUTPUTS,
    Object.values(config.allowedEnvironment),
  );
  return config;
}

export function expectedHarnessOrigin(config: Phase8HarnessConfig): string {
  const authority = config.host === "::1" ? `[::1]:${config.port}` : `${config.host}:${config.port}`;
  return `http://${authority}`;
}
