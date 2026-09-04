import { check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const executionRuns = pgTable(
  "execution_runs",
  {
    runId: text("run_id").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    revision: integer("revision").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    planHash: text("plan_hash").notNull(),
    status: text("status").notNull(),
    snapshot: jsonb("snapshot").notNull().$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    check("execution_runs_schema_version_check", sql`${table.schemaVersion} = '1.0'`),
    check("execution_runs_revision_nonnegative_check", sql`${table.revision} >= 0`),
  ],
);
