import "server-only";

import { neon } from "@neondatabase/serverless";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { PersistedExecutionRunRow } from "./codec";
import { executionRuns } from "./schema";

export interface ExecutionRunStore {
  insert(row: PersistedExecutionRunRow): Promise<PersistedExecutionRunRow | null>;
  selectById(id: string): Promise<PersistedExecutionRunRow | null>;
  compareAndSwap(
    row: PersistedExecutionRunRow,
    expectedRevision: number,
  ): Promise<PersistedExecutionRunRow | null>;
  deleteById(id: string): Promise<void>;
}

type Database = NeonHttpDatabase<Record<string, never>>;
type DatabaseRow = typeof executionRuns.$inferSelect;

function toDatabaseValues(row: PersistedExecutionRunRow) {
  return {
    runId: row.runId,
    schemaVersion: row.schemaVersion,
    revision: row.revision,
    manifestHash: row.manifestHash,
    planHash: row.planHash,
    status: row.status,
    snapshot: row.snapshot,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function toPersistenceRow(row: DatabaseRow): PersistedExecutionRunRow {
  return {
    runId: row.runId,
    schemaVersion: row.schemaVersion as PersistedExecutionRunRow["schemaVersion"],
    revision: row.revision,
    manifestHash: row.manifestHash,
    planHash: row.planHash,
    status: row.status as PersistedExecutionRunRow["status"],
    snapshot: row.snapshot,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Internal query adapter. Constructing it does not perform a network request. */
export class DrizzleExecutionRunStore implements ExecutionRunStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async insert(row: PersistedExecutionRunRow): Promise<PersistedExecutionRunRow | null> {
    const [created] = await this.#database
      .insert(executionRuns)
      .values(toDatabaseValues(row))
      .onConflictDoNothing({ target: executionRuns.runId })
      .returning();
    return created ? toPersistenceRow(created) : null;
  }

  async selectById(id: string): Promise<PersistedExecutionRunRow | null> {
    const [found] = await this.#database
      .select()
      .from(executionRuns)
      .where(eq(executionRuns.runId, id))
      .limit(1);
    return found ? toPersistenceRow(found) : null;
  }

  async compareAndSwap(
    row: PersistedExecutionRunRow,
    expectedRevision: number,
  ): Promise<PersistedExecutionRunRow | null> {
    const values = toDatabaseValues(row);
    const [updated] = await this.#database
      .update(executionRuns)
      .set({
        schemaVersion: values.schemaVersion,
        revision: sql`${executionRuns.revision} + 1`,
        manifestHash: values.manifestHash,
        planHash: values.planHash,
        status: values.status,
        snapshot: values.snapshot,
        createdAt: values.createdAt,
        updatedAt: values.updatedAt,
      })
      .where(
        and(
          eq(executionRuns.runId, row.runId),
          eq(executionRuns.revision, expectedRevision),
        ),
      )
      .returning();
    return updated ? toPersistenceRow(updated) : null;
  }

  async deleteById(id: string): Promise<void> {
    await this.#database.delete(executionRuns).where(eq(executionRuns.runId, id));
  }
}

export function createDrizzleExecutionRunStore(databaseUrl: string): DrizzleExecutionRunStore {
  const client = neon(databaseUrl);
  return new DrizzleExecutionRunStore(drizzle({ client }));
}
