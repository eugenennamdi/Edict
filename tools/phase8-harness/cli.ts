import { createBootstrapSecret, type HarnessClock } from "./auth";
import { readPhase8HarnessConfig, type Phase8EnvironmentSource } from "./config";
import { Phase8HarnessRuntime } from "./runtime";
import { Phase8CliSafeWriter, type Phase8TerminalSink } from "./safe-terminal";
import { startPhase8HarnessServer } from "./server";
import type { Phase8ActionExecutor } from "./types";

export type InteractiveTerminal = Phase8TerminalSink;

export const PHASE8_BOOTSTRAP_OUTPUT_PREFIX = "Edict Phase 8 one-time bootstrap secret: ";

export async function runPhase8HarnessCli(input: {
  readonly environment: Phase8EnvironmentSource;
  readonly executorFactory: () => Phase8ActionExecutor;
  readonly terminal: InteractiveTerminal;
  readonly clock?: HarnessClock;
  readonly bootstrapFactory?: typeof createBootstrapSecret;
  readonly runtimeFactory?: (value: ConstructorParameters<typeof Phase8HarnessRuntime>[0]) => Phase8HarnessRuntime;
  readonly serverStarter?: typeof startPhase8HarnessServer;
}) {
  if (input.terminal.isTTY !== true) throw new Error("PHASE8_INTERACTIVE_TTY_REQUIRED");
  const config = readPhase8HarnessConfig(input.environment);
  const safeWriter = new Phase8CliSafeWriter({
    stdout: input.terminal,
    stderr: input.terminal,
    sensitiveValues: Object.values(config.allowedEnvironment),
  });
  safeWriter.preflight([PHASE8_BOOTSTRAP_OUTPUT_PREFIX]);
  const clock = input.clock ?? { nowMs: () => Date.now() };
  const bootstrap = (input.bootstrapFactory ?? createBootstrapSecret)(clock);
  safeWriter.writeStdout(`${PHASE8_BOOTSTRAP_OUTPUT_PREFIX}${bootstrap.secret}\n`);
  const runtime = (input.runtimeFactory ?? ((value) => new Phase8HarnessRuntime(value)))({
    config,
    bootstrap: bootstrap.verifier,
    executorFactory: input.executorFactory,
    clock,
  });
  return (input.serverStarter ?? startPhase8HarnessServer)(
    runtime,
    { host: config.host, port: config.port },
  );
}
