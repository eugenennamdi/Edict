import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import inventory from "./index.json";

const vectorsDir = path.resolve(__dirname);

describe("Brickken sourced test vectors", () => {
  it("lists every vector file with provenance and a classified origin", () => {
    const origins = new Set([
      "copied-official-example",
      "minimally-normalised-official-example",
      "constructed-from-official-schema",
    ]);
    const confidences = new Set(["VERIFIED", "INFERENCE", "UNKNOWN", "CONFLICT", "EDICT_DECISION"]);

    expect(inventory.vectors.length).toBeGreaterThan(0);
    for (const vector of inventory.vectors) {
      expect(vector.id).toMatch(/^[a-zA-Z0-9-]+$/);
      expect(origins.has(vector.origin)).toBe(true);
      expect(confidences.has(vector.confidence)).toBe(true);
      expect(vector.source).toBeTruthy();
      expect(vector.accessed).toBe("2026-09-03");
      expect(fs.existsSync(path.join(vectorsDir, vector.file))).toBe(true);
    }
  });

  it("parses every fixture as JSON without credentials or private keys", () => {
    for (const vector of inventory.vectors) {
      const content = fs.readFileSync(path.join(vectorsDir, vector.file), "utf-8");
      expect(() => JSON.parse(content)).not.toThrow();
      expect(content).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
      expect(content).not.toMatch(/BRICKKEN_API_KEY\s*=\s*['"]?[a-zA-Z0-9_\-]{20,}['"]?/);
      expect(content).not.toMatch(/YOUR_BRICKKEN_API_KEY|YOUR_API_KEY/);
    }
  });

  it("records omitted unofficial success bodies instead of inventing them", () => {
    const omitted = new Set(inventory.omitted.map((entry) => entry.id));
    expect(omitted.has("whitelist-status-string-variant")).toBe(true);
    expect(omitted.has("send-confirmed-client-broadcast-response")).toBe(true);
    expect(omitted.has("live-prepare-or-send-bodies")).toBe(true);
    expect(
      inventory.vectors.some((vector) => vector.file.includes("string")),
    ).toBe(false);
  });
});
