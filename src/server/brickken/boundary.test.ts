import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getBrickkenServerConfig } from "./index";

describe("Brickken server boundary architecture assertions", () => {
  const rootDir = path.resolve(__dirname, "../../..");

  it("ensures src/server/brickken/index.ts explicitly imports server-only as its first statement", () => {
    const filePath = path.resolve(__dirname, "index.ts");
    const content = fs.readFileSync(filePath, "utf-8").trim();
    expect(content.startsWith('import "server-only";')).toBe(true);
  });

  it("ensures src/server/index.ts explicitly imports server-only as its first statement", () => {
    const filePath = path.resolve(__dirname, "../index.ts");
    const content = fs.readFileSync(filePath, "utf-8").trim();
    expect(content.startsWith('import "server-only";')).toBe(true);
  });

  it("ensures src/server/env.ts explicitly imports server-only as its first statement", () => {
    const filePath = path.resolve(__dirname, "../env.ts");
    const content = fs.readFileSync(filePath, "utf-8").trim();
    expect(content.startsWith('import "server-only";')).toBe(true);
  });

  it("ensures src/server/execution/index.ts explicitly imports server-only as its first statement", () => {
    const filePath = path.resolve(__dirname, "../execution/index.ts");
    const content = fs.readFileSync(filePath, "utf-8").trim();
    expect(content.startsWith('import "server-only";')).toBe(true);
  });

  it("ensures getBrickkenServerConfig handles missing API key safely without throwing", () => {
    const originalKey = process.env.BRICKKEN_API_KEY;
    try {
      delete process.env.BRICKKEN_API_KEY;
      const config = getBrickkenServerConfig();
      expect(config.apiKey).toBeUndefined();
      expect(config.baseUrl).toBe("https://api.sandbox.brickken.com");
      expect(config.chainId).toBe(11155111);
    } finally {
      if (originalKey !== undefined) {
        process.env.BRICKKEN_API_KEY = originalKey;
      }
    }
  });

  it("ensures .env.example contains no real credentials and no secret-bearing NEXT_PUBLIC_ variables", () => {
    const envExamplePath = path.resolve(rootDir, ".env.example");
    const lines = fs.readFileSync(envExamplePath, "utf-8").split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const [key, ...rest] = trimmed.split("=");
      const value = rest.join("=").trim();

      // Ensure no NEXT_PUBLIC_ variable contains key or secret
      if (key.startsWith("NEXT_PUBLIC_")) {
        expect(key).not.toMatch(/API_KEY|SECRET|TOKEN|KEY/i);
      }

      // Ensure BRICKKEN_API_KEY is empty or a placeholder
      if (key === "BRICKKEN_API_KEY") {
        expect(value).toBe("");
      }
    }
  });

  it("ensures client/domain code does not directly import from server-only directories", () => {
    const checkDir = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          checkDir(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          const content = fs.readFileSync(fullPath, "utf-8");
          // Check for illegal client imports of server-only modules
          expect(content).not.toMatch(/from\s+["']@\/server/);
          expect(content).not.toMatch(/from\s+["']\.\.?\/server/);
        }
      }
    };

    checkDir(path.resolve(rootDir, "src/core"));
    checkDir(path.resolve(rootDir, "src/components"));
  });

  it("ensures core imports no server, Brickken, Node crypto, or network modules", () => {
    const coreDir = path.resolve(rootDir, "src/core");
    const forbiddenImport = /(?:from\s+|import\s*)["'](?:@\/server(?:\/|["'])|\.\.?\/server(?:\/|["'])|brickken-sdk(?:\/|["'])|(?:node:)?crypto["']|node:(?:http|https|net|tls)["']|axios["']|got["']|ky["']|undici["'])/;

    for (const entry of fs.readdirSync(coreDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const content = fs.readFileSync(path.join(coreDir, entry.name), "utf-8");
      expect(content, entry.name).not.toMatch(forbiddenImport);
      expect(content, entry.name).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("ensures tracked source files do not contain high-entropy credentials or private keys", () => {
    const scanDir = (dirPath: string) => {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".next") {
          continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && !entry.name.endsWith(".log")) {
          const content = fs.readFileSync(fullPath, "utf-8");
          // Never contain private keys
          expect(content).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
          // Distinguish variable name BRICKKEN_API_KEY from actual assigned credential values
          expect(content).not.toMatch(/BRICKKEN_API_KEY\s*=\s*['"]?[a-zA-Z0-9_\-]{20,}['"]?/);
        }
      }
    };

    scanDir(path.resolve(rootDir, "src"));
    scanDir(path.resolve(rootDir, "docs"));
  });
});
