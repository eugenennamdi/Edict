import "server-only";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OneTimeBootstrapVerifier } from "./auth";
import { readPhase8HarnessConfig } from "./config";
import { Phase8HarnessRuntime } from "./runtime";

export const PHASE8_CLIENT_AUDIT_SENTINEL =
  "phase8-synthetic-client-credential-sentinel-7f6c";

const PROHIBITED_PUBLIC_TOKENS = Object.freeze([
  PHASE8_CLIENT_AUDIT_SENTINEL,
  "BRICKKEN_API_KEY",
  "NEXT_PUBLIC_BRICKKEN_API_KEY",
  "DATABASE_URL",
  "EDICT_SEPOLIA_RPC_URL",
  "EDICT_RUN_SECURITY_SECRET",
  "createBrickkenReadExecutor",
  "createBrickkenReadTransport",
  "brickken-sdk",
  "node:crypto",
] as const);

export interface Phase8ClientBundleAuditOptions {
  readonly projectRoot: string;
  readonly temporaryRoot?: string;
  readonly productionPublicDirectory?: string;
  readonly renderPage?: () => string | Promise<string>;
  readonly cleanup?: (directory: string) => void;
}

function auditDirectory(directory: string): void {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED");
  }
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filename = path.join(entry.parentPath, entry.name);
    const content = fs.readFileSync(filename);
    const rendered = content.toString("utf8");
    if (PROHIBITED_PUBLIC_TOKENS.some((token) => rendered.includes(token))) {
      throw new Error("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED");
    }
  }
}

async function emitHarnessPage(config: ReturnType<typeof readPhase8HarnessConfig>): Promise<string> {
  const runtime = new Phase8HarnessRuntime({
    config,
    bootstrap: new OneTimeBootstrapVerifier(
      "phase8-client-audit-bootstrap-secret-at-least-32-characters",
      { nowMs: () => 0 },
    ),
    executorFactory: () => { throw new Error("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED"); },
    clock: { nowMs: () => 0 },
  });
  const origin = `http://${config.host}:${config.port}`;
  const response = await runtime.handle(new Request(`${origin}/`, {
    headers: { host: `${config.host}:${config.port}` },
  }));
  if (response.status !== 200) throw new Error("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED");
  return response.text();
}

export async function runPhase8ClientBundleAudit(
  options: Phase8ClientBundleAuditOptions,
): Promise<void> {
  const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "edict-phase8-client-audit-"));
  const cleanup = options.cleanup ?? ((target: string) => fs.rmSync(target, { recursive: true }));
  let auditError: unknown;
  try {
    const config = readPhase8HarnessConfig({
      EDICT_PHASE8_MODE: "sandbox",
      EDICT_PHASE8_HOST: "127.0.0.1",
      EDICT_PHASE8_PORT: "43119",
      EDICT_PHASE8_ACTION: "BRICKKEN_READ",
      EDICT_PHASE8_RUN_ID: "bundle-audit-run",
      EDICT_PHASE8_OPERATION_KIND: "TOKENIZE",
      BRICKKEN_API_KEY: PHASE8_CLIENT_AUDIT_SENTINEL,
    });
    const publicDirectory = path.join(directory, "public");
    fs.mkdirSync(publicDirectory);
    const renderedPage = options.renderPage === undefined
      ? await emitHarnessPage(config)
      : await options.renderPage();
    fs.writeFileSync(path.join(publicDirectory, "index.html"), renderedPage);
    auditDirectory(publicDirectory);
    auditDirectory(
      options.productionPublicDirectory ?? path.join(options.projectRoot, ".next", "static"),
    );
  } catch (error) {
    auditError = error;
  }
  try {
    cleanup(directory);
  } catch {
    throw new Error("PHASE8_CLIENT_BUNDLE_CLEANUP_FAILED");
  }
  if (fs.existsSync(directory)) throw new Error("PHASE8_CLIENT_BUNDLE_CLEANUP_FAILED");
  if (auditError !== undefined) throw new Error("PHASE8_CLIENT_BUNDLE_AUDIT_FAILED");
}

export async function runPhase8ClientBundleAuditCli(input: {
  readonly audit?: () => void | Promise<void>;
  readonly write: (value: string) => unknown;
}): Promise<number> {
  try {
    await (input.audit ?? (() => runPhase8ClientBundleAudit({ projectRoot: process.cwd() })))();
    input.write('{"ok":true,"category":"PHASE8_CLIENT_BUNDLE_AUDIT"}\n');
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
