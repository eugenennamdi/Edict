CREATE TABLE "execution_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"schema_version" text NOT NULL,
	"revision" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"plan_hash" text NOT NULL,
	"status" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_runs_schema_version_check" CHECK ("execution_runs"."schema_version" = '1.0'),
	CONSTRAINT "execution_runs_revision_nonnegative_check" CHECK ("execution_runs"."revision" >= 0)
);
