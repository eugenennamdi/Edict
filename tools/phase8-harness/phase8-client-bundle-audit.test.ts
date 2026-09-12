import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHASE8_CLIENT_AUDIT_SENTINEL,
  capturePhase8HarnessPage,
  runPhase8ClientBundleAudit,
  runPhase8ClientBundleAuditCli,
  type Phase8AuditFileSystem,
  type Phase8AuditProcessBoundary,
  type Phase8BuildResult,
  type Phase8ClientBundleAuditOptions,
  type Phase8HarnessPageCaptureInput,
} from "./phase8-client-bundle-audit";
import { renderHarnessPage } from "./runtime";

const REVISION = "a".repeat(40);
const TRACKED_FILES = ["package.json", "src/app/page.tsx"] as const;
const EXPECTED_APP_PATHS = {
  "/_not-found/page": "app/_not-found/page.js",
  "/page": "app/page.js",
  "/records/[runId]/page": "app/records/[runId]/page.js",
  "/api/runs/route": "app/api/runs/route.js",
  "/api/runs/[runId]/route": "app/api/runs/[runId]/route.js",
  "/api/runs/[runId]/approval/route": "app/api/runs/[runId]/approval/route.js",
  "/api/runs/[runId]/approval-challenges/route":
    "app/api/runs/[runId]/approval-challenges/route.js",
  "/api/runs/[runId]/broadcast-hash/route": "app/api/runs/[runId]/broadcast-hash/route.js",
  "/api/runs/[runId]/broadcast-unknown/route": "app/api/runs/[runId]/broadcast-unknown/route.js",
  "/api/runs/[runId]/cancel/route": "app/api/runs/[runId]/cancel/route.js",
  "/api/runs/[runId]/prepare/route": "app/api/runs/[runId]/prepare/route.js",
  "/api/runs/[runId]/wallet-authorization/route": "app/api/runs/[runId]/wallet-authorization/route.js",
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
    writeNewFile: (target, value) => {
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, value); } finally { fs.closeSync(fd); }
  },
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

function writeHarnessCapture(
  input: Phase8HarnessPageCaptureInput,
  html = renderHarnessPage(),
): void {
  input.fileSystem.mkdir(input.artifactRoot, { recursive: true });
  input.fileSystem.writeFile(path.join(input.artifactRoot, "index.html"), html);
  input.fileSystem.writeFile(
    path.join(input.artifactRoot, "response-headers.json"),
    '[["content-type","text/html; charset=utf-8"]]',
  );
}

function clientPath(workspace: string): string {
  return path.join(workspace, ".next", "static", "chunks", "app.js");
}

function replaceClientWithRelativeLink(workspace: string, content: string): void {
  const target = path.join(workspace, "linked-client.js");
  fs.writeFileSync(target, content);
  fs.rmSync(clientPath(workspace));
  fs.symlinkSync(path.relative(path.dirname(clientPath(workspace)), target), clientPath(workspace));
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
  readonly captureHarnessPage?: (value: Phase8HarnessPageCaptureInput) => void | Promise<void>;
}): Phase8ClientBundleAuditOptions {
  const root = input.root ?? fixtureRoot();
  return {
    projectRoot: root,
    temporaryRoot: root,
    dependencies: {
      fileSystem: input.fileSystem,
      process: processBoundary(input.build, input.files),
      captureHarnessPage: input.captureHarnessPage,
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
      return { status: 0, stdout: "built offline", stderr: "" };
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
        "/api/runs/[runId]/broadcast-hash",
        "/api/runs/[runId]/broadcast-unknown",
        "/api/runs/[runId]/cancel",
        "/api/runs/[runId]/prepare",
        "/api/runs/[runId]/wallet-authorization",
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
        return { status: 1, stdout: "", stderr: "binding to a port: Operation not permitted" };
      }
      expect(fs.existsSync(path.join(input.workspace, ".next"))).toBe(false);
      writeValidBuild(input.workspace);
      return { status: 0, stdout: "webpack built offline", stderr: "" };
    });
    await expect(runPhase8ClientBundleAudit(options({ build }))).resolves.toMatchObject({
      builder: "webpack",
    });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["symlink to sentinel-bearing JavaScript", (workspace: string) => {
      replaceClientWithRelativeLink(workspace, PHASE8_CLIENT_AUDIT_SENTINEL);
    }],
    ["symlink to benign JavaScript", (workspace: string) => {
      replaceClientWithRelativeLink(workspace, "globalThis.benign=true;");
    }],
    ["relative symlink", (workspace: string) => {
      replaceClientWithRelativeLink(workspace, "globalThis.relative=true;");
    }],
    ["absolute symlink", (workspace: string) => {
      const target = path.join(workspace, "absolute-client.js");
      fs.writeFileSync(target, "globalThis.absolute=true;");
      fs.rmSync(clientPath(workspace));
      fs.symlinkSync(target, clientPath(workspace));
    }],
    ["broken symlink", (workspace: string) => {
      fs.rmSync(clientPath(workspace));
      fs.symlinkSync("../../../missing-client.js", clientPath(workspace));
    }],
    ["chained symlink", (workspace: string) => {
      const target = path.join(workspace, "chain-target.js");
      const intermediate = path.join(workspace, "chain-intermediate.js");
      fs.writeFileSync(target, "globalThis.chain=true;");
      fs.symlinkSync("chain-target.js", intermediate);
      fs.rmSync(clientPath(workspace));
      fs.symlinkSync(path.relative(path.dirname(clientPath(workspace)), intermediate), clientPath(workspace));
    }],
    ["symlinked directory", (workspace: string) => {
      const target = path.join(workspace, "linked-directory");
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(workspace, ".next", "static", "linked-directory"));
    }],
  ])("fails closed for a browser artifact %s", async (_label, addLink) => {
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        addLink(workspace);
        return { status: 0, stdout: "built", stderr: "" };
      },
    }));
  });

  it("fails closed for a symlink in captured harness-page artifacts", async () => {
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, stdout: "built", stderr: "" };
      },
      captureHarnessPage: (input) => {
        input.fileSystem.mkdir(input.artifactRoot, { recursive: true });
        const target = path.join(path.dirname(input.artifactRoot), "harness-page.html");
        input.fileSystem.writeFile(target, renderHarnessPage());
        fs.symlinkSync(target, path.join(input.artifactRoot, "index.html"));
        input.fileSystem.writeFile(
          path.join(input.artifactRoot, "response-headers.json"),
          '[["content-type","text/html"]]',
        );
      },
    }));
  });

  it("fails closed for an unsupported browser filesystem entry", async () => {
    const base = nodeFileSystem();
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, stdout: "built", stderr: "" };
      },
      fileSystem: nodeFileSystem({
        lstat: (target) => target.endsWith(path.join("static", "chunks", "app.js"))
          ? {
              size: 1,
              mtimeMs: Date.now(),
              isDirectory: () => false,
              isFile: () => false,
              isSymbolicLink: () => false,
            }
          : base.lstat(target),
      }),
    }));
  });

  it.each(["EACCES", "EIO", "ENOTDIR"])("fails closed when optional root inspection returns %s", async (code) => {
    const base = nodeFileSystem();
    await expectCliFailure(options({
      build: ({ workspace }) => { writeValidBuild(workspace); return { status: 0, stdout: "built", stderr: "" }; },
      fileSystem: nodeFileSystem({
        exists: (target) => target.endsWith("/public") ? false : base.exists(target),
        lstat: (target) => {
          if (target.endsWith("/public")) throw Object.assign(new Error("synthetic inspection failure"), { code });
          return base.lstat(target);
        },
      }),
    }));
  });

  it.each(["directory link", "broken link", "file link", "existing directory", "FIFO"])(
    "refuses a build-created capture root (%s) before touching its target", async (kind) => {
      const root = fixtureRoot();
      const target = path.join(root, "protected-target");
      fs.mkdirSync(target);
      const protectedFile = path.join(target, "original");
      fs.writeFileSync(protectedFile, "must remain unchanged");
      const capture = vi.fn(capturePhase8HarnessPage);
      const writeNewFile = vi.fn(nodeFileSystem().writeNewFile);
      await expectCliFailure(options({
        root, captureHarnessPage: capture, fileSystem: nodeFileSystem({ writeNewFile }),
        build: ({ workspace }) => {
          writeValidBuild(workspace);
          const captureRoot = path.join(workspace, ".phase8-audit-browser");
          if (kind === "existing directory") fs.mkdirSync(captureRoot);
          else if (kind === "FIFO") execFileSync("/usr/bin/mkfifo", [captureRoot]);
          else fs.symlinkSync(kind === "directory link" ? target : kind === "file link" ? protectedFile : path.join(target, "missing"), captureRoot);
          return { status: 0, stdout: "built", stderr: "" };
        },
      }));
      expect(capture).not.toHaveBeenCalled();
      expect(writeNewFile).not.toHaveBeenCalled();
      expect(fs.readdirSync(target)).toEqual(["original"]);
      expect(fs.readFileSync(protectedFile, "utf8")).toBe("must remain unchanged");
    },
  );

  it.each(["symlink", "FIFO"])("exclusive capture file creation refuses an injected %s without following it", async (kind) => {
    const root = fixtureRoot();
    const target = path.join(root, "protected-file");
    fs.writeFileSync(target, "unchanged");
    const base = nodeFileSystem();
    await expectCliFailure(options({
      root,
      build: ({ workspace }) => { writeValidBuild(workspace); return { status: 0, stdout: "built", stderr: "" }; },
      fileSystem: nodeFileSystem({
        writeNewFile: (filename, value) => {
          if (filename.endsWith("/index.html")) {
            if (kind === "symlink") fs.symlinkSync(target, filename);
            else execFileSync("/usr/bin/mkfifo", [filename]);
          }
          base.writeNewFile(filename, value);
        },
      }),
    }));
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
  });

  it.each([".next/static", ".next/server/app", "public"])("refuses a broken link at browser root %s", async (relative) => {
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        const entry = path.join(workspace, relative);
        fs.rmSync(entry, { recursive: true, force: true });
        fs.symlinkSync("missing-synthetic-target", entry);
        return { status: 0, stdout: "built", stderr: "" };
      },
    }));
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
        return { status: 0, stdout: "claimed success", stderr: "" };
      },
    }));
  });

  it("fails closed for a failed build", async () => {
    await expectCliFailure(options({
      build: () => ({ status: 1, stdout: "build failed", stderr: "" }),
    }));
  });

  it.each([
    ["captured stdout sentinel", { stdout: PHASE8_CLIENT_AUDIT_SENTINEL, stderr: "" }],
    ["captured stderr sentinel", { stdout: "", stderr: PHASE8_CLIENT_AUDIT_SENTINEL }],
    ["captured credential name", { stdout: "BRICKKEN_API_KEY", stderr: "" }],
    ["empty build output", { stdout: "", stderr: "" }],
  ])("fails closed for %s", async (_label, streams) => {
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, ...streams };
      },
    }));
  });

  it("captures the exact real pre-bootstrap harness page without starting a server", async () => {
    const root = fixtureRoot();
    const artifactRoot = path.join(root, "captured-harness-page");
    await capturePhase8HarnessPage({ artifactRoot, fileSystem: nodeFileSystem() });
    expect(fs.readFileSync(path.join(artifactRoot, "index.html"), "utf8"))
      .toBe(renderHarnessPage());
    expect(fs.readdirSync(artifactRoot).sort()).toEqual(["index.html", "response-headers.json"]);
  });

  it.each([
    ["sentinel in emitted harness HTML", PHASE8_CLIENT_AUDIT_SENTINEL],
    ["credential name in harness HTML", "BRICKKEN_API_KEY"],
    ["target metadata before bootstrap", "phase8-client-artifact-audit"],
  ])("fails closed for %s", async (_label, html) => {
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, stdout: "built", stderr: "" };
      },
      captureHarnessPage: (input) => writeHarnessCapture(input, html),
    }));
  });

  it("fails closed when real harness-page construction fails", async () => {
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, stdout: "built", stderr: "" };
      },
      captureHarnessPage: () => { throw new Error("page construction failed"); },
    }));
  });

  it("fails closed when captured harness-page scanning fails", async () => {
    const base = nodeFileSystem();
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, stdout: "built", stderr: "" };
      },
      fileSystem: nodeFileSystem({
        readFile: (target) => {
          if (target.endsWith(path.join(".phase8-audit-browser", "index.html"))) {
            throw new Error("page scan failed");
          }
          return base.readFile(target);
        },
      }),
    }));
  });

  it("fails closed for a client-artifact scan failure", async () => {
    const base = nodeFileSystem();
    await expectCliFailure(options({
      build: ({ workspace }) => {
        writeValidBuild(workspace);
        return { status: 0, stdout: "built", stderr: "" };
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
        return { status: 0, stdout: "built", stderr: "" };
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
    const build = vi.fn(() => ({ status: 0, stdout: "must not build", stderr: "" }));
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
      build: () => ({ status: 0, stdout: "must not build", stderr: "" }),
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
