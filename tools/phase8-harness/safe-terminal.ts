export interface Phase8TerminalSink {
  readonly isTTY?: boolean;
  write(value: string): unknown;
}

export class Phase8OutputCollisionError extends Error {
  constructor(message = "PHASE8_OUTPUT_COLLISION") {
    super(message);
    this.name = "Phase8OutputCollisionError";
  }
}

export class Phase8CliSafeWriter {
  readonly #stdout: Phase8TerminalSink;
  readonly #stderr: Phase8TerminalSink;
  readonly #sensitiveValues: readonly string[];

  constructor(input: {
    readonly stdout: Phase8TerminalSink;
    readonly stderr: Phase8TerminalSink;
    readonly sensitiveValues: readonly string[];
  }) {
    this.#stdout = input.stdout;
    this.#stderr = input.stderr;
    this.#sensitiveValues = Object.freeze(input.sensitiveValues.filter((value) => value.length > 0));
  }

  assertSafe(value: string): void {
    if (this.#sensitiveValues.some((secret) => value.includes(secret))) {
      throw new Phase8OutputCollisionError("PHASE8_CLI_OUTPUT_COLLISION");
    }
  }

  preflight(values: readonly string[]): void {
    for (const value of values) this.assertSafe(value);
  }

  writeStdout(value: string): unknown {
    this.assertSafe(value);
    return this.#stdout.write(value);
  }

  writeStderr(value: string): unknown {
    this.assertSafe(value);
    return this.#stderr.write(value);
  }
}
