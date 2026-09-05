import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHASE8_CLIENT_AUDIT_SENTINEL,
  runPhase8ClientBundleAudit,
  runPhase8ClientBundleAuditCli,
  type Phase8AuditFileSystem,
  type Phase8AuditProcessBoundary,
  type Phase8BuildResult,
  type Phase8ClientBundleAuditOptions,
} from "./phase8-client-bundle-audit";

const REVISION = "a".repeat(40);
const TRACKED_FILES = ["package.json", "src/app/page.tsx"] as const;
const EXPECTED_APP_PATHS = {
  "/_not-found/page": "app/_not-found/page.js",
  "/page": "app/page.js",
  "/api/runs/route": "app/api/runs/route.js",
  "/api/runs/[runId]/route": "app/api/runs/[runId]/route.js",
  "/api/runs/[runId]/approval/route": "app/api/runs/[runId]/approval/route.js",
  "/api/runs/[runId]/approval-challenges/route":
    "app/api/runs/[runId]/approval-challenges/route.js",
  "/api/runs/[runId]/cancel/route": "app/api/runs/[runId]/cancel/route.js",
};

const temporaryDirectories: string[] = [];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edict-phase8-audit-test-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "package.json"), '{"private":true}');
  fs.writeFileSync(path.join(root, "src", "app", "page.tsx"), "export default function Page(){}\n");
  return root;
}

function nodeFileSystem(
  overrides: Partial<Phase8AuditFileSystem> = {},
): Phase8AuditFileSystem {
  return {
    copyDirectory: (source, destination) => { fs.cpSync(source, destination, { recursive: true }); },
    exists: (target) => fs.existsSync(target),
    lstat: (target) => fs.lstatSync(target),
    mkdir: (target, options) => { fs.mkdirSync(target, options); },
    mkdtemp: (prefix) => fs.mkdtempSync(prefix),
    readDirectory: (target) => fs.readdirSync(target),
    readFile: (target) => fs.readFileSync(target),
    remove: (target) => { fs.rmSync(target, { recursive: true }); },
    writeFile: (target, value) => { fs.writeFileSync(target, value); },
    ...overrides,
  };
}

function writeValidBuild(workspace: string, patch: {
  readonly appPaths?: Record<string, string>;
  readonly client?: string;
} = {}): void {
  const next = path.join(workspace, ".next");
  fs.mkdirSync(path.join(next, "server"), { recursive: true });
  fs.mkdirSync(path.join(next, "static", "chunks"), { recursive: true });
  fs.writeFileSync(path.join(next, "BUILD_ID"), "fresh-build-id");
  fs.writeFileSync(path.join(next, "build-manifest.json"), '{"pages":{"/":[]}}');
  fs.writeFileSync(path.join(next, "app-build-manifest.json"), '{"pages":{"/page":[]}}');
  fs.writeFileSync(path.join(next, "prerender-manifest.json"), '{"routes":{"/":{}}}');
  fs.writeFileSync(path.join(next, "routes-manifest.json"), '{"version":3,"staticRoutes":[],"dynamicRoutes":[]}');
  fs.writeFileSync(
    path.join(next, "server", "app-paths-manifest.json"),
    JSON.stringify(patch.appPaths ?? EXPECTED_APP_PATHS),
  );
  fs.writeFileSync(
    path.join(next, "static", "chunks", "app.js"),
    patch.client ?? "globalThis.__EDICT_PUBLIC_APP__=true;",
  );
}

function processBoundary(
  build: (input: Parameters<Phase8AuditProcessBoundary["runBuild"]>[0]) => Phase8BuildResult,
  files: readonly string[] = TRACKED_FILES,
): Phase8AuditProcessBoundary {
  return {
    sourceRevision: () => REVISION,
    trackedFiles: () => files,
    runBuild: build,
  };
}

function options(input: {
  readonly root?: string;
  readonly build: (value: Parameters<Phase8AuditProcessBoundary["runBuild"]>[0]) => Phase8BuildResult;
  readonly fileSystem?: Phase8AuditFileSystem;
  readonly files?: readonly string[];
}): Phase8ClientBundleAuditOptions {
  const root = input.root ?? fixtureRoot();
  return {
    projectRoot: root,
    temporaryRoot: root,
    dependencies: {
      fileSystem: input.fileSystem,
      process: processBoundary(input.build, input.files),
    },
  };
}

async function expectCliFailure(value: Phase8ClientBundleAuditOptions): Promise<void> {
  const output: string[] = [];
  await expect(runPhase8ClientBundleAuditCli({
    audit: () => runPhase8ClientBundleAudit(value),
    write: (text) => output.push(text),
  })).resolves.toBe(1);
  expect(output).toEqual([
    '{"ok":false,"error":{"code":"PHASE8_CLIENT_BUNDLE_AUDIT_FAILED"}}\n',
  ]);
  expect(output.join("")).not.toContain('"ok":true');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("fresh source-bound Phase 8 client artifact audit", () => {
  it("binds a fresh complete artifact set to the exact copied source digest", async () => {
    const build = vi.fn((input: Parameters<Phase8AuditProcessBoundary["runBuild"]>[0]) => {
      writeValidBuild(input.workspace);
      return { status: 0, output: "built offline" };
    });
    const value = options({ build });
    await expect(runPhase8ClientBundleAudit(value)).resolves.toMatchObject({
      sourceRevision: REVISION,
      sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      builder: "turbopack",
      apiRoutes: [
        "/api/runs",
        "/api/runs/[runId]",
        "/api/runs/[runId]/approval",
        "/api/runs/[runId]/approval-challenges",
        "/api/runs/[runId]/cancel",
      ],
    });
    expect(build).toHaveBeenCalledOnce();
    expect(fs.readdirSync(value.projectRoot).some(
      (name) => name.startsWith("edict-phase8-client-audit-"),
    )).toBe(false);
  });

  it("uses webpack only after removing a Turbopack sandbox-restriction partial build", async () => {
    const build = vi.fn((input: Parameters<Phase8AuditProcessBoundary["runBuild"]>[0]) => {
      if (input.builder === "turbopack") {
        fs.mkdirSync(path.join(input.workspace, ".next"));
        fs.writeFileSync(path.join(input.workspace, ".next", "stale"), "partial");
        return { status: 1, output: "binding to a port: Operation not permitted" };
      }
      expect(fs.existsSync(path.join(input.workspace, ".next"))).toBe(false);
      writeValidBuild(input.workspace);
      return { status: 0, output: "webpack built offline" };
    });
    await expect(runPhase8ClientBundleAudit(options({ build }))).resolves.toMatchObject({
      builder: "webpack",
    });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing artifact directory", () => undefined],
    ["empty artifact directory", (workspace: string) => {
      fs.mkdirSync(path.join(workspace, ".next", "static"), { recursive: true });
    }],
    ["empty client files", (workspace: string) => {
      writeValidBuild(workspace);
      fs.writeFileSync(path.join(workspace, ".next", "static", "chunks", "app.js"), "");
    }],
    ["absent build manifests", (workspace: string) => {
      writeValidBuild(workspace);
      fs.rmSync(path.join(workspace, ".next", "routes-manifest.json"));
    }],
    ["malformed manifests", (workspace: string) => {
      writeValidBuild(workspace);
      fs.writeFileSync(path.join(workspace, ".next", "routes-manifest.json"), "not-json");
    }],
    ["stale artifacts", (workspace: string) => {
      writeValidBuild(workspace);
      for (const filename of [
        "BUILD_ID",
        "app-build-manifest.json",
        "build-manifest.json",
        "prerender-manifest.json",
        "routes-manifest.json",
        "server/app-paths-manifest.json",
        "static/chunks/app.js",
      ]) fs.utimesSync(path.join(workspace, ".next", filename), new Date(0), new Date(0));
    }],
    ["source-digest mismatch", (workspace: string) => {
      writeValidBuild(workspace);
      fs.writeFileSync(path.join(workspace, "src", "app", "page.tsx"), "changed after digest\n");
    }],
    ["wrong route inventory", (workspace: string) => {
      writeValidBuild(workspace, { appPaths: { ...EXPECTED_APP_PATHS, "/api/extra/route": "extra.js" } });
    }],
    ["harness route leakage", (workspace: string) => {
      writeValidBuild(workspace, {
        appPaths: { ...EXPECTED_APP_PATHS, "/api/phase8-harness/route": "harness.js" },
      });
    }],
    ["credential-name leakage", (workspace: string) => {
      writeValidBuild(workspace, { client: "globalThis.key='BRICKKEN_API_KEY';" });
    }],
    ["credential-value leakage", (workspace: string) => {
      writeValidBuild(workspace, { client: `globalThis.key='${PHASE8_CLIENT_AUDIT_SENTINEL}';` });
    }],
  ])("fails closed without success output for %s", async (_label, populate) => {
    await expectCliFailure(options({
      build: ({ workspace }) => {
        populate(workspace);
        return { status: 0, output: "claimed success" };
      },
    }));
  });

  it("fails closed for a failed build", async () => {
    await expectCliFailure(options({ build: () => ({ status: 1, output: "build failed" }) }));
  });

  it("fails closed for a client-artifact scan failure", async () => {
    const base = nodeFileSystem();
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, output: "built" };
      },
      fileSystem: nodeFileSystem({
        readFile: (target) => {
          if (target.endsWith(path.join("static", "chunks", "app.js"))) {
            throw new Error("scan failure");
          }
          return base.readFile(target);
        },
      }),
    }));
  });

  it("fails closed for cleanup failure", async () => {
    const base = nodeFileSystem();
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, output: "built" };
      },
      fileSystem: nodeFileSystem({
        remove: (target) => {
          if (path.basename(target).startsWith("edict-phase8-client-audit-")) {
            throw new Error("cleanup failure");
          }
          base.remove(target);
        },
      }),
    }));
  });

  it("fails closed when the temporary tracked-source copy is incomplete", async () => {
    const base = nodeFileSystem();
    const build = vi.fn(() => ({ status: 0, output: "must not build" }));
    await expectCliFailure(options({
      build,
      fileSystem: nodeFileSystem({
        writeFile: (target, value) => {
          if (target.endsWith(path.join("workspace", "src", "app", "page.tsx"))) return;
          base.writeFile(target, value);
        },
      }),
    }));
    expect(build).not.toHaveBeenCalled();
  });

  it("rejects a tracked runtime environment file without reading it", async () => {
    const root = fixtureRoot();
    const environmentFile = path.join(root, ".env.production");
    fs.writeFileSync(environmentFile, "must-not-be-read");
    const base = nodeFileSystem();
    const readFile = vi.fn((target: string) => {
      if (target === environmentFile) throw new Error("environment file was read");
      return base.readFile(target);
    });
    await expectCliFailure(options({
      root,
      files: [...TRACKED_FILES, ".env.production"],
      build: () => ({ status: 0, output: "must not build" }),
      fileSystem: nodeFileSystem({ readFile }),
    }));
    expect(readFile).not.toHaveBeenCalledWith(environmentFile);
  });

  it("reports success only after a complete audit and cleanup", async () => {
    const result = Object.freeze({
      sourceRevision: REVISION,
      sourceDigest: `sha256:${"b".repeat(64)}` as const,
      artifactDigest: `sha256:${"c".repeat(64)}` as const,
      builder: "webpack" as const,
      apiRoutes: Object.freeze(Object.keys(EXPECTED_APP_PATHS)
        .filter((value) => value.endsWith("/route"))
        .map((value) => value.slice(0, -6))
        .sort()),
    });
    const output: string[] = [];
    await expect(runPhase8ClientBundleAuditCli({
      audit: async () => result,
      write: (value) => output.push(value),
    })).resolves.toBe(0);
    expect(JSON.parse(output.join(""))).toEqual({ ok: true, category: "PHASE8_CLIENT_BUNDLE_AUDIT", ...result });
  });

  it("inherits no environment and applies an outbound-network-denial profile", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "phase8-client-bundle-audit.ts"), "utf8");
    expect(source).not.toMatch(/dotenv|env-file|process\.env/);
    expect(source).toContain("(deny network*)");
    expect(source).toContain('BRICKKEN_API_KEY: PHASE8_CLIENT_AUDIT_SENTINEL');
  });
});
