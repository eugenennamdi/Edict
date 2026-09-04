import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("database persistence boundaries", () => {
  const rootDir = path.resolve(__dirname, "../../..");
  const persistenceDir = path.resolve(__dirname);

  it("marks every runtime persistence module as server-only", () => {
    for (const filename of ["codec.ts", "config.ts", "index.ts", "repository.ts", "store.ts"]) {
      const content = fs.readFileSync(path.join(persistenceDir, filename), "utf8").trim();
      expect(content, filename).toMatch(/^import "server-only";/);
    }
  });

  it("does not construct a Neon client or perform a query at module import", () => {
    const store = fs.readFileSync(path.join(persistenceDir, "store.ts"), "utf8");
    const beforeFactory = store.slice(0, store.indexOf("export function createDrizzleExecutionRunStore"));
    expect(beforeFactory).not.toMatch(/\bneon\s*\(/);
    expect(beforeFactory).not.toMatch(/\.execute\s*\(/);
  });

  it("performs no network request while importing the Neon store module", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error("Unexpected network request during module import.");
    };
    try {
      await import("./store");
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("contains Neon and Drizzle imports inside the server persistence adapter", () => {
    const offenders: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(absolute);
          continue;
        }
        if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) continue;
        const relative = path.relative(rootDir, absolute);
        const content = fs.readFileSync(absolute, "utf8");
        if (/from\s+["'](?:drizzle-orm|@neondatabase\/serverless)/.test(content) &&
            !relative.startsWith(path.join("src", "server", "persistence"))) {
          offenders.push(relative);
        }
      }
    };
    visit(path.join(rootDir, "src"));
    expect(offenders).toEqual([]);
  });

  it("keeps database modules out of core, application and client code", () => {
    for (const directory of ["src/core", "src/app", "src/components"]) {
      const absolute = path.join(rootDir, directory);
      for (const filename of fs.readdirSync(absolute)) {
        if (!/\.(?:ts|tsx)$/.test(filename)) continue;
        const content = fs.readFileSync(path.join(absolute, filename), "utf8");
        expect(content, path.join(directory, filename)).not.toMatch(
          /(?:drizzle-orm|@neondatabase\/serverless|@\/server\/persistence)/,
        );
      }
    }
  });

  it("keeps the opt-in database verification independent from Brickken", () => {
    const liveTest = fs.readFileSync(
      path.join(persistenceDir, "database-live.smoke.test.ts"),
      "utf8",
    );
    expect(liveTest).not.toMatch(/@\/server\/brickken|from\s+["'][^"']*brickken|\bfetch\s*\(/i);
  });
});
