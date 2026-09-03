import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "./canonical-json";
import {
  buildExecutionPlanV1,
  ExecutionPlanBuildError,
  type ExecutionPlanV1,
} from "./execution-plan";
import { hashCanonicalJson } from "./hashing";
import {
  validateAssetManifestV1,
  type NormalizedAssetManifestV1,
} from "./manifest";
import {
  createValidRawManifest,
  GOLDEN_MANIFEST_HASH,
  GOLDEN_PLAN_HASH,
} from "./test-fixtures";

function validManifest(): NormalizedAssetManifestV1 {
  const result = validateAssetManifestV1(createValidRawManifest());
  if (!result.ok) throw new Error("The test fixture must be valid.");
  return result.value;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) expectDeepFrozen(descriptor.value);
  }
}

describe("buildExecutionPlanV1", () => {
  it("builds the fixed seven-operation sequence and signer gates", async () => {
    const plan = await buildExecutionPlanV1(validManifest());
    expect(plan.operations.map(({ id }) => id)).toEqual([
      "tokenize",
      "confirm-tokenization",
      "whitelist-investor",
      "confirm-whitelist",
      "mint",
      "confirm-mint",
      "verify-deployment",
    ]);
    expect(plan.operations.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.operations.map(({ dependsOn }) => dependsOn)).toEqual([
      [],
      ["tokenize"],
      ["confirm-tokenization"],
      ["whitelist-investor"],
      ["confirm-whitelist"],
      ["mint"],
      ["confirm-mint"],
    ]);
    expect(plan.operations.map(({ walletConfirmationRequired }) => walletConfirmationRequired)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
    expect(plan.requiredSigner).toEqual({
      role: "tokenizer",
      walletAddress: "0x1111111111111111111111111111111111111111",
    });
  });

  it("makes confirmation, read-back, standalone whitelist, and final verification explicit", async () => {
    const plan = await buildExecutionPlanV1(validManifest());
    expect(plan.operations[1].intent.reads).toEqual(["TOKEN_INFO", "TOKENIZER_INFO"]);
    expect(plan.operations[3].intent.reads).toEqual(["WHITELIST_STATUS"]);
    expect(plan.operations[4].intent.whitelistPolicy).toBe(
      "REQUIRE_CONFIRMED_STANDALONE_WHITELIST",
    );
    expect(plan.operations[5].intent.reads).toEqual(["BALANCE_AND_WHITELIST"]);
    expect(plan.operations[5].intent.expected.balancePolicy).toBe(
      "EQUALS_MINT_AMOUNT_FOR_NEW_INVESTOR",
    );
    expect(plan.operations[6].intent.requires).toEqual([
      "TOKENIZATION_CONFIRMED",
      "TOKEN_READ_BACK_MATCHED",
      "WHITELIST_CONFIRMED",
      "WHITELIST_READ_BACK_MATCHED",
      "MINT_CONFIRMED",
      "BALANCE_READ_BACK_MATCHED",
    ]);
  });

  it("matches the independently calculated literal golden hashes", async () => {
    const plan = await buildExecutionPlanV1(validManifest());
    expect(plan.manifestHash).toBe(GOLDEN_MANIFEST_HASH);
    expect(plan.planHash).toBe(GOLDEN_PLAN_HASH);
  });

  it("is identical across repeated builds", async () => {
    const manifest = validManifest();
    const left = await buildExecutionPlanV1(manifest);
    const right = await buildExecutionPlanV1(manifest);
    expect(left).toEqual(right);
    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
  });

  it("creates new nested values and returns a deeply frozen plan", async () => {
    const manifest = validManifest();
    const plan = await buildExecutionPlanV1(manifest);
    expect(plan.operations[0].intent.asset).not.toBe(manifest.asset);
    expect(plan.operations[0].intent.tokenizer).not.toBe(manifest.tokenizer);
    expect(plan.operations[2].intent.investor).not.toBe(manifest.investor);
    expectDeepFrozen(plan);

    expect(Reflect.set(plan, "planVersion", "2.0")).toBe(false);
    expect(Reflect.set(plan.operations[0].intent.asset, "name", "Mutated")).toBe(false);
    expect(Reflect.set(plan.operations, "0", null)).toBe(false);
    expect(plan.planVersion).toBe("1.0");
    expect(plan.operations[0].intent.asset.name).toBe("Café Receivables");
  });

  it("returns a deeply frozen normalized manifest that resists runtime mutation", () => {
    const manifest = validManifest();
    expectDeepFrozen(manifest);
    expect(Reflect.set(manifest.asset, "name", "Mutated")).toBe(false);
    expect(Reflect.set(manifest.investor, "mintAmount", "999")).toBe(false);
    expect(manifest.asset.name).toBe("Café Receivables");
    expect(manifest.investor.mintAmount).toBe("25");
  });

  it("hashes the body without planHash and includes summaries in that body", async () => {
    const plan = await buildExecutionPlanV1(validManifest());
    const { planHash: omittedPlanHash, ...body } = plan;
    void omittedPlanHash;
    expect((await hashCanonicalJson(body)).hash).toBe(plan.planHash);

    const mutableBody = structuredClone(body);
    expect(Reflect.set(mutableBody.operations[0], "summary", "Changed summary template.")).toBe(true);
    expect((await hashCanonicalJson(mutableBody)).hash).not.toBe(plan.planHash);
  });

  it("contains no transport, credential, transaction, timestamp, or random-ID fields", async () => {
    const serialized = canonicalizeJson(await buildExecutionPlanV1(validManifest()));
    expect(serialized).not.toMatch(
      /apiKey|privateKey|seedPhrase|https?:\/\/api\.|POST|GET|txHash|txId|timestamp|createdAt|runId/i,
    );
  });

  it("rejects a forged branded cast at the public builder boundary", async () => {
    const forged = createValidRawManifest() as unknown as NormalizedAssetManifestV1;
    await expect(buildExecutionPlanV1(forged)).rejects.toMatchObject({
      code: "INVALID_NORMALIZED_MANIFEST",
      path: "$",
    } satisfies Partial<ExecutionPlanBuildError>);
  });

  it("exposes a deeply readonly public plan type", async () => {
    const plan: ExecutionPlanV1 = await buildExecutionPlanV1(validManifest());
    expect(plan.planVersion).toBe("1.0");
  });
});
