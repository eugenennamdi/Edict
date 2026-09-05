import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PHASE8_CLIENT_AUDIT_SENTINEL,
  runPhase8ClientBundleAudit,
  runPhase8ClientBundleAuditCli,
} from "./phase8-client-bundle-audit";

const temporaryDirectories: string[] = [];

function fixture(): { readonly root: string; readonly production: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edict-phase8-audit-test-"));
  temporaryDirectories.push(root);
  const production = path.join(root, ".next", "static", "chunks");
  fs.mkdirSync(production, { recursive: true });
  fs.writeFileSync(path.join(production, "app.js"), "globalThis.__EDICT_PUBLIC_APP__=true;");
  return { root, production: path.join(root, ".next", "static") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("isolated Phase 8 emitted client artifact audit", () => {
  it("builds and removes a generic harness artifact and scans actual public files", async () => {
    const value = fixture();
    await expect(runPhase8ClientBundleAudit({
      projectRoot: value.root,
      temporaryRoot: value.root,
      productionPublicDirectory: value.production,
    })).resolves.toBeUndefined();
    expect(fs.readdirSync(value.root).some((name) => name.startsWith("edict-phase8-client-audit-")))
      .toBe(false);
  });

  it("fails when the synthetic credential or server-only code enters an emitted artifact", async () => {
    for (const leaked of [PHASE8_CLIENT_AUDIT_SENTINEL, "createBrickkenReadExecutor"]) {
      const value = fixture();
      await expect(runPhase8ClientBundleAudit({
        projectRoot: value.root,
        temporaryRoot: value.root,
        productionPublicDirectory: value.production,
        renderPage: () => `<script>${leaked}</script>`,
      })).rejects.toThrow("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED");
    }
  });

  it("cannot report success when audit or cleanup fails", async () => {
    for (const audit of [
      () => { throw new Error("audit failure"); },
      async () => {
        const value = fixture();
        await runPhase8ClientBundleAudit({
          projectRoot: value.root,
          temporaryRoot: value.root,
          productionPublicDirectory: value.production,
          cleanup: () => { throw new Error("cleanup failure"); },
        });
      },
    ]) {
      const output: string[] = [];
      expect(await runPhase8ClientBundleAuditCli({ audit, write: (value) => output.push(value) }))
        .toBe(1);
      expect(output.join("")).toBe(
        '{"ok":false,"error":{"code":"PHASE8_CLIENT_BUNDLE_AUDIT_FAILED"}}\n',
      );
      expect(output.join("")).not.toContain('"ok":true');
    }
  });

  it("loads no environment file and reads no process environment", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "phase8-client-bundle-audit.ts"), "utf8");
    expect(source).not.toMatch(/dotenv|env-file|process\.env/);
  });
});
