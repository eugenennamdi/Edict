import "server-only";

export type BrickkenWriteAction = "CONFIRM_BROADCAST" | "PREPARE";

export class BrickkenWritesDisabledError extends Error {
  readonly code = "BRICKKEN_WRITES_DISABLED";

  constructor() {
    super("Brickken write execution is disabled.");
    this.name = "BrickkenWritesDisabledError";
  }
}

export interface BrickkenWriteGate {
  assertEnabled(action: BrickkenWriteAction): void;
}

export const disabledBrickkenWriteGate: BrickkenWriteGate = Object.freeze({
  assertEnabled() {
    throw new BrickkenWritesDisabledError();
  },
});
