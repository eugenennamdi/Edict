import { describe, expect, it } from "vitest";
import {
  PersistenceConfigurationError,
  PersistenceDataError,
  PersistenceUnavailableError,
  RepositoryNotFoundError,
  RepositoryRevisionConflictError,
} from "../execution/errors";
import type { ExecutionRunV1 } from "../execution/types";
import type { PersistedExecutionRunRow } from "./codec";
import { readDatabaseConfig } from "./config";
import { NeonExecutionRunRepository } from "./repository";
import type { ExecutionRunStore } from "./store";
import { createExecutionRunFixture } from "./test-fixtures";

function copy<T>(value: T): T {
  return structuredClone(value);
}

class MemoryExecutionRunStore implements ExecutionRunStore {
  readonly rows = new Map<string, PersistedExecutionRunRow>();
  failNextCompareAndSwap = false;
  failure: Error = new Error("database failure");

  async insert(row: PersistedExecutionRunRow): Promise<PersistedExecutionRunRow | null> {
    if (this.rows.has(row.runId)) return null;
    this.rows.set(row.runId, copy(row));
    return copy(row);
  }

  async selectById(id: string): Promise<PersistedExecutionRunRow | null> {
    const row = this.rows.get(id);
    return row ? copy(row) : null;
  }

  async compareAndSwap(
    row: PersistedExecutionRunRow,
    expectedRevision: number,
  ): Promise<PersistedExecutionRunRow | null> {
    if (this.failNextCompareAndSwap) {
      this.failNextCompareAndSwap = false;
      throw this.failure;
    }
    const current = this.rows.get(row.runId);
    if (!current || current.revision !== expectedRevision) return null;
    this.rows.set(row.runId, copy(row));
    return copy(row);
  }

  async deleteById(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

async function setup() {
  const store = new MemoryExecutionRunStore();
  const repository = new NeonExecutionRunRepository(store);
  const run = await createExecutionRunFixture();
  return { store, repository, run };
}

function nextRun(run: ExecutionRunV1, status: ExecutionRunV1["status"] = "PREPARING") {
  return { ...run, status, updatedAt: "2026-09-04T12:00:01.000Z" };
}

describe("durable execution run repository", () => {
  it("creates and reads a copy-safe immutable run", async () => {
    const { repository, run } = await setup();
    const mutableInput = structuredClone(run);
    const created = await repository.create(mutableInput);
    (mutableInput as { status: ExecutionRunV1["status"] }).status = "FAILED";
    (mutableInput.manifest.asset as { name: string }).name = "mutated after create";
    const read = await repository.getById(run.id);
    expect(read).toEqual(created);
    expect(read).not.toBe(created);
    expect(Object.isFrozen(read)).toBe(true);
    expect(() => ((read as { status: string }).status = "FAILED")).toThrow(TypeError);
    expect((await repository.getById(run.id)).status).toBe("AWAITING_APPROVAL");
    expect((await repository.getById(run.id)).manifest.asset.name).toBe("Café Receivables");
  });

  it("rejects duplicate creation and reports missing runs", async () => {
    const { repository, run } = await setup();
    await repository.create(run);
    await expect(repository.create(run)).rejects.toBeInstanceOf(RepositoryRevisionConflictError);
    await expect(repository.getById("missing")).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it("performs an atomic compare-and-swap and increments once", async () => {
    const { repository, run } = await setup();
    await repository.create(run);
    const updated = await repository.update(run.id, run.revision, nextRun(run));
    expect(updated.revision).toBe(run.revision + 1);
    expect(updated.status).toBe("PREPARING");
    expect((await repository.getById(run.id)).revision).toBe(run.revision + 1);
  });

  it("rejects stale and concurrent updates so exactly one succeeds", async () => {
    const { repository, run } = await setup();
    await repository.create(run);
    const attempts = await Promise.allSettled([
      repository.update(run.id, run.revision, nextRun(run, "PREPARING")),
      repository.update(run.id, run.revision, nextRun(run, "FAILED")),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(RepositoryRevisionConflictError) });
  });

  it("returns a typed conflict for an explicitly stale revision", async () => {
    const { repository, run } = await setup();
    await repository.create(run);
    await repository.update(run.id, run.revision, nextRun(run));
    await expect(repository.update(run.id, run.revision, nextRun(run))).rejects.toBeInstanceOf(
      RepositoryRevisionConflictError,
    );
  });

  it("rejects snapshot/column mismatches, malformed JSON and unsupported versions", async () => {
    const { store, repository, run } = await setup();
    await repository.create(run);
    const row = store.rows.get(run.id)!;

    store.rows.set(run.id, { ...row, status: "FAILED" });
    await expect(repository.getById(run.id)).rejects.toBeInstanceOf(PersistenceDataError);

    store.rows.set(run.id, { ...row, snapshot: { malformed: true } });
    await expect(repository.getById(run.id)).rejects.toBeInstanceOf(PersistenceDataError);

    store.rows.set(run.id, { ...row, schemaVersion: "2.0" as "1.0" });
    await expect(repository.getById(run.id)).rejects.toBeInstanceOf(PersistenceDataError);
  });

  it("preserves canonical UTC timestamps at the application boundary", async () => {
    const { repository, run } = await setup();
    const created = await repository.create(run);
    expect(created.createdAt).toBe("2026-09-04T12:00:00.000Z");
    expect(created.updatedAt).toBe("2026-09-04T12:00:00.000Z");
  });

  it("does not partially update when the atomic store operation fails", async () => {
    const { store, repository, run } = await setup();
    await repository.create(run);
    store.failNextCompareAndSwap = true;
    await expect(repository.update(run.id, run.revision, nextRun(run))).rejects.toBeInstanceOf(
      PersistenceUnavailableError,
    );
    expect(await repository.getById(run.id)).toEqual(run);
  });

  it("redacts connection strings and upstream details from persistence failures", async () => {
    const { store, repository, run } = await setup();
    const secret = "postgresql://user:credential@example.invalid/edict";
    const apiKey = "api-key-value-that-must-not-escape";
    await repository.create(run);
    store.failure = new Error(`connection failed: ${secret}; key=${apiKey}`);
    store.failNextCompareAndSwap = true;
    let error: unknown;
    try {
      await repository.update(run.id, run.revision, nextRun(run));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PersistenceUnavailableError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(apiKey);
  });

  it("returns a typed sanitized error when database configuration is missing", () => {
    expect(() => readDatabaseConfig({})).toThrow(PersistenceConfigurationError);
    expect(() => readDatabaseConfig({ DATABASE_URL: "not-a-database-url" })).toThrow(
      PersistenceConfigurationError,
    );
  });
});
