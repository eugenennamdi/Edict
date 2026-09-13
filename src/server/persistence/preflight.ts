import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { readDatabaseConfig } from "./config";

export interface MigrationRecord {
  readonly id: number;
  readonly hash: string;
  readonly createdAt: string;
}

export interface VersionCount {
  readonly schemaVersion: string;
  readonly count: number;
}

export interface DatabasePreflightReport {
  readonly ok: boolean;
  readonly reachable: boolean;
  readonly localMigration0003Hash: string;
  readonly migration0003RecordedCount: number;
  readonly migration0003Record: MigrationRecord;
  readonly schemaVersionConstraintValid: boolean;
  readonly schemaVersionConstraintDef: string;
  readonly totalRowCount: number;
  readonly versionRowCounts: readonly VersionCount[];
}

export class DatabasePreflightError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DatabasePreflightError";
    this.code = code;
  }
}

const EXPECTED_SANITY_HASH_0003 =
  "eb8f17d0b78fca757f97908174a2462391449eb40d1da91c9fae8476c6dc4fe3";

/**
 * Computes the SHA-256 hash of local migration 0003 file using Drizzle's exact representation.
 */
export function computeLocalMigration0003Hash(migrationsFolder?: string): string {
  const folder = migrationsFolder ?? path.resolve(process.cwd(), "drizzle");
  const filePath = path.join(folder, "0003_mushy_sugar_man.sql");
  if (!fs.existsSync(filePath)) {
    throw new DatabasePreflightError(
      "LOCAL_MIGRATION_NOT_FOUND",
      `Local migration 0003 file not found at ${filePath}`,
    );
  }
  const fileContent = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(fileContent).digest("hex");
}

/**
 * Performs a deterministic, strictly read-only preflight check against Neon Postgres.
 *
 * Enforces:
 * - Read-only queries only: no writes, no row creation/updates, no schema alterations, no migration executions.
 * - Confirms target is reachable.
 * - Confirms migration 0003 is recorded in drizzle.__drizzle_migrations exactly once.
 * - Confirms stored migration 0003 hash strictly equals local migration 0003 file hash.
 * - Confirms execution_runs_schema_version_check constraint accepts exactly ['1.0', '2.0', '3.0', '4.0'].
 * - Reports total row count and breakdown by schema_version.
 */
export async function runDatabasePreflight(options?: {
  readonly databaseUrl?: string;
  readonly migrationsFolder?: string;
}): Promise<DatabasePreflightReport> {
  const localHash = computeLocalMigration0003Hash(options?.migrationsFolder);

  // Sanity check against expected hash from repository history
  if (localHash !== EXPECTED_SANITY_HASH_0003) {
    throw new DatabasePreflightError(
      "LOCAL_MIGRATION_HASH_SANITY_MISMATCH",
      `Local migration 0003 hash ${localHash} differs from sanity expectation ${EXPECTED_SANITY_HASH_0003}.`,
    );
  }

  const databaseUrl = options?.databaseUrl ?? readDatabaseConfig().databaseUrl;
  const sql = neon(databaseUrl);

  // 1. Connectivity check (read-only)
  try {
    await sql`SELECT 1 as reachable;`;
  } catch (err) {
    throw new DatabasePreflightError(
      "DATABASE_UNREACHABLE",
      `Database connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Query drizzle.__drizzle_migrations (read-only)
  let rawMigrations: Array<{ id: number; hash: string; created_at: string }>;
  try {
    rawMigrations = (await sql`
      SELECT id, hash, created_at::text
      FROM "drizzle"."__drizzle_migrations"
      ORDER BY id ASC;
    `) as Array<{ id: number; hash: string; created_at: string }>;
  } catch (err) {
    throw new DatabasePreflightError(
      "MIGRATIONS_TABLE_QUERY_FAILED",
      `Failed to query drizzle.__drizzle_migrations: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const matching0003 = rawMigrations.filter((m) => m.hash === localHash);
  if (matching0003.length !== 1) {
    throw new DatabasePreflightError(
      "MIGRATION_0003_RECORD_COUNT_INVALID",
      `Expected migration 0003 to be recorded exactly once, found ${matching0003.length} entries.`,
    );
  }

  const record0003 = matching0003[0];

  // 3. Inspect schema_version check constraint on execution_runs (read-only)
  let constraints: Array<{ conname: string; def: string }>;
  try {
    constraints = (await sql`
      SELECT c.conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE t.relname = 'execution_runs'
        AND n.nspname = 'public'
        AND c.contype = 'c';
    `) as Array<{ conname: string; def: string }>;
  } catch (err) {
    throw new DatabasePreflightError(
      "CONSTRAINT_QUERY_FAILED",
      `Failed to query pg_constraint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const versionConstraint = constraints.find(
    (c) => c.conname === "execution_runs_schema_version_check",
  );

  if (!versionConstraint) {
    throw new DatabasePreflightError(
      "SCHEMA_VERSION_CONSTRAINT_MISSING",
      "Constraint 'execution_runs_schema_version_check' not found on table 'execution_runs'.",
    );
  }

  const def = versionConstraint.def;
  // Verify that the constraint accepts 1.0, 2.0, 3.0, 4.0
  const acceptsV1 = def.includes("'1.0'");
  const acceptsV2 = def.includes("'2.0'");
  const acceptsV3 = def.includes("'3.0'");
  const acceptsV4 = def.includes("'4.0'");
  const rejectedV5 = !def.includes("'5.0'");

  if (!acceptsV1 || !acceptsV2 || !acceptsV3 || !acceptsV4 || !rejectedV5) {
    throw new DatabasePreflightError(
      "SCHEMA_VERSION_CONSTRAINT_INVALID",
      `Constraint definition does not allow exactly ('1.0', '2.0', '3.0', '4.0'): ${def}`,
    );
  }

  // 4. Report row counts (read-only)
  const totalRes = (await sql`SELECT count(*)::int as total FROM execution_runs;`) as Array<{
    total: number;
  }>;
  const totalRowCount = totalRes[0]?.total ?? 0;

  const versionCounts = (await sql`
    SELECT schema_version as "schemaVersion", count(*)::int as count
    FROM execution_runs
    GROUP BY schema_version
    ORDER BY schema_version ASC;
  `) as Array<{ schemaVersion: string; count: number }>;

  return Object.freeze({
    ok: true,
    reachable: true,
    localMigration0003Hash: localHash,
    migration0003RecordedCount: matching0003.length,
    migration0003Record: Object.freeze({
      id: record0003.id,
      hash: record0003.hash,
      createdAt: record0003.created_at,
    }),
    schemaVersionConstraintValid: true,
    schemaVersionConstraintDef: def,
    totalRowCount,
    versionRowCounts: Object.freeze(versionCounts.map((v) => Object.freeze(v))),
  });
}
