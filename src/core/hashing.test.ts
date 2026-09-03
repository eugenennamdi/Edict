import { describe, expect, it } from "vitest";
import { buildExecutionPlanV1 } from "./execution-plan";
import {
  CoreHashError,
  hashAssetManifestV1,
  sha256Utf8,
} from "./hashing";
import {
  validateAssetManifestV1,
  type NormalizedAssetManifestV1,
} from "./manifest";
import {
  createValidRawManifest,
  GOLDEN_MANIFEST_CANONICAL,
  GOLDEN_MANIFEST_HASH,
  GOLDEN_PLAN_HASH,
} from "./test-fixtures";

function validManifest(): NormalizedAssetManifestV1 {
  const result = validateAssetManifestV1(createValidRawManifest());
  if (!result.ok) throw new Error("The test fixture must be valid.");
  return result.value;
}

describe("core hashing", () => {
  it("matches the standard literal SHA-256 vector for UTF-8 text", async () => {
    expect(await sha256Utf8("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the independently calculated golden manifest canonical text and hash", async () => {
    const result = await hashAssetManifestV1(validManifest());
    expect(result.canonicalJson).toBe(GOLDEN_MANIFEST_CANONICAL);
    expect(result.hash).toBe(GOLDEN_MANIFEST_HASH);
    expect(result.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces identical hashes for normalization-equivalent manifests", async () => {
    const leftRaw = createValidRawManifest();
    const rightRaw = createValidRawManifest();
    rightRaw.asset.name = "Café     Receivables";
    rightRaw.asset.symbol = "ED1";
    rightRaw.asset.supplyCap = "1000";

    const left = validateAssetManifestV1(leftRaw);
    const right = validateAssetManifestV1(rightRaw);
    if (!left.ok || !right.ok) throw new Error("Fixtures must be valid.");
    expect((await hashAssetManifestV1(left.value)).hash).toBe(
      (await hashAssetManifestV1(right.value)).hash,
    );
  });

  it("changes the manifest and plan hashes when a material field changes", async () => {
    const changedRaw = createValidRawManifest();
    changedRaw.investor.mintAmount = "26";
    const changed = validateAssetManifestV1(changedRaw);
    if (!changed.ok) throw new Error("Fixture must be valid.");

    expect((await hashAssetManifestV1(changed.value)).hash).not.toBe(GOLDEN_MANIFEST_HASH);
    expect((await buildExecutionPlanV1(changed.value)).planHash).not.toBe(GOLDEN_PLAN_HASH);
  });

  it("rejects a cast object that did not cross the validation boundary", async () => {
    const forged = createValidRawManifest() as unknown as NormalizedAssetManifestV1;
    await expect(hashAssetManifestV1(forged)).rejects.toMatchObject({
      code: "INVALID_NORMALIZED_MANIFEST",
      path: "$",
    } satisfies Partial<CoreHashError>);
  });

  it("retains no mutable references to raw input before later hashing and planning", async () => {
    const raw = createValidRawManifest();
    const validation = validateAssetManifestV1(raw);
    if (!validation.ok) throw new Error("Fixture must be valid.");

    raw.asset.name = "Mutated Asset";
    raw.asset.symbol = "BAD";
    raw.asset.supplyCap = "999999";
    raw.tokenizer.email = "mutated@example.com";
    raw.investor.mintAmount = "999999";

    const manifestIdentity = await hashAssetManifestV1(validation.value);
    const plan = await buildExecutionPlanV1(validation.value);
    expect(validation.value.asset.name).toBe("Café Receivables");
    expect(manifestIdentity.canonicalJson).toBe(GOLDEN_MANIFEST_CANONICAL);
    expect(manifestIdentity.hash).toBe(GOLDEN_MANIFEST_HASH);
    expect(plan.manifestHash).toBe(GOLDEN_MANIFEST_HASH);
    expect(plan.planHash).toBe(GOLDEN_PLAN_HASH);
  });
});
