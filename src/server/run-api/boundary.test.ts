import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("public run API boundary", () => {
  const root = path.resolve(__dirname, "../../..");

  it("exposes exactly the six approved route modules", () => {
    const api = path.join(root, "src/app/api");
    const routes: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.name === "route.ts") routes.push(path.relative(api, target));
      }
    };
    walk(api);
    expect(routes.sort()).toEqual([
      "runs/[runId]/approval-challenges/route.ts",
      "runs/[runId]/approval/route.ts",
      "runs/[runId]/cancel/route.ts",
      "runs/[runId]/prepare/route.ts",
      "runs/[runId]/route.ts",
      "runs/route.ts",
    ]);
  });

  it("exposes preparation only and no prompt, broadcast, confirmation, polling, or verification route", () => {
    const routeTree = fs.readdirSync(path.join(root, "src/app/api/runs"), { recursive: true }).join("\n");
    expect(routeTree.match(/prepare/gi)).toHaveLength(2);
    expect(routeTree).not.toMatch(/prompt|broadcast|confirm|poll|verify|mint|whitelist|tokenize/i);
  });

  it("keeps core and client modules free of server persistence and run API imports", () => {
    for (const relative of ["src/core", "src/components", "src/app/page.tsx", "src/app/records/[runId]/page.tsx"]) {
      const target = path.join(root, relative);
      const files = fs.statSync(target).isDirectory()
        ? fs.readdirSync(target).filter((name) => /\.(?:ts|tsx)$/.test(name)).map((name) => path.join(target, name))
        : [target];
      for (const file of files) {
        expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/@\/server\/(?:persistence|run-api)|@neondatabase|drizzle-orm/);
      }
    }
  });
});
