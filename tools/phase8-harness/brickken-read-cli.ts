import "server-only";

import { pathToFileURL } from "node:url";
import { createBrickkenReadExecutor, type BrickkenReadExecutorDependencies } from "./brickken-read-executor";
import { runPhase8HarnessCli, type InteractiveTerminal } from "./cli";
import type { Phase8EnvironmentSource } from "./config";

type HarnessRunner = typeof runPhase8HarnessCli;

export function narrowBrickkenReadCliEnvironment(
  source: Phase8EnvironmentSource,
): Phase8EnvironmentSource {
  return Object.freeze({
    EDICT_PHASE8_MODE: "sandbox",
    EDICT_PHASE8_HOST: source.EDICT_PHASE8_HOST,
    EDICT_PHASE8_PORT: source.EDICT_PHASE8_PORT,
    EDICT_PHASE8_ACTION: "BRICKKEN_READ",
    EDICT_PHASE8_RUN_ID: source.EDICT_PHASE8_RUN_ID,
    EDICT_PHASE8_OPERATION_KIND: source.EDICT_PHASE8_OPERATION_KIND,
    BRICKKEN_API_KEY: source.BRICKKEN_API_KEY,
  });
}

export async function runBrickkenReadHarnessCli(input: {
  readonly environment: Phase8EnvironmentSource;
  readonly terminal: InteractiveTerminal;
  readonly executorDependencies?: BrickkenReadExecutorDependencies;
  readonly harnessRunner?: HarnessRunner;
}) {
  const environment = narrowBrickkenReadCliEnvironment(input.environment);
  const harnessRunner = input.harnessRunner ?? runPhase8HarnessCli;
  return harnessRunner({
    environment,
    terminal: input.terminal,
    executorFactory: () => createBrickkenReadExecutor(input.executorDependencies),
  });
}

function processEnvironment(): Phase8EnvironmentSource {
  return Object.freeze({
    EDICT_PHASE8_HOST: process.env.EDICT_PHASE8_HOST,
    EDICT_PHASE8_PORT: process.env.EDICT_PHASE8_PORT,
    EDICT_PHASE8_RUN_ID: process.env.EDICT_PHASE8_RUN_ID,
    EDICT_PHASE8_OPERATION_KIND: process.env.EDICT_PHASE8_OPERATION_KIND,
    BRICKKEN_API_KEY: process.env.BRICKKEN_API_KEY,
  });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  if (process.argv.length !== 2) {
    process.stderr.write('{"ok":false,"error":{"code":"PHASE8_ARGUMENTS_REFUSED"}}\n');
    process.exitCode = 1;
  } else {
    void runBrickkenReadHarnessCli({
      environment: processEnvironment(),
      terminal: process.stdout,
    }).catch(() => {
      process.stderr.write('{"ok":false,"error":{"code":"PHASE8_CLI_START_FAILED"}}\n');
      process.exitCode = 1;
    });
  }
}
