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
      "src/client/wallet/approval.ts",
      "src/client/wallet/discovery.ts",
      "src/client/wallet/errors.ts",
      "src/client/wallet/execution.ts",
      "src/client/wallet/index.ts",
      "src/client/wallet/session.ts",
    ]) {
      expect(source(path)).toMatch(/^"use client";\n\nimport "client-only";/);
    }
  });

  it("keeps the callable route inventory at the five approved non-execution routes", () => {
    const routes = filesBelow(join(root, "src/app/api"))
      .filter((path) => path.endsWith("route.ts"))
      .map((path) => relative(join(root, "src/app"), path))
      .sort();
    expect(routes).toEqual([
      "api/runs/[runId]/approval-challenges/route.ts",
      "api/runs/[runId]/approval/route.ts",
      "api/runs/[runId]/cancel/route.ts",
      "api/runs/[runId]/route.ts",
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

  it("keeps Phase D approval readiness free of signing, approval HTTP, execution, persistence, and secret capabilities", () => {
    const readinessSource = [
      "src/components/approval/approval-controller.ts",
      "src/components/approval/approval-section.tsx",
    ].map(source).join("\n");
    expect(readinessSource).not.toMatch(/requestExplicit|eth_sign|eth_sendTransaction|approval-challenges|submitApproval|ApprovalGateway|client\/wallet\/execution/u);
    expect(readinessSource).not.toMatch(/Brickken|RPC|localStorage|sessionStorage|document\.cookie|BRICKKEN_API_KEY|DATABASE_URL|console\.|\.focus\(/u);
  });

  it("marks invocation immediately before the direct provider call with no await boundary", () => {
    expect(source("src/client/wallet/execution.ts")).toMatch(
      /providerInvoked = true;\n\s+const pendingResult = input\.wallet\.requestExplicit\("eth_sendTransaction"/u,
    );
  });

  it("performs no provider or network call when wallet modules are imported", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    await Promise.all([import("./index"), import("../run-api/approval-gateway")]);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
