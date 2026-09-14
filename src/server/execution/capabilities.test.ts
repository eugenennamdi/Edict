import { describe, expect, it } from "vitest";
import { buildExecutionPlanV1, validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import { EXECUTION_CAPABILITIES, activePlanScope, assertExecutablePlan, isExecutablePlan } from "./capabilities";
import { ExecutionRunService } from "./run-service";
import { InMemoryExecutionRunRepository } from "./repository";
import { createApprovalProofFixture } from "./test-fixtures";
import { projectPublicPlanningRecord } from "../run-api/projection";

async function fixture() {
  const result = validateAssetManifestV1(createValidRawManifest());
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

describe("server capability policy", () => {
  it("builds exactly the executable outcomes and refuses disabled plans", async () => {
    const manifest = await fixture();
    const active = await buildExecutionPlanV1(manifest, activePlanScope());
    expect(active.operations.map((op) => op.kind)).toEqual(["TOKENIZE", "CONFIRM_TOKENIZATION"]);
    expect(isExecutablePlan(active)).toBe(true);
    const legacy = await buildExecutionPlanV1(manifest, "LEGACY_FULL");
    expect(() => assertExecutablePlan(legacy)).toThrow();
    expect(Object.isFrozen(EXECUTION_CAPABILITIES)).toBe(true);
    expect(EXECUTION_CAPABILITIES).toEqual({ TOKENIZE: "ENABLED", WHITELIST: "DISABLED_UNVERIFIED", MINT: "DISABLED_UNVERIFIED" });
  });

  it("preserves historical plan truth but rejects approval before any mutation", async () => {
    const repository = new InMemoryExecutionRunRepository(); let id = 0;
    const service = new ExecutionRunService({ repository, clock: { nowIso: () => "2026-09-14T00:00:00.000Z" },
      ids: { runId: () => "11111111-1111-4111-8111-111111111111", operationId: () => `op-${id++}`, eventId: () => `event-${id++}` } });
    const manifest = await fixture();
    const current = await service.createRun(manifest);
    const { operations: _operations, ...oldPlan } = await buildExecutionPlanV1(manifest, "LEGACY_FULL");
    void _operations;
    const old = await repository.update(current.id, current.revision, { ...current, plan: oldPlan, planHash: oldPlan.planHash });
    const projected = await projectPublicPlanningRecord(old);
    expect(projected.plan.operations).toHaveLength(7);
    expect(projected.run.executablePlan).toBe(false);
    await expect(service.approvePlan(old.id, old.revision, { planHash: old.planHash,
      approvedByWallet: old.requiredSigner.walletAddress, proof: createApprovalProofFixture(old, old.updatedAt) })).rejects.toThrow();
    expect(await repository.getById(old.id)).toEqual(old);
  });
});
