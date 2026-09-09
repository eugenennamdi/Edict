import { describe, expect, it } from "vitest";
import { buildExecutionPlanV1, validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import {
  parsePublicPlanningRecord,
  parsePublicPlanningRecordResponse,
  publicRunIdSchema,
} from "./public";

async function record() {
  const validated = validateAssetManifestV1(createValidRawManifest());
  if (!validated.ok) throw new Error("Invalid fixture");
  const plan = await buildExecutionPlanV1(validated.value);
  return {
    run: {
      id: "11111111-1111-4111-8111-111111111111",
      schemaVersion: "2.0",
      manifestHash: plan.manifestHash,
      planHash: plan.planHash,
      environment: "sandbox",
      chainId: "11155111",
      requiredSigner: plan.requiredSigner,
      phase: "PLAN",
      status: "AWAITING_APPROVAL",
      terminalOutcome: null,
      approved: false,
      operations: [
        { id: "operation-1", kind: "TOKENIZE", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "operation-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "operation-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
      receiptEligible: false,
      createdAt: "2026-09-08T12:00:00.000Z",
      updatedAt: "2026-09-08T12:00:00.000Z",
      revision: 1,
    },
    manifest: validated.value,
    plan,
  };
}

describe("public run transport contract", () => {
  it("accepts one independently complete strict planning record", async () => {
    const value = await record();
    const parsed = parsePublicPlanningRecordResponse({ ok: true, ...value });
    expect(parsed.manifest).toEqual(value.manifest);
    expect(parsed.plan.operations.map((operation) => operation.id)).toEqual([
      "tokenize",
      "confirm-tokenization",
      "whitelist-investor",
      "confirm-whitelist",
      "mint",
      "confirm-mint",
      "verify-deployment",
    ]);
    expect(parsed.run.operations.map((operation) => operation.kind)).toEqual([
      "TOKENIZE",
      "WHITELIST",
      "MINT",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    (value: Awaited<ReturnType<typeof record>>) => ({ ok: true, ...value, capability: "private" }),
    (value: Awaited<ReturnType<typeof record>>) => ({ ok: true, ...value, run: { ...value.run, approval: { publicSignature: "private" } } }),
    (value: Awaited<ReturnType<typeof record>>) => ({ ok: true, ...value, manifest: { ...value.manifest, unknown: true } }),
    (value: Awaited<ReturnType<typeof record>>) => ({ ok: true, ...value, plan: { ...value.plan, unknown: true } }),
    (value: Awaited<ReturnType<typeof record>>) => ({ ok: true, ...value, run: { ...value.run, revision: 0 } }),
    (value: Awaited<ReturnType<typeof record>>) => ({ ok: true, ...value, run: { ...value.run, planHash: `sha256:${"0".repeat(64)}` } }),
    (value: Awaited<ReturnType<typeof record>>) => ({ ok: true, ...value, run: { ...value.run, operations: [...value.run.operations].reverse() } }),
  ])("rejects unknown, malformed, or cross-artifact-inconsistent data %#", async (change) => {
    const value = await record();
    expect(() => parsePublicPlanningRecordResponse(change(value))).toThrow();
  });

  it("rejects accessor-backed transport values without invoking them", async () => {
    const value = await record();
    let reads = 0;
    Object.defineProperty(value, "run", {
      enumerable: true,
      get() {
        reads += 1;
        return {};
      },
    });
    expect(() => parsePublicPlanningRecord(value)).toThrow();
    expect(reads).toBe(0);
  });

  it("shares the bounded run locator syntax without granting authority", () => {
    expect(publicRunIdSchema.safeParse("11111111-1111-4111-8111-111111111111").success).toBe(true);
    expect(publicRunIdSchema.safeParse("not-a-run").success).toBe(false);
  });
});
