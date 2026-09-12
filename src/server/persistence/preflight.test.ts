import { describe, expect, it } from "vitest";
import {
  computeLocalMigration0003Hash,
  DatabasePreflightError,
} from "./preflight";

describe("computeLocalMigration0003Hash", () => {
  it("computes the exact SHA-256 hash of drizzle/0003_mushy_sugar_man.sql matching expectation", () => {
    const hash = computeLocalMigration0003Hash();
    expect(hash).toBe("eb8f17d0b78fca757f97908174a2462391449eb40d1da91c9fae8476c6dc4fe3");
  });

  it("throws DatabasePreflightError if migrations folder does not contain 0003 migration", () => {
    expect(() => computeLocalMigration0003Hash("/non/existent/folder")).toThrow(
      DatabasePreflightError,
    );
    expect(() => computeLocalMigration0003Hash("/non/existent/folder")).toThrow(
      /Local migration 0003 file not found/,
    );
  });
});
