import { describe, expect, it } from "vitest";
import { createValidRawManifest } from "@/core/test-fixtures";
import { validateAssetManifestV1 } from "@/core";
import {
  InvalidRunSnapshotError,
  RepositoryNotFoundError,
  RepositoryRevisionConflictError,
} from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import { InMemoryExecutionRunRepository } from "./repository";
import { ExecutionRunService } from "./run-service";
import type { ExecutionRunV1 } from "./types";

function createService() {
  let ticks = 0;
  let ids = 0;
  const clock: Clock = {
    nowIso: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ticks++)).toISOString(),
  };
  const generator: IdGenerator = {
    runId: () => `run-${ids++}`,
    operationId: () => `op-${ids++}`,
    eventId: () => `ev-${ids++}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  const service = new ExecutionRunService({ repository, clock, ids: generator });
  return { service, repository };
}

async function createStoredRun() {
  const validation = validateAssetManifestV1(createValidRawManifest());
  if (!validation.ok) throw new Error("Golden manifest must validate.");
  const { service, repository } = createService();
  const run = await service.createRun(validation.value);
  return { repository, run };
}

describe("in-memory execution repository", () => {
  it("returns copy-safe snapshots", async () => {
    const { repository, run } = await createStoredRun();
    const first = await repository.getById(run.id);
    const second = await repository.getById(run.id);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(() => ((first as { status: string }).status = "FAILED")).toThrow(TypeError);
    const reread = await repository.getById(run.id);
    expect(reread.status).toBe("AWAITING_APPROVAL");
  });

  it("rejects stale revisions and racing updates", async () => {
    const { repository, run } = await createStoredRun();
    const stale = { ...run, status: "PREPARING" as const };
    const winner = await repository.update(run.id, run.revision, {
      ...run,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(winner.revision).toBe(run.revision + 1);
    await expect(repository.update(run.id, stale.revision, stale)).rejects.toBeInstanceOf(
      RepositoryRevisionConflictError,
    );
  });

  it("rejects unknown ids", async () => {
    const { repository } = await createStoredRun();
    await expect(repository.getById("missing")).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it("rejects non-JSON snapshots", async () => {
    const { repository, run } = await createStoredRun();
    const invalid = {
      ...run,
      cyclic: undefined,
    } as ExecutionRunV1 & { cyclic?: bigint };
    Object.defineProperty(invalid, "cyclic", {
      enumerable: true,
      get() {
        return 1n;
      },
    });
    await expect(repository.create(invalid)).rejects.toBeInstanceOf(InvalidRunSnapshotError);
  });
});
