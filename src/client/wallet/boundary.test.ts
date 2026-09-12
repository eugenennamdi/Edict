import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

const root = process.cwd();

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("wallet trust-boundary invariants", () => {
  it("keeps runtime wallet modules explicitly client-only", () => {
    for (const path of [
      "src/client/run-api/approval-gateway.ts",
      "src/client/run-api/wallet-execution-gateway.ts",
      "src/client/wallet/approval.ts",
      "src/client/wallet/discovery.ts",
      "src/client/wallet/errors.ts",
      "src/client/wallet/index.ts",
      "src/client/wallet/session.ts",
      "src/client/wallet/v4-execution.ts",
    ]) {
      expect(source(path)).toMatch(/^"use client";\n\nimport "client-only";/);
    }
  });

  it("keeps the callable route inventory at the twelve approved routes", () => {
    const routes = filesBelow(join(root, "src/app/api"))
      .filter((path) => path.endsWith("route.ts"))
      .map((path) => relative(join(root, "src/app"), path))
      .sort();
    expect(routes).toEqual([
      "api/runs/[runId]/approval-challenges/route.ts",
      "api/runs/[runId]/approval/route.ts",
      "api/runs/[runId]/broadcast-hash/route.ts",
      "api/runs/[runId]/broadcast-unknown/route.ts",
      "api/runs/[runId]/cancel/route.ts",
      "api/runs/[runId]/prepare/route.ts",
      "api/runs/[runId]/promote/route.ts",
      "api/runs/[runId]/readiness/route.ts",
      "api/runs/[runId]/route.ts",
      "api/runs/[runId]/track/route.ts",
      "api/runs/[runId]/wallet-authorization/route.ts",
      "api/runs/route.ts",
    ]);
  });

  it("contains no vendor privilege, fallback signing, browser persistence, logging, or secret access", () => {
    const walletSource = ["src/client/wallet", "src/client/run-api"]
      .flatMap((directory) => filesBelow(join(root, directory)))
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(walletSource).not.toMatch(/MetaMask|Rabby|Coinbase|WalletConnect|personal_sign|eth_signTransaction|eth_sendRawTransaction/iu);
    expect(walletSource).not.toMatch(/localStorage|sessionStorage|document\.cookie|BRICKKEN_API_KEY|DATABASE_URL|console\./u);
    expect(walletSource).not.toMatch(/window\.ethereum/u);
  });

  it("keeps the approval HTTP gateway outside provider and execution boundaries", () => {
    const gateway = source("src/client/run-api/approval-gateway.ts");
    expect(gateway).not.toMatch(/wallet\/(?:discovery|session|execution)|eth_signTypedData_v4|eth_sendTransaction|window\.|document\.|Storage/u);
    expect(gateway).not.toMatch(/capability|cookie|challenge.*(?:mac|purpose)|console\./iu);
  });

  it("keeps the preparation review UI outside every wallet and broadcast boundary", () => {
    const review = [
      source("src/components/execution-review-section.tsx"),
      source("src/components/run-planning.ts"),
    ].join("\n");
    expect(review).not.toMatch(/client\/wallet\/execution|eth_sendTransaction|eth_sign|requestExplicit|window\.ethereum|localStorage|sessionStorage|document\.cookie/u);
    expect(review).not.toMatch(/BRICKKEN_API_KEY|DATABASE_URL|EDICT_RUN_SECURITY_SECRET|console\./u);
    expect(review.match(/\/prepare`/gu)).toHaveLength(1);
    expect(review).not.toMatch(/\/broadcast|\/confirm|\/poll|\/read-back|\/receipt/u);
  });

  it("keeps Phase E signing inside the approved coordinator and excludes execution, persistence, and secrets", () => {
    const readinessSource = [
      "src/components/approval/approval-controller.ts",
      "src/components/approval/approval-section.tsx",
    ].map(source).join("\n");
    const approvalUi = source("src/components/approval/approval-section.tsx");
    const approvalBoundary = source("src/client/wallet/approval.ts");
    expect(approvalUi).not.toMatch(/requestExplicit|eth_sign|submitApproval|approval-challenges/u);
    expect(readinessSource).not.toMatch(/eth_sendTransaction|personal_sign|client\/wallet\/execution/u);
    expect(readinessSource).not.toMatch(/Brickken|RPC|localStorage|sessionStorage|document\.cookie|BRICKKEN_API_KEY|DATABASE_URL|console\./u);
    expect(approvalBoundary.match(/"eth_signTypedData_v4"/gu)).toHaveLength(1);
    expect(approvalBoundary).not.toMatch(/personal_sign|eth_sign"|eth_sendTransaction/u);
  });

  it("keeps exactly one V4 product send call site and excludes raw signing", () => {
    const productionClientSource = ["src/client", "src/components"]
      .flatMap((directory) => filesBelow(join(root, directory)))
      .filter((path) => /\.(?:ts|tsx)$/.test(path) && !/\.test\.(?:ts|tsx)$/.test(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(productionClientSource.match(/method:\s*"eth_sendTransaction"/gu)).toHaveLength(1);
    expect(productionClientSource).not.toMatch(/eth_sendRawTransaction|eth_signTransaction|privateKey|seed phrase/u);
  });

  it("performs no provider or network call when wallet modules are imported", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    await Promise.all([
      import("./index"),
      import("../run-api/approval-gateway"),
      import("../run-api/wallet-execution-gateway"),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
