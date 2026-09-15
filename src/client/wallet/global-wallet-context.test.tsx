import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createConfig, http, mock } from "wagmi";
import { connect, disconnect, reconnect } from "wagmi/actions";
import { sepolia } from "wagmi/chains";
import { createEdictWalletSession, isEip1193Provider } from "./adapter";
import { WalletBoundaryError } from "./errors";

const root = process.cwd();

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const SIGNER_OKX = "0x727e366885376cdb2c9384589d81d22b2b13f3b8" as const;
const SIGNER_RABBY = "0x1111111111111111111111111111111111111111" as const;

describe("Wagmi + RainbowKit Edict Wallet Integration", () => {
  describe("A. Framework-agnostic provider adapter", () => {
    it("validates valid EIP-1193 providers and rejects invalid ones", () => {
      expect(isEip1193Provider(null)).toBe(false);
      expect(isEip1193Provider({})).toBe(false);
      expect(isEip1193Provider({ request: "not a function" })).toBe(false);
      expect(isEip1193Provider({ request: vi.fn() })).toBe(true);
    });

    it("creates a SelectedWalletSession with generation and tamper checks", async () => {
      const mockRequest = vi.fn().mockImplementation(async ({ method }) => {
        if (method === "eth_accounts") return [SIGNER_OKX];
        if (method === "eth_chainId") return "0xaa36a7";
        return null;
      });
      const rawProvider = {
        request: mockRequest,
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      const session = createEdictWalletSession("com.okex.wallet", rawProvider);
      expect(session.selectionId).toBe("com.okex.wallet");
      expect(session.source).toBe("EIP6963");
      expect(session.generation).toBe(0);

      const readiness = await session.inspect(SIGNER_OKX);
      expect(readiness.state).toBe("READY");
      session.dispose();
    });

    it("throws WalletBoundaryError if non-provider is passed", () => {
      expect(() => createEdictWalletSession("bad", {})).toThrow(WalletBoundaryError);
    });
  });

  describe("B. No Silent Fallback Invariant (Mandatory Refinement #5)", () => {
    let storage: Map<string, string>;

    beforeEach(() => {
      storage = new Map();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, val: string) => storage.set(key, val),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      });
    });

    it("does NOT silently fall back to Rabby when OKX disconnects or becomes unavailable", async () => {
      const okxAccounts = [SIGNER_OKX] as const;
      const rabbyAccounts = [SIGNER_RABBY] as const;

      const config = createConfig({
        chains: [sepolia],
        connectors: [
          mock({
            accounts: okxAccounts,
            features: { reconnect: true },
          }),
          mock({
            accounts: rabbyAccounts,
            features: { reconnect: true },
          }),
        ],
        transports: { [sepolia.id]: http() },
      });

      const okxConnector = config.connectors[0];
      const rabbyConnector = config.connectors[1];

      // 1. User explicitly connects OKX
      const connectResult = await connect(config, { connector: okxConnector });
      expect(connectResult.accounts[0].toLowerCase()).toBe(SIGNER_OKX.toLowerCase());
      expect(config.state.current).toBe(okxConnector.uid);

      // 2. User disconnects OKX
      await disconnect(config, { connector: okxConnector });
      expect(config.state.current).toBeNull();
      expect(config.state.status).toBe("disconnected");

      // 3. Reconnect occurs (e.g. page reload) after disconnect
      await reconnect(config);

      // 4. Invariant: Rabby is NEVER silently adopted!
      expect(config.state.current).toBeNull();
      expect(config.state.status).toBe("disconnected");
      expect(config.state.connections.get(rabbyConnector.uid)).toBeUndefined();

      // 5. Explicit user switch to Rabby works
      const rabbyConnectResult = await connect(config, { connector: rabbyConnector });
      expect(rabbyConnectResult.accounts[0].toLowerCase()).toBe(SIGNER_RABBY.toLowerCase());
      expect(config.state.current).toBe(rabbyConnector.uid);
      expect(config.state.status).toBe("connected");
    });

    it("preserves active connector identity and does not switch connectors automatically", async () => {
      const okxAccounts = [SIGNER_OKX] as const;
      const rabbyAccounts = [SIGNER_RABBY] as const;

      const config = createConfig({
        chains: [sepolia],
        connectors: [
          mock({ accounts: okxAccounts, features: { reconnect: true } }),
          mock({ accounts: rabbyAccounts, features: { reconnect: true } }),
        ],
        transports: { [sepolia.id]: http() },
      });

      const okxConnector = config.connectors[0];
      const rabbyConnector = config.connectors[1];

      // User connects OKX
      await connect(config, { connector: okxConnector });
      expect(config.state.current).toBe(okxConnector.uid);

      // Invariant: Rabby connector remains unconnected
      expect(config.state.connections.get(rabbyConnector.uid)).toBeUndefined();
      expect(config.state.current).not.toBe(rabbyConnector.uid);
    });
  });

  describe("C. Send Boundary Audit (Mandatory Refinement #6)", () => {
    it("proves exactly ONE eth_sendTransaction exists across all production client code", () => {
      const productionClientFiles = ["src/client", "src/components"]
        .flatMap((directory) => filesBelow(join(root, directory)))
        .filter((path) => /\.(?:ts|tsx)$/.test(path) && !/\.test\.(?:ts|tsx)$/.test(path));

      const contents = productionClientFiles.map((path) => readFileSync(path, "utf8")).join("\n");

      // Exactly ONE eth_sendTransaction
      const sendTxMatches = contents.match(/method:\s*"eth_sendTransaction"/gu) ?? [];
      expect(sendTxMatches.length).toBe(1);

      // ZERO eth_sendRawTransaction
      expect(contents).not.toMatch(/eth_sendRawTransaction/u);

      // ZERO wagmi send transaction actions or writeContract
      expect(contents).not.toMatch(/\buseSendTransaction\b/u);
      expect(contents).not.toMatch(/\bsendTransactionAsync\b/u);
      expect(contents).not.toMatch(/\bwriteContract\b/u);
      expect(contents).not.toMatch(/\bwriteContracts\b/u);
    });
  });
});
