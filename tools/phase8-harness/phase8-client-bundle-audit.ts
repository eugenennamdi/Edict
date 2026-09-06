import "server-only";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OneTimeBootstrapVerifier } from "./auth";
import { expectedHarnessOrigin, readPhase8HarnessConfig } from "./config";
import { Phase8HarnessRuntime, renderHarnessPage } from "./runtime";

export const PHASE8_CLIENT_AUDIT_SENTINEL =
  "phase8-synthetic-client-credential-sentinel-7f6c";
const PHASE8_BOOTSTRAP_AUDIT_SENTINEL =
  "phase8-synthetic-bootstrap-verifier-sentinel-4d2a";

const EXPECTED_API_ROUTES = Object.freeze([
  "/api/runs",
  "/api/runs/[runId]",
  "/api/runs/[runId]/approval",
  "/api/runs/[runId]/approval-challenges",
  "/api/runs/[runId]/cancel",
] as const);

const EXPECTED_APP_PATHS = Object.freeze([
  "/_not-found/page",
  "/page",
  ...EXPECTED_API_ROUTES.map((route) => `${route}/route`),
] as const);

const ALLOWED_APP_PATHS = new Set([...EXPECTED_APP_PATHS, "/_global-error/page"]);

const REQUIRED_MANIFESTS = Object.freeze([
  ".next/BUILD_ID",
  ".next/build-manifest.json",
  ".next/prerender-manifest.json",
  ".next/routes-manifest.json",
  ".next/server/app-paths-manifest.json",
] as const);

const PROHIBITED_PUBLIC_TOKENS = Object.freeze([
  PHASE8_CLIENT_AUDIT_SENTINEL,
  PHASE8_BOOTSTRAP_AUDIT_SENTINEL,
  "BRICKKEN_API_KEY",
  "NEXT_PUBLIC_BRICKKEN_API_KEY",
  "DATABASE_URL",
  "EDICT_SEPOLIA_RPC_URL",
  "EDICT_RUN_SECURITY_SECRET",
  "EDICT_PHASE8_MODE",
  "EDICT_PHASE8_HOST",
  "EDICT_PHASE8_PORT",
  "EDICT_PHASE8_ACTION",
  "EDICT_PHASE8_RUN_ID",
  "EDICT_PHASE8_OPERATION_KIND",
  "EDICT_PHASE8_WALLET_REQUEST_HASH",
  "createBrickkenReadExecutor",
  "createBrickkenReadTransport",
  "Phase8HarnessRuntime",
  "OneTimeBootstrapVerifier",
  "createBootstrapSecret",
  "startPhase8HarnessServer",
  "tools/phase8-harness",
  "phase8-harness",
  "brickken-sdk",
  "node:crypto",
  "node:http",
  "node:net",
] as const);

const MAX_AUDITED_FILE_BYTES = 64 * 1_024 * 1_024;
const BUILD_TIMEOUT_MS = 180_000;
const HARNESS_AUDIT_RUN_ID = "phase8-client-artifact-audit";
const HARNESS_AUDIT_ORIGIN = "http://127.0.0.1:43119";
const HARNESS_PROTECTED_TARGET_VALUES = Object.freeze([
  "sandbox",
  "127.0.0.1",
  "43119",
  HARNESS_AUDIT_ORIGIN,
  "BRICKKEN_READ",
  HARNESS_AUDIT_RUN_ID,
  "TOKENIZE",
] as const);

interface AuditStats {
  readonly size: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface Phase8AuditFileSystem {
  copyDirectory(source: string, destination: string): void;
  exists(target: string): boolean;
  lstat(target: string): AuditStats;
  mkdir(target: string, options?: { readonly recursive?: boolean }): void;
  mkdtemp(prefix: string): string;
  readDirectory(target: string): string[];
  readFile(target: string): Buffer;
  remove(target: string): void;
  writeFile(target: string, value: string | Uint8Array): void;
}

export interface Phase8BuildResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Phase8HarnessPageCaptureInput {
  readonly artifactRoot: string;
  readonly fileSystem: Phase8AuditFileSystem;
}

export interface Phase8AuditProcessBoundary {
  sourceRevision(projectRoot: string): string;
  trackedFiles(projectRoot: string): readonly string[];
  runBuild(input: {
    readonly workspace: string;
    readonly networkPolicy: string;
    readonly builder: "turbopack" | "webpack";
  }): Phase8BuildResult;
}

export interface Phase8ClientBundleAuditDependencies {
  readonly fileSystem?: Phase8AuditFileSystem;
  readonly process?: Phase8AuditProcessBoundary;
  readonly captureHarnessPage?: (input: Phase8HarnessPageCaptureInput) => void | Promise<void>;
}

export interface Phase8ClientBundleAuditOptions {
  readonly projectRoot: string;
  readonly temporaryRoot?: string;
  readonly dependencies?: Phase8ClientBundleAuditDependencies;
}

export interface Phase8ClientBundleAuditResult {
  readonly sourceRevision: string;
  readonly sourceDigest: `sha256:${string}`;
  readonly artifactDigest: `sha256:${string}`;
  readonly builder: "turbopack" | "webpack";
  readonly apiRoutes: readonly string[];
}

const NODE_FILE_SYSTEM: Phase8AuditFileSystem = {
  copyDirectory: (source, destination) => {
    fs.cpSync(source, destination, {
      recursive: true,
      errorOnExist: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
  },
  exists: (target) => fs.existsSync(target),
  lstat: (target) => fs.lstatSync(target),
  mkdir: (target, options) => { fs.mkdirSync(target, options); },
  mkdtemp: (prefix) => fs.mkdtempSync(prefix),
  readDirectory: (target) => fs.readdirSync(target),
  readFile: (target) => fs.readFileSync(target),
  remove: (target) => { fs.rmSync(target, { recursive: true }); },
  writeFile: (target, value) => { fs.writeFileSync(target, value); },
};

function commandResult(command: string, args: readonly string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    maxBuffer: 8 * 1_024 * 1_024,
    timeout: BUILD_TIMEOUT_MS,
  });
}

const NODE_PROCESS_BOUNDARY: Phase8AuditProcessBoundary = {
  sourceRevision(projectRoot) {
    const result = commandResult("git", ["rev-parse", "HEAD"], projectRoot);
    const revision = result.stdout.trim();
    if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(revision)) {
      throw new Error("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED");
    }
    return revision;
  },
  trackedFiles(projectRoot) {
    const result = spawnSync("git", ["ls-files", "-z", "--cached"], {
      cwd: projectRoot,
      env: { PATH: "/usr/bin:/bin" },
      encoding: "buffer",
      maxBuffer: 8 * 1_024 * 1_024,
      timeout: BUILD_TIMEOUT_MS,
    });
    if (result.status !== 0 || !(result.stdout instanceof Buffer)) {
      throw new Error("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED");
    }
    return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  },
  runBuild({ workspace, networkPolicy, builder }) {
    const args = [
      "-f",
      networkPolicy,
      "/usr/bin/env",
      "node",
      "node_modules/next/dist/bin/next",
      "build",
      ...(builder === "webpack" ? ["--webpack"] : []),
    ];
    const result = spawnSync("/usr/bin/sandbox-exec", args, {
      cwd: workspace,
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        CI: "1",
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        BRICKKEN_API_KEY: PHASE8_CLIENT_AUDIT_SENTINEL,
      },
      maxBuffer: 16 * 1_024 * 1_024,
      timeout: BUILD_TIMEOUT_MS,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

function fail(): never {
  throw new Error("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED");
}

function artifactFail(code: string): never {
  throw new Error(`PHASE8_CLIENT_BUNDLE_ARTIFACT_${code}`);
}

function isRuntimeEnvironmentFile(relative: string): boolean {
  const name = path.posix.basename(relative);
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

function validateTrackedPath(relative: string): void {
  if (
    relative.length === 0 || relative.includes("\0") || path.isAbsolute(relative) ||
    path.posix.normalize(relative) !== relative || relative === ".." || relative.startsWith("../") ||
    relative === ".next" || relative.startsWith(".next/") ||
    relative === "node_modules" || relative.startsWith("node_modules/") ||
    isRuntimeEnvironmentFile(relative)
  ) fail();
}

function updateDigest(hash: ReturnType<typeof createHash>, relative: string, content: Buffer): void {
  const name = Buffer.from(relative, "utf8");
  const sizes = Buffer.allocUnsafe(16);
  sizes.writeBigUInt64BE(BigInt(name.byteLength), 0);
  sizes.writeBigUInt64BE(BigInt(content.byteLength), 8);
  hash.update(sizes).update(name).update(content);
}

function copyTrackedSnapshot(input: {
  readonly fileSystem: Phase8AuditFileSystem;
  readonly projectRoot: string;
  readonly workspace: string;
  readonly files: readonly string[];
}): `sha256:${string}` {
  const hash = createHash("sha256");
  for (const relative of input.files) {
    validateTrackedPath(relative);
    const source = path.join(input.projectRoot, relative);
    const stat = input.fileSystem.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) fail();
    const content = input.fileSystem.readFile(source);
    const destination = path.join(input.workspace, relative);
    input.fileSystem.mkdir(path.dirname(destination), { recursive: true });
    input.fileSystem.writeFile(destination, content);
    updateDigest(hash, relative, content);
  }
  return `sha256:${hash.digest("hex")}`;
}

function digestSnapshot(input: {
  readonly fileSystem: Phase8AuditFileSystem;
  readonly workspace: string;
  readonly files: readonly string[];
}): `sha256:${string}` {
  const hash = createHash("sha256");
  for (const relative of input.files) {
    const target = path.join(input.workspace, relative);
    if (!input.fileSystem.exists(target)) fail();
    const stat = input.fileSystem.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) fail();
    updateDigest(hash, relative, input.fileSystem.readFile(target));
  }
  return `sha256:${hash.digest("hex")}`;
}

function walkFiles(fileSystem: Phase8AuditFileSystem, root: string): string[] {
  let rootStat: AuditStats;
  if (!fileSystem.exists(root)) {
    try {
      rootStat = fileSystem.lstat(root);
    } catch {
      return [];
    }
  } else {
    rootStat = fileSystem.lstat(root);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) artifactFail("UNSUPPORTED_ENTRY");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fileSystem.readDirectory(directory).sort()) {
      const target = path.join(directory, name);
      const stat = fileSystem.lstat(target);
      if (stat.isSymbolicLink()) artifactFail("SYMLINK");
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile()) files.push(target);
      else artifactFail("UNSUPPORTED_ENTRY");
    }
  };
  visit(root);
  return files;
}

function parseManifest(
  fileSystem: Phase8AuditFileSystem,
  filename: string,
): Record<string, unknown> {
  if (!fileSystem.exists(filename)) fail();
  const stat = fileSystem.lstat(filename);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_AUDITED_FILE_BYTES) fail();
  try {
    const parsed: unknown = JSON.parse(fileSystem.readFile(filename).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail();
    return parsed as Record<string, unknown>;
  } catch {
    return fail();
  }
}

function validateRoutes(
  fileSystem: Phase8AuditFileSystem,
  workspace: string,
): readonly string[] {
  const routes = parseManifest(fileSystem, path.join(workspace, ".next", "routes-manifest.json"));
  if (
    typeof routes.version !== "number" || !Number.isSafeInteger(routes.version) ||
    !Array.isArray(routes.staticRoutes) || !Array.isArray(routes.dynamicRoutes)
  ) fail();
  const appPaths = parseManifest(
    fileSystem,
    path.join(workspace, ".next", "server", "app-paths-manifest.json"),
  );
  const actualPaths = Object.keys(appPaths).sort();
  if (
    EXPECTED_APP_PATHS.some((value) => !actualPaths.includes(value)) ||
    actualPaths.some((value) => !ALLOWED_APP_PATHS.has(value))
  ) fail();
  if (actualPaths.some((value) => /phase8|harness/i.test(value))) fail();
  const apiRoutes = actualPaths
    .filter((value) => value.endsWith("/route"))
    .map((value) => value.slice(0, -"/route".length))
    .sort();
  if (apiRoutes.join("\0") !== [...EXPECTED_API_ROUTES].sort().join("\0")) fail();
  return Object.freeze(apiRoutes);
}

function browserArtifacts(
  fileSystem: Phase8AuditFileSystem,
  workspace: string,
  harnessRoot: string,
): string[] {
  const staticRoot = path.join(workspace, ".next", "static");
  const staticFiles = walkFiles(fileSystem, staticRoot);
  if (staticFiles.length === 0) artifactFail("STATIC_MISSING");
  const javascript = staticFiles.filter((filename) => filename.endsWith(".js"));
  if (javascript.length === 0 || javascript.some((filename) => fileSystem.lstat(filename).size === 0)) {
    artifactFail("JAVASCRIPT_MISSING");
  }
  const serverApp = walkFiles(fileSystem, path.join(workspace, ".next", "server", "app"))
    .filter((filename) => /\.(?:body|html|rsc|txt)$/.test(filename));
  const publicFiles = walkFiles(fileSystem, path.join(workspace, "public"));
  const harnessFiles = walkFiles(fileSystem, harnessRoot);
  if (harnessFiles.length === 0) artifactFail("HARNESS_PAGE_MISSING");
  return [...staticFiles, ...serverApp, ...publicFiles, ...harnessFiles].sort();
}

function assertContentSafe(content: string | Buffer): void {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  for (const token of PROHIBITED_PUBLIC_TOKENS) {
    if (bytes.includes(Buffer.from(token, "utf8"))) artifactFail("PROHIBITED_TOKEN");
  }
}

function assertBuildOutputSafe(build: Phase8BuildResult): void {
  if (build.stdout.length === 0 && build.stderr.length === 0) artifactFail("BUILD_OUTPUT_EMPTY");
  assertContentSafe(build.stdout);
  assertContentSafe(build.stderr);
}

export async function capturePhase8HarnessPage(
  input: Phase8HarnessPageCaptureInput,
): Promise<void> {
  const clock = Object.freeze({ nowMs: () => 1_000 });
  const config = readPhase8HarnessConfig({
    EDICT_PHASE8_MODE: "sandbox",
    EDICT_PHASE8_HOST: "127.0.0.1",
    EDICT_PHASE8_PORT: "43119",
    EDICT_PHASE8_ACTION: "BRICKKEN_READ",
    EDICT_PHASE8_RUN_ID: HARNESS_AUDIT_RUN_ID,
    EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
    BRICKKEN_API_KEY: PHASE8_CLIENT_AUDIT_SENTINEL,
  });
  const runtime = new Phase8HarnessRuntime({
    config,
    bootstrap: new OneTimeBootstrapVerifier(PHASE8_BOOTSTRAP_AUDIT_SENTINEL, clock),
    executorFactory: () => { throw new Error("PHASE8_AUDIT_EXECUTOR_REFUSED"); },
    clock,
  });
  const origin = expectedHarnessOrigin(config);
  const response = await runtime.handle(new Request(`${origin}/`, {
    method: "GET",
    headers: { host: new URL(origin).host },
  }));
  const html = await response.text();
  if (
    response.status !== 200 || html.length === 0 || html !== renderHarnessPage() ||
    HARNESS_PROTECTED_TARGET_VALUES.some((value) => html.includes(value))
  ) artifactFail("HARNESS_PAGE_INVALID");
  input.fileSystem.mkdir(input.artifactRoot, { recursive: true });
  input.fileSystem.writeFile(path.join(input.artifactRoot, "index.html"), html);
  input.fileSystem.writeFile(
    path.join(input.artifactRoot, "response-headers.json"),
    JSON.stringify([...response.headers.entries()].sort(([left], [right]) => left.localeCompare(right))),
  );
}

function validateCapturedHarnessPage(
  fileSystem: Phase8AuditFileSystem,
  harnessRoot: string,
): void {
  const files = walkFiles(fileSystem, harnessRoot);
  const htmlPath = path.join(harnessRoot, "index.html");
  const headersPath = path.join(harnessRoot, "response-headers.json");
  if (
    files.length !== 2 || !files.includes(htmlPath) || !files.includes(headersPath) ||
    fileSystem.lstat(htmlPath).size === 0 || fileSystem.lstat(headersPath).size === 0
  ) artifactFail("HARNESS_PAGE_INVALID");
  const html = fileSystem.readFile(htmlPath).toString("utf8");
  assertContentSafe(html);
  if (
    html !== renderHarnessPage() ||
    HARNESS_PROTECTED_TARGET_VALUES.some((value) => html.includes(value))
  ) artifactFail("HARNESS_PAGE_INVALID");
  const headers = fileSystem.readFile(headersPath);
  assertContentSafe(headers);
  try {
    const parsed: unknown = JSON.parse(headers.toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length === 0) artifactFail("HARNESS_PAGE_INVALID");
  } catch {
    artifactFail("HARNESS_PAGE_INVALID");
  }
}

function validateAndDigestArtifacts(input: {
  readonly fileSystem: Phase8AuditFileSystem;
  readonly workspace: string;
  readonly harnessRoot: string;
  readonly buildStartedAt: number;
}): `sha256:${string}` {
  const required = REQUIRED_MANIFESTS.map((relative) => path.join(input.workspace, relative));
  for (const filename of required) {
    if (!input.fileSystem.exists(filename)) {
      artifactFail(`MANIFEST_MISSING_${path.relative(input.workspace, filename).split(path.sep).join("_")}`);
    }
    const stat = input.fileSystem.lstat(filename);
    if (!stat.isFile() || stat.size === 0) artifactFail("MANIFEST_EMPTY");
    if (stat.mtimeMs < input.buildStartedAt) artifactFail("MANIFEST_STALE");
  }
  const buildManifest = parseManifest(
    input.fileSystem,
    path.join(input.workspace, ".next", "build-manifest.json"),
  );
  if (
    buildManifest.pages === null || typeof buildManifest.pages !== "object" ||
    Array.isArray(buildManifest.pages)
  ) artifactFail("MANIFEST_SHAPE");
  const prerenderManifest = parseManifest(
    input.fileSystem,
    path.join(input.workspace, ".next", "prerender-manifest.json"),
  );
  if (
    prerenderManifest.routes === null || typeof prerenderManifest.routes !== "object" ||
    Array.isArray(prerenderManifest.routes) ||
    !Object.hasOwn(prerenderManifest.routes, "/")
  ) {
    artifactFail("MANIFEST_SHAPE");
  }
  const artifacts = browserArtifacts(input.fileSystem, input.workspace, input.harnessRoot);
  const hash = createHash("sha256");
  for (const filename of [...required, ...artifacts].sort()) {
    const stat = input.fileSystem.lstat(filename);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_AUDITED_FILE_BYTES) {
      artifactFail("FILE_INVALID");
    }
    if (filename.includes(`${path.sep}.next${path.sep}`) && stat.mtimeMs < input.buildStartedAt) {
      artifactFail("FILE_STALE");
    }
    const content = input.fileSystem.readFile(filename);
    assertContentSafe(content);
    updateDigest(hash, path.relative(input.workspace, filename).split(path.sep).join("/"), content);
  }
  return `sha256:${hash.digest("hex")}`;
}

function writeNetworkPolicy(fileSystem: Phase8AuditFileSystem, filename: string): void {
  fileSystem.writeFile(filename, `(version 1)
(allow default)
(deny network*)
`);
}

function isTurbopackSandboxRestriction(result: Phase8BuildResult): boolean {
  return result.status !== 0 &&
    `${result.stdout}\n${result.stderr}`.includes("binding to a port") &&
    `${result.stdout}\n${result.stderr}`.includes("Operation not permitted");
}

export async function runPhase8ClientBundleAudit(
  options: Phase8ClientBundleAuditOptions,
): Promise<Phase8ClientBundleAuditResult> {
  const fileSystem = options.dependencies?.fileSystem ?? NODE_FILE_SYSTEM;
  const processBoundary = options.dependencies?.process ?? NODE_PROCESS_BOUNDARY;
  const captureHarnessPage = options.dependencies?.captureHarnessPage ?? capturePhase8HarnessPage;
  const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  const directory = fileSystem.mkdtemp(path.join(temporaryRoot, "edict-phase8-client-audit-"));
  let auditError: unknown;
  let result: Phase8ClientBundleAuditResult | undefined;
  try {
    const workspace = path.join(directory, "workspace");
    const control = path.join(directory, "control");
    fileSystem.mkdir(workspace, { recursive: true });
    fileSystem.mkdir(control, { recursive: true });
    const sourceRevision = processBoundary.sourceRevision(options.projectRoot);
    if (!/^[0-9a-f]{40}$/.test(sourceRevision)) fail();
    const files = [...processBoundary.trackedFiles(options.projectRoot)].sort();
    if (files.length === 0 || new Set(files).size !== files.length) fail();
    const sourceDigest = copyTrackedSnapshot({
      fileSystem,
      projectRoot: options.projectRoot,
      workspace,
      files,
    });
    if (digestSnapshot({ fileSystem, workspace, files }) !== sourceDigest) fail();
    if (fileSystem.exists(path.join(workspace, ".next"))) fail();
    const dependencies = path.join(options.projectRoot, "node_modules");
    if (!fileSystem.exists(dependencies) || !fileSystem.lstat(dependencies).isDirectory()) fail();
    fileSystem.copyDirectory(dependencies, path.join(workspace, "node_modules"));
    const networkPolicy = path.join(control, "network-disabled.sb");
    writeNetworkPolicy(fileSystem, networkPolicy);
    const marker = path.join(control, "build-started");
    fileSystem.writeFile(marker, sourceDigest);
    let buildStartedAt = fileSystem.lstat(marker).mtimeMs;

    let builder: "turbopack" | "webpack" = "turbopack";
    let build = processBoundary.runBuild({
      workspace,
      networkPolicy,
      builder,
    });
    assertBuildOutputSafe(build);
    if (isTurbopackSandboxRestriction(build)) {
      fileSystem.remove(workspace);
      fileSystem.mkdir(workspace, { recursive: true });
      if (copyTrackedSnapshot({
        fileSystem,
        projectRoot: options.projectRoot,
        workspace,
        files,
      }) !== sourceDigest) fail();
      if (fileSystem.exists(path.join(workspace, ".next"))) fail();
      fileSystem.copyDirectory(dependencies, path.join(workspace, "node_modules"));
      fileSystem.writeFile(marker, sourceDigest);
      buildStartedAt = fileSystem.lstat(marker).mtimeMs;
      builder = "webpack";
      build = processBoundary.runBuild({
        workspace,
        networkPolicy,
        builder,
      });
      assertBuildOutputSafe(build);
    }
    if (build.status !== 0) fail();
    if (digestSnapshot({ fileSystem, workspace, files }) !== sourceDigest) fail();
    const apiRoutes = validateRoutes(fileSystem, workspace);
    const harnessRoot = path.join(workspace, ".phase8-audit-browser");
    await captureHarnessPage({ artifactRoot: harnessRoot, fileSystem });
    validateCapturedHarnessPage(fileSystem, harnessRoot);
    const artifactDigest = validateAndDigestArtifacts({
      fileSystem,
      workspace,
      harnessRoot,
      buildStartedAt,
    });
    result = Object.freeze({ sourceRevision, sourceDigest, artifactDigest, builder, apiRoutes });
  } catch (error) {
    auditError = error;
  }
  try {
    fileSystem.remove(directory);
  } catch {
    throw new Error("PHASE8_CLIENT_BUNDLE_CLEANUP_FAILED");
  }
  if (fileSystem.exists(directory)) throw new Error("PHASE8_CLIENT_BUNDLE_CLEANUP_FAILED");
  if (auditError !== undefined || result === undefined) fail();
  return result;
}

export async function runPhase8ClientBundleAuditCli(input: {
  readonly audit?: () => Phase8ClientBundleAuditResult | Promise<Phase8ClientBundleAuditResult>;
  readonly write: (value: string) => unknown;
}): Promise<number> {
  try {
    const result = await (input.audit ?? (() => runPhase8ClientBundleAudit({
      projectRoot: process.cwd(),
    })))();
    input.write(`${JSON.stringify({
      ok: true,
      category: "PHASE8_CLIENT_BUNDLE_AUDIT",
      sourceRevision: result.sourceRevision,
      sourceDigest: result.sourceDigest,
      artifactDigest: result.artifactDigest,
      builder: result.builder,
      apiRoutes: result.apiRoutes,
    })}\n`);
    return 0;
  } catch {
    input.write('{"ok":false,"error":{"code":"PHASE8_CLIENT_BUNDLE_AUDIT_FAILED"}}\n');
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runPhase8ClientBundleAuditCli({ write: (value) => process.stdout.write(value) })
    .then((exitCode) => { process.exitCode = exitCode; });
}
