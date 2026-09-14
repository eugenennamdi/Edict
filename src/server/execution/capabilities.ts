import "server-only";
import type { ExecutionRun, ExecutionPlanSnapshot } from "./types";

import { buildExecutionPlanV1, validateAssetManifestV1, type ExecutionPlanV1, type NormalizedAssetManifestV1 } from "@/core";
import { IllegalStateTransitionError } from "./errors";

/** Deployment policy, never supplied by the browser. Enabling a new operation
 * requires a reviewed semantic evaluator and a corresponding policy change. */
export const EXECUTION_CAPABILITIES = Object.freeze({
  TOKENIZE: "ENABLED",
  WHITELIST: "DISABLED_UNVERIFIED",
  MINT: "DISABLED_UNVERIFIED",
} as const);

export function activePlanScope(): "TOKENIZE_ONLY" {
  if (EXECUTION_CAPABILITIES.TOKENIZE !== "ENABLED") throw new IllegalStateTransitionError();
  return "TOKENIZE_ONLY";
}

export function isExecutablePlan(plan: ExecutionPlanV1 | ExecutionPlanSnapshot): boolean {
  if (!("operations" in plan)) return plan.executionScope === "TOKENIZE_ONLY";
  return EXECUTION_CAPABILITIES.TOKENIZE === "ENABLED" &&
    plan.operations.length === 2 && plan.operations[0].kind === "TOKENIZE" &&
    plan.operations[1].kind === "CONFIRM_TOKENIZATION";
}

export function assertExecutablePlan(plan: ExecutionPlanV1 | ExecutionPlanSnapshot): void {
  if (!isExecutablePlan(plan)) throw new IllegalStateTransitionError();
}

export function assertCurrentMandate(manifest: NormalizedAssetManifestV1): void {
  if (EXECUTION_CAPABILITIES.TOKENIZE !== "ENABLED" ||
    BigInt(manifest.asset.supplyCap) * 10n ** 18n > (1n << 224n) - 1n) {
    throw new IllegalStateTransitionError();
  }
}

export async function assertExecutableRun(run: ExecutionRun): Promise<void> {
  assertExecutablePlan(run.plan);
  const manifest = validateAssetManifestV1(run.manifest);
  if (!manifest.ok) throw new IllegalStateTransitionError();
  const plan = await buildExecutionPlanV1(manifest.value, activePlanScope());
  if (plan.planHash !== run.planHash || plan.manifestHash !== run.manifestHash) throw new IllegalStateTransitionError();
}

export function capabilityPresentation() {
  const names = { TOKENIZE: "Token creation", WHITELIST: "Investor access", MINT: "Minting" };
  return Object.freeze({ summary: Object.entries(EXECUTION_CAPABILITIES)
    .map(([kind, state]) => `${names[kind as keyof typeof names]} ${state === "ENABLED" ? "available" : "unavailable"}`).join(" · ") });
}
