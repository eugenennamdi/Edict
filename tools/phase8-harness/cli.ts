import type { Writable } from "node:stream";
import { createBootstrapSecret, type HarnessClock } from "./auth";
import { readPhase8HarnessConfig, type Phase8EnvironmentSource } from "./config";
import { Phase8HarnessRuntime } from "./runtime";
import { startPhase8HarnessServer } from "./server";
import type { Phase8ActionExecutor } from "./types";

export interface InteractiveTerminal extends Pick<Writable, "write"> {
  readonly isTTY?: boolean;
}

export async function runPhase8HarnessCli(input: {
  readonly environment: Phase8EnvironmentSource;
  readonly executorFactory: () => Phase8ActionExecutor;
  readonly terminal: InteractiveTerminal;
  readonly clock?: HarnessClock;
}) {
  if (input.terminal.isTTY !== true) throw new Error("PHASE8_INTERACTIVE_TTY_REQUIRED");
  const config = readPhase8HarnessConfig(input.environment);
  const clock = input.clock ?? { nowMs: () => Date.now() };
  const bootstrap = createBootstrapSecret(clock);
  input.terminal.write(`Edict Phase 8 one-time bootstrap secret: ${bootstrap.secret}\n`);
  const runtime = new Phase8HarnessRuntime({
    config,
    bootstrap: bootstrap.verifier,
    executorFactory: input.executorFactory,
    clock,
  });
  return startPhase8HarnessServer(runtime, { host: config.host, port: config.port });
}
