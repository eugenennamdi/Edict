import "server-only";

import { pathToFileURL } from "node:url";
import { createBrickkenReadExecutor, type BrickkenReadExecutorDependencies } from "./brickken-read-executor";
import {
  runPhase8HarnessCli,
  type InteractiveTerminal,
} from "./cli";
import type { Phase8EnvironmentSource } from "./config";
import {
  PHASE8_ARGUMENT_ERROR_OUTPUT,
  PHASE8_START_ERROR_OUTPUT,
  PHASE8_STATIC_PUBLIC_OUTPUTS,
} from "./public-output";
import {
  Phase8CliSafeWriter,
  Phase8OutputCollisionError,
  type Phase8TerminalSink,
} from "./safe-terminal";

type HarnessRunner = typeof runPhase8HarnessCli;
type HarnessLifecycleDependencies = Pick<
  Parameters<HarnessRunner>[0],
  "clock" | "bootstrapFactory" | "runtimeFactory" | "serverStarter"
>;

export { PHASE8_ARGUMENT_ERROR_OUTPUT, PHASE8_START_ERROR_OUTPUT } from "./public-output";

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
  readonly harnessDependencies?: HarnessLifecycleDependencies;
}) {
  const environment = narrowBrickkenReadCliEnvironment(input.environment);
  const sensitiveValues = typeof environment.BRICKKEN_API_KEY === "string"
    ? [environment.BRICKKEN_API_KEY]
    : [];
  const safeWriter = new Phase8CliSafeWriter({
    stdout: input.terminal,
    stderr: input.terminal,
    sensitiveValues,
  });
  safeWriter.preflight(PHASE8_STATIC_PUBLIC_OUTPUTS);
  const harnessRunner = input.harnessRunner ?? runPhase8HarnessCli;
  return harnessRunner({
    ...input.harnessDependencies,
    environment,
    terminal: input.terminal,
    executorFactory: () => createBrickkenReadExecutor(input.executorDependencies),
  });
}

export async function runBrickkenReadHarnessMain(input: {
  readonly argv: readonly string[];
  readonly environment: Phase8EnvironmentSource;
  readonly stdout: Phase8TerminalSink;
  readonly stderr: Phase8TerminalSink;
  readonly harnessRunner?: HarnessRunner;
  readonly executorDependencies?: BrickkenReadExecutorDependencies;
  readonly harnessDependencies?: HarnessLifecycleDependencies;
}): Promise<number> {
  const environment = narrowBrickkenReadCliEnvironment(input.environment);
  const sensitiveValues = typeof environment.BRICKKEN_API_KEY === "string"
    ? [environment.BRICKKEN_API_KEY]
    : [];
  const safeWriter = new Phase8CliSafeWriter({
    stdout: input.stdout,
    stderr: input.stderr,
    sensitiveValues,
  });
  try {
    safeWriter.preflight(PHASE8_STATIC_PUBLIC_OUTPUTS);
    if (input.argv.length !== 2) {
      safeWriter.writeStderr(PHASE8_ARGUMENT_ERROR_OUTPUT);
      return 1;
    }
    await runBrickkenReadHarnessCli({
      environment,
      terminal: input.stdout,
      harnessRunner: input.harnessRunner,
      executorDependencies: input.executorDependencies,
      harnessDependencies: input.harnessDependencies,
    });
    return 0;
  } catch (error) {
    if (error instanceof Phase8OutputCollisionError) return 1;
    try {
      safeWriter.writeStderr(PHASE8_START_ERROR_OUTPUT);
    } catch (fallbackError) {
      if (!(fallbackError instanceof Phase8OutputCollisionError)) throw fallbackError;
    }
    return 1;
  }
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
  void runBrickkenReadHarnessMain({
    argv: process.argv,
    environment: processEnvironment(),
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((exitCode) => { process.exitCode = exitCode; });
}
