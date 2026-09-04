import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("run security boundaries", () => {
  const directory = path.resolve(__dirname);
  const root = path.resolve(directory, "../../..");

  it("marks every runtime security module server-only", () => {
    for (const filename of ["config.ts", "index.ts", "run-access.ts", "tokens.ts", "wallet-approval.ts"]) {
      const content = fs.readFileSync(path.join(directory, filename), "utf8").trim();
      expect(content, filename).toMatch(/^import "server-only";/);
    }
  });

  it("contains no RPC, fetch, contract-wallet fallback or private-key operation", () => {
    const content = ["run-access.ts", "tokens.ts", "wallet-approval.ts"]
      .map((filename) => fs.readFileSync(path.join(directory, filename), "utf8"))
      .join("\n");
    expect(content).not.toMatch(/\bfetch\s*\(|createPublicClient|readContract|verifyTypedData/);
    expect(content).not.toMatch(/privateKeyToAccount|generatePrivateKey|personal_sign|\bpersonalSign\s*\(/);
  });

  it("keeps security modules out of core and client code", () => {
    for (const relative of ["src/core", "src/components", "src/app/page.tsx"]) {
      const absolute = path.join(root, relative);
      const files = fs.statSync(absolute).isDirectory()
        ? fs.readdirSync(absolute).map((name) => path.join(absolute, name))
        : [absolute];
      for (const filename of files) {
        if (!/\.(?:ts|tsx)$/.test(filename)) continue;
        expect(fs.readFileSync(filename, "utf8"), filename).not.toMatch(/@\/server\/security/);
      }
    }
  });

  it("defines only an empty server-side secret placeholder", () => {
    const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    expect(example).toContain("EDICT_RUN_SECURITY_SECRET=");
    expect(example).not.toMatch(/NEXT_PUBLIC_.*RUN_SECURITY/);
    expect(example).not.toMatch(/EDICT_RUN_SECURITY_SECRET=.+/);
  });
});
