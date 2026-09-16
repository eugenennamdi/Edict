import "server-only";
import type { ExecutionRun, ExecutionPlanSnapshot } from "./types";

import { buildExecutionPlanV1, validateAssetManifestV1, type ExecutionPlanV1, type NormalizedAssetManifestV1 } from "@/core";
import { IllegalStateTransitionError } from "./errors";

/** Deployment policy, never supplied by the browser. Enabling a new operation
 * requires a reviewed semantic evaluator and a corresponding policy change. */
export const EXECUTION_CAPABILITIES = Object.freeze({
  TOKENIZE: "ENABLED",
  WHITELIST: "ENABLED",
  MINT: "ENABLED",
} as const);

export function activePlanScope(): "TOKENIZE_ONLY" | "LEGACY_FULL" {
  if (EXECUTION_CAPABILITIES.TOKENIZE !== "ENABLED") throw new IllegalStateTransitionError();
  return "TOKENIZE_ONLY";
}

export function planScopeForManifest(manifest: NormalizedAssetManifestV1): "TOKENIZE_ONLY" | "LEGACY_FULL" {
  if (EXECUTION_CAPABILITIES.TOKENIZE !== "ENABLED") throw new IllegalStateTransitionError();
  if (manifest.investor && EXECUTION_CAPABILITIES.WHITELIST === "ENABLED" && EXECUTION_CAPABILITIES.MINT === "ENABLED") {
    return "LEGACY_FULL";
  }
  return "TOKENIZE_ONLY";
}

export function isExecutablePlan(plan: ExecutionPlanV1 | ExecutionPlanSnapshot): boolean {
  if (!("operations" in plan)) {
    return plan.executionScope === "TOKENIZE_ONLY" || plan.executionScope === "LEGACY_FULL";
  }
  if (EXECUTION_CAPABILITIES.TOKENIZE !== "ENABLED") return false;
  if (plan.operations.length === 2 && plan.operations[0].kind === "TOKENIZE" && plan.operations[1].kind === "CONFIRM_TOKENIZATION") {
    return true;
  }
  if (
    EXECUTION_CAPABILITIES.WHITELIST === "ENABLED" && EXECUTION_CAPABILITIES.MINT === "ENABLED" &&
    plan.operations.length === 7 &&
    plan.operations[0].kind === "TOKENIZE" &&
    plan.operations[2].kind === "WHITELIST_INVESTOR" &&
    plan.operations[4].kind === "MINT"
  ) {
    return true;
  }
  return false;
}

export function assertExecutablePlan(plan: ExecutionPlanV1 | ExecutionPlanSnapshot): void {
  if (!isExecutablePlan(plan)) throw new IllegalStateTransitionError();
}

export function assertCurrentMandate(manifest: NormalizedAssetManifestV1): void {
  if (EXECUTION_CAPABILITIES.TOKENIZE !== "ENABLED" ||
    BigInt(manifest.asset.supplyCap) * 10n ** 18n > (1n << 224n) - 1n) {
    throw new IllegalStateTransitionError();
  }
  if (manifest.investor) {
    if (EXECUTION_CAPABILITIES.WHITELIST !== "ENABLED" || EXECUTION_CAPABILITIES.MINT !== "ENABLED") {
      throw new IllegalStateTransitionError();
    }
  }
}

export async function assertExecutableRun(run: ExecutionRun): Promise<void> {
  assertExecutablePlan(run.plan);
  const manifest = validateAssetManifestV1(run.manifest);
  if (!manifest.ok) throw new IllegalStateTransitionError();
  const scope = planScopeForManifest(manifest.value);
  const plan = await buildExecutionPlanV1(manifest.value, scope);
  if (plan.planHash !== run.planHash || plan.manifestHash !== run.manifestHash) throw new IllegalStateTransitionError();
}

export function capabilityPresentation() {
  const names = { TOKENIZE: "Token creation", WHITELIST: "Investor access", MINT: "Minting" };
  return Object.freeze({ summary: Object.entries(EXECUTION_CAPABILITIES)
    .map(([kind, state]) => `${names[kind as keyof typeof names]} ${state === "ENABLED" ? "available" : "unavailable"}`).join(" · ") });
}
