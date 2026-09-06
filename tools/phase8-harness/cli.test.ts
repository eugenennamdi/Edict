import { describe, expect, it, vi } from "vitest";
import { OneTimeBootstrapVerifier } from "./auth";
import {
  PHASE8_ARGUMENT_ERROR_OUTPUT,
  PHASE8_START_ERROR_OUTPUT,
  runBrickkenReadHarnessMain,
} from "./brickken-read-cli";
import { PHASE8_BOOTSTRAP_OUTPUT_PREFIX, runPhase8HarnessCli } from "./cli";
import { PHASE8_HARNESS_PAGE } from "./public-output";
import { Phase8CliSafeWriter } from "./safe-terminal";

const SAFE_KEY = "offline-cli-key-with-no-public-overlap";

function environment(apiKey = SAFE_KEY) {
  return {
    EDICT_PHASE8_MODE: "sandbox",
    EDICT_PHASE8_HOST: "127.0.0.1",
    EDICT_PHASE8_PORT: "43119",
    EDICT_PHASE8_ACTION: "BRICKKEN_READ",
    EDICT_PHASE8_RUN_ID: "run-cli-boundary-1",
    EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
    BRICKKEN_API_KEY: apiKey,
  };
}

function terminal() {
  const values: string[] = [];
  return {
    values,
    sink: { isTTY: true, write: (value: string) => values.push(value) },
  };
}

describe("Phase 8 centralized CLI safe writer", () => {
  it.each([
    ["Edict", "Edict", "Edict Phase 8"],
    ["bootstrap banner", PHASE8_BOOTSTRAP_OUTPUT_PREFIX, PHASE8_BOOTSTRAP_OUTPUT_PREFIX],
    ["start failure", "PHASE8_CLI_START_FAILED", PHASE8_START_ERROR_OUTPUT],
    ["argument failure", "PHASE8_ARGUMENTS_REFUSED", PHASE8_ARGUMENT_ERROR_OUTPUT],
    ["startup", "startup", "Phase 8 harness startup complete"],
    ["success", "BRICKKEN_READ", '{"ok":true,"category":"BRICKKEN_READ"}'],
    ["failure", "ACTION_FAILED", '{"ok":false,"error":{"code":"ACTION_FAILED"}}'],
    ["server address", "127.0.0.1", "Harness listening at http://127.0.0.1:43119"],
    ["one character", "E", "E"],
    ["short value", "CLI", "CLI"],
    ["long value", "x".repeat(512), `prefix-${"x".repeat(512)}-suffix`],
    ["run ID", "run-cli-boundary-1", "run-cli-boundary-1"],
    ["operation", "TOKENIZE", "TOKENIZE"],
  ])("refuses an API key contained in %s output", (_label, secret, output) => {
    const stdout = terminal();
    const stderr = terminal();
    const writer = new Phase8CliSafeWriter({
      stdout: stdout.sink,
      stderr: stderr.sink,
      sensitiveValues: [secret],
    });
    expect(() => writer.writeStdout(output)).toThrow("PHASE8_CLI_OUTPUT_COLLISION");
    expect(() => writer.writeStderr(output)).toThrow("PHASE8_CLI_OUTPUT_COLLISION");
    expect(stdout.values).toEqual([]);
    expect(stderr.values).toEqual([]);
  });

  it.each([
    ["Edict", "Edict"],
    ["csrf token key", "csrfToken"],
    ["bootstrap label", "One-time bootstrap secret"],
    ["session key", "bootstrapSecret"],
    ["Arm key", "grantId"],
    ["Execute key", "confirmation"],
    ["action error code", "ACTION_FAILED"],
    ["argument error code", "PHASE8_ARGUMENTS_REFUSED"],
    ["startup error code", "PHASE8_CLI_START_FAILED"],
    ["evidence key", "resultFingerprint"],
    ["HTML response header", "nosniff"],
    ["default JSON header", "no-store"],
    ["cookie attribute", "HttpOnly"],
    ["cookie fragment", "; Path=/; HttpOnly; SameSite=Strict"],
    ["serialized evidence field", '"harnessVersion":"1.0"'],
    ["adjacent evidence fields", '"evidenceVersion":"1.0","harnessVersion":"1.0"'],
    ["serialized error", '"error":{"code":"ACTION_FAILED"}'],
    ["page text", "Authenticate to reveal"],
    ["action name", "BRICKKEN_READ"],
    ["one character", "E"],
    ["short string", "csrf"],
    ["long string", PHASE8_HARNESS_PAGE.split("\n")[1]!],
  ])("fails silently before every construction boundary for %s", async (_label, apiKey) => {
    const stdout = terminal();
    const stderr = terminal();
    const bootstrapFactory = vi.fn();
    const runtimeFactory = vi.fn();
    const serverStarter = vi.fn();
    const executorFactory = vi.fn();
    const harnessRunner = vi.fn(async () => {
      bootstrapFactory();
      runtimeFactory();
      serverStarter();
      executorFactory();
      throw new Error("must not construct");
    });
    const fetch = vi.fn(async () => { throw new Error("must not request"); });

    await expect(runBrickkenReadHarnessMain({
      argv: ["node", "cli"],
      environment: environment(apiKey),
      stdout: stdout.sink,
      stderr: stderr.sink,
      harnessRunner,
      executorDependencies: { fetch },
      harnessDependencies: {
        bootstrapFactory,
        runtimeFactory: runtimeFactory as never,
        serverStarter: serverStarter as never,
      },
    })).resolves.toBe(1);

    expect(stdout.values).toEqual([]);
    expect(stderr.values).toEqual([]);
    expect(harnessRunner).not.toHaveBeenCalled();
    expect(bootstrapFactory).not.toHaveBeenCalled();
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(serverStarter).not.toHaveBeenCalled();
    expect(executorFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["run ID", { BRICKKEN_API_KEY: "run-cli-boundary-1" }],
    ["operation", { BRICKKEN_API_KEY: "TOKENIZE" }],
  ])("rejects %s collisions before bootstrap, runtime, or server construction", async (_label, patch) => {
    const output = terminal();
    const bootstrapFactory = vi.fn();
    const runtimeFactory = vi.fn();
    const serverStarter = vi.fn();
    const executorFactory = vi.fn();

    await expect(runPhase8HarnessCli({
      environment: { ...environment(), ...patch },
      terminal: output.sink,
      bootstrapFactory,
      runtimeFactory,
      serverStarter,
      executorFactory,
    })).rejects.toThrow("PHASE8_PUBLIC_METADATA_COLLISION");

    expect(output.values).toEqual([]);
    expect(bootstrapFactory).not.toHaveBeenCalled();
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(serverStarter).not.toHaveBeenCalled();
    expect(executorFactory).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects header collisions silently with invalid arguments=%s", async (invalidArguments) => {
    const stdout = terminal();
    const stderr = terminal();
    const bootstrapFactory = vi.fn();
    const runtimeFactory = vi.fn();
    const serverStarter = vi.fn();
    const fetch = vi.fn();
    await expect(runBrickkenReadHarnessMain({
      argv: invalidArguments ? ["node", "cli", "extra"] : ["node", "cli"],
      environment: environment("nosniff"), stdout: stdout.sink, stderr: stderr.sink,
      executorDependencies: { fetch },
      harnessDependencies: { bootstrapFactory, runtimeFactory, serverStarter },
    })).resolves.toBe(1);
    expect([...stdout.values, ...stderr.values]).toEqual([]);
    for (const boundary of [bootstrapFactory, runtimeFactory, serverStarter, fetch]) expect(boundary).not.toHaveBeenCalled();
  });

  it("keeps noncolliding argument and startup failures stable and sanitized", async () => {
    const argumentOut = terminal();
    const argumentErr = terminal();
    const runner = vi.fn();
    await expect(runBrickkenReadHarnessMain({
      argv: ["node", "cli", "extra"],
      environment: environment(),
      stdout: argumentOut.sink,
      stderr: argumentErr.sink,
      harnessRunner: runner,
    })).resolves.toBe(1);
    expect(argumentOut.values).toEqual([]);
    expect(argumentErr.values).toEqual([PHASE8_ARGUMENT_ERROR_OUTPUT]);
    expect(runner).not.toHaveBeenCalled();

    const startupOut = terminal();
    const startupErr = terminal();
    await expect(runBrickkenReadHarnessMain({
      argv: ["node", "cli"],
      environment: environment(),
      stdout: startupOut.sink,
      stderr: startupErr.sink,
      harnessRunner: async () => { throw new Error("sensitive upstream detail"); },
    })).resolves.toBe(1);
    expect(startupOut.values).toEqual([]);
    expect(startupErr.values).toEqual([PHASE8_START_ERROR_OUTPUT]);
    expect(startupErr.values.join("")).not.toContain("sensitive upstream detail");
  });

  it("preserves the one-time interactive bootstrap flow for safe configuration", async () => {
    const output = terminal();
    const bootstrapSecret = "offline-generated-bootstrap-secret-at-least-32-characters";
    const clock = { nowMs: () => 1_000 };
    const executorFactory = vi.fn();
    const runtimeFactory = vi.fn((value) => ({ value, stopped: false }));
    const server = { close: async () => undefined, address: { address: "127.0.0.1", port: 43119 } };
    const serverStarter = vi.fn(async () => server);

    await expect(runPhase8HarnessCli({
      environment: environment(),
      terminal: output.sink,
      clock,
      bootstrapFactory: vi.fn(() => ({
        secret: bootstrapSecret,
        verifier: new OneTimeBootstrapVerifier(bootstrapSecret, clock),
      })),
      runtimeFactory: runtimeFactory as never,
      serverStarter: serverStarter as never,
      executorFactory,
    })).resolves.toBe(server);

    expect(output.values).toEqual([`${PHASE8_BOOTSTRAP_OUTPUT_PREFIX}${bootstrapSecret}\n`]);
    expect(runtimeFactory).toHaveBeenCalledOnce();
    expect(serverStarter).toHaveBeenCalledOnce();
    expect(executorFactory).not.toHaveBeenCalled();
  });
});
