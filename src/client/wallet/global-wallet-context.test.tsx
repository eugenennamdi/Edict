import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GlobalWalletSessionController,
  PREFERRED_WALLET_STORAGE_KEY,
} from "./global-wallet-session-controller";
import { GlobalWalletProvider } from "./global-wallet-context";
import { WalletExecutionSection } from "@/components/wallet-execution-section";
import type { PublicRunProjection } from "@/shared/run";

const SIGNER_OKX = "0x727e366885376cdb2c9384589d81d22b2b13f3b8";
const SIGNER_RABBY = "0x1111111111111111111111111111111111111111";
const SEPOLIA_HEX = "0xaa36a7";

class MockProvider {
  accounts: string[] = [];
  chain: string = SEPOLIA_HEX;
  readonly listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();

  readonly request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") {
      return this.accounts;
    }
    if (method === "eth_chainId") {
      return this.chain;
    }
    if (method === "wallet_switchEthereumChain") {
      this.chain = SEPOLIA_HEX;
      return null;
    }
    return null;
  });

  on = (event: string, listener: (...args: readonly unknown[]) => void) => {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  };

  removeListener = (event: string, listener: (...args: readonly unknown[]) => void) => {
    this.listeners.get(event)?.delete(listener);
  };

  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

function announceProvider(
  events: EventTarget,
  uuid: string,
  name: string,
  rdns: string,
  provider: MockProvider,
) {
  events.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: {
        info: {
          uuid,
          name,
          icon: "data:image/png;base64,AA==",
          rdns,
        },
        provider,
      },
    }),
  );
}

function executionRunFixture(patch: Partial<PublicRunProjection> = {}): PublicRunProjection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    schemaVersion: "4.0",
    manifestHash: `sha256:${"1".repeat(64)}`,
    planHash: `sha256:${"2".repeat(64)}`,
    environment: "sandbox",
    chainId: "11155111",
    requiredSigner: { role: "tokenizer", walletAddress: SIGNER_OKX },
    phase: "TOKENIZATION",
    status: "PREPARING",
    terminalOutcome: null,
    approved: true,
    execution: null,
    operations: [
      { id: "op-1", kind: "TOKENIZE", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
    ],
    receiptEligible: false,
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:02.000Z",
    revision: 2,
    ...patch,
  } as PublicRunProjection;
}

describe("Global Wallet Session Architecture & Invariants", () => {
  let mockStorage: Record<string, string>;
  let storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;

  beforeEach(() => {
    mockStorage = {};
    storage = {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
    };
  });

  it("A. Discovery: multiple EIP-6963 providers discovered, none auto-selected on first visit, user explicitly chooses OKX", async () => {
    const events = new EventTarget();
    const okxProvider = new MockProvider();
    okxProvider.accounts = [SIGNER_OKX];
    const rabbyProvider = new MockProvider();
    rabbyProvider.accounts = [SIGNER_RABBY];

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();

    announceProvider(events, "11111111-1111-4111-8111-111111111111", "OKX Wallet", "com.okex.wallet", okxProvider);
    announceProvider(events, "22222222-2222-4222-8222-222222222222", "Rabby Wallet", "io.rabby", rabbyProvider);

    // Initial state: Both announced, none auto-selected!
    expect(controller.getState().providers).toHaveLength(2);
    expect(controller.getState().status).toBe("DISCONNECTED");
    expect(controller.getState().selectedProvider).toBeNull();
    expect(controller.getState().address).toBeNull();

    // User explicitly connects OKX
    await controller.connect("com.okex.wallet");
    expect(controller.getState().status).toBe("CONNECTED");
    expect(controller.getState().selectedProvider?.displayName).toBe("OKX Wallet");
    expect(controller.getState().address).toBe(SIGNER_OKX);
    expect(mockStorage[PREFERRED_WALLET_STORAGE_KEY]).toBe("com.okex.wallet");
  });

  it("B. Persistence & Rabby Bug Root Cause Fix: unavailable OKX NEVER falls back to Rabby", async () => {
    mockStorage[PREFERRED_WALLET_STORAGE_KEY] = "com.okex.wallet";

    const events = new EventTarget();
    const rabbyProvider = new MockProvider();
    rabbyProvider.accounts = [SIGNER_RABBY];

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();

    // User disconnected OKX: Only Rabby is announced
    announceProvider(events, "22222222-2222-4222-8222-222222222222", "Rabby Wallet", "io.rabby", rabbyProvider);

    // CRITICAL: Edict must remain DISCONNECTED and must NEVER adopt Rabby!
    expect(controller.getState().providers).toHaveLength(1);
    expect(controller.getState().providers[0].displayName).toBe("Rabby Wallet");
    expect(controller.getState().status).toBe("DISCONNECTED");
    expect(controller.getState().selectedProvider).toBeNull();
    expect(controller.getState().address).toBeNull();
  });

  it("B2. Persistence: authorized OKX restores passively without prompt", async () => {
    mockStorage[PREFERRED_WALLET_STORAGE_KEY] = "com.okex.wallet";

    const events = new EventTarget();
    const okxProvider = new MockProvider();
    okxProvider.accounts = [SIGNER_OKX];
    const rabbyProvider = new MockProvider();
    rabbyProvider.accounts = [SIGNER_RABBY];

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();

    announceProvider(events, "11111111-1111-4111-8111-111111111111", "OKX Wallet", "com.okex.wallet", okxProvider);
    announceProvider(events, "22222222-2222-4222-8222-222222222222", "Rabby Wallet", "io.rabby", rabbyProvider);

    // Wait for passive check to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(controller.getState().status).toBe("CONNECTED");
    expect(controller.getState().selectedProvider?.displayName).toBe("OKX Wallet");
    expect(controller.getState().address).toBe(SIGNER_OKX);
    // Did NOT call eth_requestAccounts (only passive eth_accounts)
    expect(okxProvider.request).toHaveBeenCalledWith({ method: "eth_accounts" });
  });

  it("C. Switching: explicit switch from OKX to Rabby updates session and preference", async () => {
    const events = new EventTarget();
    const okxProvider = new MockProvider();
    okxProvider.accounts = [SIGNER_OKX];
    const rabbyProvider = new MockProvider();
    rabbyProvider.accounts = [SIGNER_RABBY];

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();

    announceProvider(events, "11111111-1111-4111-8111-111111111111", "OKX Wallet", "com.okex.wallet", okxProvider);
    announceProvider(events, "22222222-2222-4222-8222-222222222222", "Rabby Wallet", "io.rabby", rabbyProvider);

    await controller.connect("com.okex.wallet");
    expect(controller.getState().selectedProvider?.displayName).toBe("OKX Wallet");
    expect(mockStorage[PREFERRED_WALLET_STORAGE_KEY]).toBe("com.okex.wallet");

    // Explicit switch to Rabby
    await controller.connect("io.rabby");
    expect(controller.getState().selectedProvider?.displayName).toBe("Rabby Wallet");
    expect(controller.getState().address).toBe(SIGNER_RABBY);
    expect(mockStorage[PREFERRED_WALLET_STORAGE_KEY]).toBe("io.rabby");
  });

  it("D. Accounts: accountsChanged updates address, or disconnects when empty", async () => {
    const events = new EventTarget();
    const okxProvider = new MockProvider();
    okxProvider.accounts = [SIGNER_OKX];

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();

    announceProvider(events, "11111111-1111-4111-8111-111111111111", "OKX Wallet", "com.okex.wallet", okxProvider);
    await controller.connect("com.okex.wallet");
    expect(controller.getState().address).toBe(SIGNER_OKX);

    // Account changed in wallet
    const NEW_SIGNER = "0x2222222222222222222222222222222222222222";
    okxProvider.accounts = [NEW_SIGNER];
    okxProvider.emit("accountsChanged");

    await new Promise((r) => setTimeout(r, 10));
    expect(controller.getState().address).toBe(NEW_SIGNER);

    // Wallet locks / disconnects (empty accounts)
    okxProvider.accounts = [];
    okxProvider.emit("accountsChanged");

    await new Promise((r) => setTimeout(r, 10));
    expect(controller.getState().status).toBe("DISCONNECTED");
  });

  it("E. Network: wrong chain detected and switched on explicit user gesture", async () => {
    const events = new EventTarget();
    const okxProvider = new MockProvider();
    okxProvider.accounts = [SIGNER_OKX];
    okxProvider.chain = "0x1"; // Ethereum Mainnet

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();

    announceProvider(events, "11111111-1111-4111-8111-111111111111", "OKX Wallet", "com.okex.wallet", okxProvider);
    await controller.connect("com.okex.wallet");

    expect(controller.getState().chainId).toBe("0x1");
    expect(controller.getState().isSepolia).toBe(false);

    // Explicit switch to Sepolia
    await controller.switchChain();
    expect(okxProvider.chain).toBe(SEPOLIA_HEX);
    expect(controller.getState().chainId).toBe(SEPOLIA_HEX);
    expect(controller.getState().isSepolia).toBe(true);
  });

  it("F. Disconnect: clears session and removes storage preference", async () => {
    const events = new EventTarget();
    const okxProvider = new MockProvider();
    okxProvider.accounts = [SIGNER_OKX];

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();

    announceProvider(events, "11111111-1111-4111-8111-111111111111", "OKX Wallet", "com.okex.wallet", okxProvider);
    await controller.connect("com.okex.wallet");
    expect(controller.getState().status).toBe("CONNECTED");
    expect(mockStorage[PREFERRED_WALLET_STORAGE_KEY]).toBe("com.okex.wallet");

    // Disconnect
    controller.disconnect();
    expect(controller.getState().status).toBe("DISCONNECTED");
    expect(controller.getState().selectedProvider).toBeNull();
    expect(controller.getState().address).toBeNull();
    expect(mockStorage[PREFERRED_WALLET_STORAGE_KEY]).toBeUndefined();
  });

  it("G. Execution Card: shows readiness state for disconnected or mismatched account", async () => {
    // 1. Disconnected: shows "Wallet: Not connected" and "Connect wallet" button
    const disconnectedHtml = renderToStaticMarkup(
      createElement(WalletExecutionSection, {
        run: executionRunFixture(),
        onRefresh: async () => undefined,
      }),
    );
    expect(disconnectedHtml).toContain("Wallet:</strong> Not connected");
    expect(disconnectedHtml).toContain("Connect wallet");
    expect(disconnectedHtml).not.toContain("Confirm in wallet");

    // 2. Connected with mismatched account: shows readiness warning
    const events = new EventTarget();
    const rabbyProvider = new MockProvider();
    rabbyProvider.accounts = [SIGNER_RABBY];

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();
    announceProvider(events, "22222222-2222-4222-8222-222222222222", "Rabby Wallet", "io.rabby", rabbyProvider);
    await controller.connect("io.rabby");

    const mismatchedHtml = renderToStaticMarkup(
      createElement(
        GlobalWalletProvider,
        { controller },
        createElement(WalletExecutionSection, {
          run: executionRunFixture(),
          onRefresh: async () => undefined,
        }),
      ),
    );

    expect(mismatchedHtml).toContain("Wallet account doesn&#x27;t match this mandate");
    expect(mismatchedHtml).toContain(SIGNER_OKX);
    expect(mismatchedHtml).toContain(SIGNER_RABBY);
    expect(mismatchedHtml).toContain("Switch account / wallet");
  });

  it("H. Execution Card: shows two-stage action when wallet matches approved signer", async () => {
    const events = new EventTarget();
    const okxProvider = new MockProvider();
    okxProvider.accounts = [SIGNER_OKX];

    const controller = new GlobalWalletSessionController({ events, storage });
    controller.start();
    announceProvider(events, "11111111-1111-4111-8111-111111111111", "OKX Wallet", "com.okex.wallet", okxProvider);
    await controller.connect("com.okex.wallet");

    // Stage 1 (NOT_STARTED): Execute mandate
    const stage1Html = renderToStaticMarkup(
      createElement(
        GlobalWalletProvider,
        { controller },
        createElement(WalletExecutionSection, {
          run: executionRunFixture(),
          onRefresh: async () => undefined,
        }),
      ),
    );
    expect(stage1Html).toContain("OKX Wallet · 0x727e…f3b8");
    expect(stage1Html).toContain("Execute mandate");

    // Stage 2 (PREPARED): Confirm in wallet
    const preparedRun = executionRunFixture({
      status: "AWAITING_WALLET",
      operations: [
        { id: "op-1", kind: "TOKENIZE", stage: "PREPARED", preparedTxId: "tx-1", blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "op-2", kind: "WHITELIST", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
        { id: "op-3", kind: "MINT", stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null, brickkenStatus: null, timeout: false },
      ],
    });

    const stage2Html = renderToStaticMarkup(
      createElement(
        GlobalWalletProvider,
        { controller },
        createElement(WalletExecutionSection, {
          run: preparedRun,
          onRefresh: async () => undefined,
        }),
      ),
    );
    expect(stage2Html).toContain("OKX Wallet · 0x727e…f3b8");
    expect(stage2Html).toContain("Confirm in wallet");
    expect(stage2Html).toContain("Transaction prepared and verified");
  });
});
