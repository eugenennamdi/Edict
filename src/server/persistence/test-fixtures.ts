import { validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import type { ExecutionRunV1 } from "../execution/types";

export async function createExecutionRunFixture(): Promise<ExecutionRunV1> {
  const validation = validateAssetManifestV1(createValidRawManifest());
  if (!validation.ok) throw new Error("The execution persistence fixture must validate.");
  let operation = 0;
  const service = new ExecutionRunService({
    repository: new InMemoryExecutionRunRepository(),
    clock: { nowIso: () => "2026-09-04T12:00:00.000Z" },
    ids: {
      runId: () => "11111111-1111-4111-8111-111111111111",
      operationId: () => `operation-${operation++}`,
      eventId: () => "event-0",
    },
  });
  return service.createRun(validation.value);
}
