import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("wallet execution UI composition", () => {
  it("renders every required safe state and keeps server secrets out of the client module", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "wallet-execution-section.tsx"), "utf8");
    for (const text of [
      "Wallet required",
      "Select a wallet provider",
      "Grant account access",
      "Switch to Ethereum Sepolia",
      "Required signer unavailable",
      "Execution authorization unavailable",
      "Ready for wallet prompt",
      "Wallet prompt in progress",
      "Transaction hash recorded",
      "Broadcast outcome uncertain",
      "Reconciliation required",
    ]) expect(source).toContain(text);
    expect(source).not.toMatch(/BRICKKEN_API_KEY|DATABASE_URL|privateKey|seed phrase|eth_sendRawTransaction/u);
  });
});
