import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import { RepositoryRevisionConflictError } from "../execution/errors";
import { ExecutionRunService } from "../execution/run-service";
import { readDatabaseConfig } from "./config";
import { NeonExecutionRunRepository } from "./repository";
import { createDrizzleExecutionRunStore } from "./store";

describe("opt-in Neon execution repository verification", () => {
  it("verifies create, read, compare-and-swap and stale-revision refusal", async () => {
    if (process.env.EDICT_DATABASE_LIVE !== "1") {
      throw new Error("Refusing to run without EDICT_DATABASE_LIVE=1.");
    }

    const { databaseUrl } = readDatabaseConfig();
    const store = createDrizzleExecutionRunStore(databaseUrl);
    const repository = new NeonExecutionRunRepository(store);
    const validation = validateAssetManifestV1(createValidRawManifest());
    if (!validation.ok) throw new Error("The live database fixture must validate.");

    const runId = `database-live-${randomUUID()}`;
    let operation = 0;
    const service = new ExecutionRunService({
      repository,
      clock: { nowIso: () => "2026-09-04T12:00:00.000Z" },
      ids: {
        runId: () => runId,
        operationId: () => `database-live-operation-${operation++}-${randomUUID()}`,
        eventId: () => `database-live-event-${randomUUID()}`,
      },
    });

    let created = false;
    try {
      const run = await service.createRun(validation.value);
      created = true;
      expect((await repository.getById(runId)).id).toBe(runId);

      const updated = await repository.update(runId, run.revision, {
        ...run,
        updatedAt: "2026-09-04T12:00:01.000Z",
      });
      expect(updated.revision).toBe(run.revision + 1);
      await expect(
        repository.update(runId, run.revision, {
          ...run,
          updatedAt: "2026-09-04T12:00:02.000Z",
        }),
      ).rejects.toBeInstanceOf(RepositoryRevisionConflictError);
    } catch (error) {
      if (!created) {
        throw new Error(
          "Live database verification failed before create; confirm DATABASE_URL and apply migrations first.",
        );
      }
      throw error;
    } finally {
      if (created) {
        try {
          await store.deleteById(runId);
        } catch {
          throw new Error("Live database verification could not clean up its test record.");
        }
      }
    }

    console.log(JSON.stringify({ ok: true, category: "DATABASE_PERSISTENCE" }));
  });
});
