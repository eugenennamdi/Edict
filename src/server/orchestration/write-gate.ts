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

export function createPreparationOnlyBrickkenWriteGate(enabled: boolean): BrickkenWriteGate {
  return Object.freeze({
    assertEnabled(action: BrickkenWriteAction): void {
      if (!enabled || action !== "PREPARE") throw new BrickkenWritesDisabledError();
    },
  });
}

export const disabledBrickkenWriteGate: BrickkenWriteGate = Object.freeze({
  assertEnabled() {
    throw new BrickkenWritesDisabledError();
  },
});
