import { describe, expect, it } from "vitest";
import { InvalidRunSnapshotError, PersistenceDataError } from "../execution/errors";
import { decodeExecutionRunV1, encodeExecutionRunV1 } from "./codec";
import { createExecutionRunFixture } from "./test-fixtures";

describe("execution run persistence codec", () => {
  it("backward-decodes legacy V1 snapshots while new runs use V2", async () => {
    const current = await createExecutionRunFixture();
    expect(current.schemaVersion).toBe("2.0");
    const legacy = { ...current, schemaVersion: "1.0" as const, approval: null };
    const decoded = decodeExecutionRunV1(encodeExecutionRunV1(legacy));
    expect(decoded.schemaVersion).toBe("1.0");
    expect(decoded.approval).toBeNull();
  });

  it("round-trips into a newly allocated deeply frozen snapshot", async () => {
    const run = await createExecutionRunFixture();
    const decoded = decodeExecutionRunV1(encodeExecutionRunV1(run));
    expect(decoded).toEqual(run);
    expect(decoded).not.toBe(run);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.manifest.asset)).toBe(true);
    expect(Object.isFrozen(decoded.operations)).toBe(true);
  });

  it.each([
    ["Date", new Date("2026-09-04T12:00:00.000Z")],
    ["BigInt", 1n],
    ["function", () => undefined],
    ["class instance", new (class Unsafe {})()],
  ])("rejects a nested %s before persistence", async (_label, unsafe) => {
    const run = await createExecutionRunFixture();
    await expect(() =>
      encodeExecutionRunV1({ ...run, operations: [{ ...run.operations[0], unsignedTransaction: { unsafe } }, run.operations[1], run.operations[2]] }),
    ).toThrow(InvalidRunSnapshotError);
  });

  it("rejects accessors without executing them", async () => {
    const run = await createExecutionRunFixture();
    let reads = 0;
    const unsignedTransaction = {};
    Object.defineProperty(unsignedTransaction, "data", {
      enumerable: true,
      get() {
        reads += 1;
        return "0x";
      },
    });
    expect(() => encodeExecutionRunV1({
      ...run,
      operations: [{ ...run.operations[0], unsignedTransaction }, run.operations[1], run.operations[2]],
    })).toThrow(InvalidRunSnapshotError);
    expect(reads).toBe(0);
  });

  it("rejects sparse arrays, cycles and unsupported properties", async () => {
    const run = await createExecutionRunFixture();
    const sparse = new Array(2);
    sparse[1] = "unsafe";
    expect(() => encodeExecutionRunV1({ ...run, observations: sparse })).toThrow(InvalidRunSnapshotError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeExecutionRunV1({
      ...run,
      operations: [{ ...run.operations[0], unsignedTransaction: cyclic }, run.operations[1], run.operations[2]],
    })).toThrow(InvalidRunSnapshotError);

    expect(() => encodeExecutionRunV1({ ...run, unexpected: true })).toThrow(InvalidRunSnapshotError);
  });

  it("refuses secret-bearing property names with a sanitized error", async () => {
    const run = await createExecutionRunFixture();
    const secret = "postgresql://user:credential@example.invalid/edict";
    let error: unknown;
    try {
      encodeExecutionRunV1({
        ...run,
        operations: [
          { ...run.operations[0], unsignedTransaction: { DATABASE_URL: secret } },
          run.operations[1],
          run.operations[2],
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidRunSnapshotError);
    expect(String(error)).not.toContain(secret);

    expect(() => encodeExecutionRunV1({
      ...run,
      observations: [{ operationKind: "TOKENIZE", read: secret, at: run.createdAt }],
    })).toThrow(InvalidRunSnapshotError);
  });

  it("fails closed when duplicated columns disagree with the snapshot", async () => {
    const run = await createExecutionRunFixture();
    const row = encodeExecutionRunV1(run);
    expect(() => decodeExecutionRunV1({ ...row, planHash: `sha256:${"0".repeat(64)}` })).toThrow(
      PersistenceDataError,
    );
  });
});
