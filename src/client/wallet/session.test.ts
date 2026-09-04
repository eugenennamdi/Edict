import { describe, expect, it, vi } from "vitest";
import { isEdictProvider, SelectedWalletSession, type WalletProviderTimers } from "./session";
import { WalletBoundaryError } from "./errors";

const SIGNER = "0xb91155113039693456491ac398614bc81fef5ea7";

class Provider {
  accounts: string[] = ["0x1111111111111111111111111111111111111111", SIGNER];
  chain = "0xaa36a7";
  readonly handlers = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  readonly request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return this.accounts;
    if (method === "eth_chainId") return this.chain;
    if (method === "wallet_switchEthereumChain") {
      this.chain = "0xaa36a7";
      return null;
    }
    return null;
  });
  on = (event: string, listener: (...args: readonly unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(listener);
    this.handlers.set(event, handlers);
  };
  removeListener = (event: string, listener: (...args: readonly unknown[]) => void) => {
    this.handlers.get(event)?.delete(listener);
  };
  emit(event: string) {
    for (const listener of this.handlers.get(event) ?? []) listener();
  }
}

describe("selected wallet account and chain session", () => {
  it("matches the required signer anywhere in the authorized accounts", async () => {
    const provider = new Provider();
    const session = new SelectedWalletSession("wallet-1", "EIP6963", provider);
    await expect(session.inspect(SIGNER)).resolves.toMatchObject({ state: "READY" });
  });

  it("requires explicit authorization and explicit switching, then revalidates", async () => {
    const provider = new Provider();
    provider.accounts = [];
    provider.chain = "0x1";
    const session = new SelectedWalletSession("wallet-1", "EIP6963", provider);
    await expect(session.inspect(SIGNER)).resolves.toMatchObject({ state: "UNAUTHORIZED" });
    provider.accounts = [SIGNER];
    await expect(session.requestAccountsFromUserAction(SIGNER)).resolves.toMatchObject({
      state: "WRONG_CHAIN",
    });
    await expect(session.switchToSepoliaFromUserAction(SIGNER)).resolves.toMatchObject({
      state: "READY",
    });
    expect(provider.request.mock.calls.map(([request]) => request.method)).toContain(
      "wallet_switchEthereumChain",
    );
  });

  it("invalidates an attempt on account, chain, connect or disconnect events", () => {
    const provider = new Provider();
    const session = new SelectedWalletSession("wallet-1", "EIP6963", provider);
    const generation = session.generation;
    provider.emit("accountsChanged");
    expect(() => session.assertGeneration(generation)).toThrowError(WalletBoundaryError);
  });

  it("maps standard authorization rejection without exposing provider details", async () => {
    const provider = new Provider();
    provider.request.mockImplementationOnce(async () => {
      throw Object.assign(new Error("sensitive wallet detail"), { code: 4001 });
    });
    const session = new SelectedWalletSession("wallet-1", "EIP6963", provider);
    await expect(session.requestAccountsFromUserAction(SIGNER)).rejects.toMatchObject({
      code: "ACCOUNT_AUTHORIZATION_REJECTED",
      message: "Wallet account authorization was rejected.",
    });
  });

  it("refuses accessor-backed request methods without invoking them", () => {
    let reads = 0;
    const provider = {};
    Object.defineProperty(provider, "request", {
      get: () => {
        reads += 1;
        return vi.fn();
      },
    });
    expect(isEdictProvider(provider)).toBe(false);
    expect(() => new SelectedWalletSession("wallet-1", "EIP6963", provider as never)).toThrowError(
      WalletBoundaryError,
    );
    expect(reads).toBe(0);
  });

  it("detects mutation of the captured provider request reference", async () => {
    const provider = new Provider();
    const session = new SelectedWalletSession("wallet-1", "EIP6963", provider);
    (provider as { request: Provider["request"] }).request = vi.fn(async () => [SIGNER]);
    await expect(session.inspect(SIGNER)).rejects.toMatchObject({
      code: "SELECTED_PROVIDER_DISAPPEARED",
    });
  });

  it("rolls back listeners when registration fails partway", () => {
    const provider = new Provider();
    const removed: string[] = [];
    let calls = 0;
    provider.on = ((event: string, listener: (...args: readonly unknown[]) => void) => {
      calls += 1;
      if (calls === 3) throw new Error("registration failed");
      const handlers = provider.handlers.get(event) ?? new Set();
      handlers.add(listener);
      provider.handlers.set(event, handlers);
    }) as typeof provider.on;
    provider.removeListener = ((event: string, listener: (...args: readonly unknown[]) => void) => {
      removed.push(event);
      provider.handlers.get(event)?.delete(listener);
    }) as typeof provider.removeListener;
    expect(() => new SelectedWalletSession("wallet-1", "EIP6963", provider)).toThrowError(
      WalletBoundaryError,
    );
    expect(removed).toEqual(["connect", "disconnect"]);
    expect([...provider.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
  });

  it("invalidates a multi-request snapshot when wallet state changes between reads", async () => {
    const provider = new Provider();
    provider.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") {
        provider.emit("accountsChanged");
        return [SIGNER];
      }
      return "0xaa36a7";
    });
    const session = new SelectedWalletSession("wallet-1", "EIP6963", provider);
    await expect(session.inspect(SIGNER)).rejects.toMatchObject({ code: "ATTEMPT_INVALIDATED" });
    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it("bounds accounts and chain quantities", async () => {
    const provider = new Provider();
    const session = new SelectedWalletSession("wallet-1", "EIP6963", provider);
    provider.accounts = Array.from({ length: 65 }, () => SIGNER);
    await expect(session.inspect(SIGNER)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    provider.accounts = [SIGNER];
    provider.chain = `0x1${"0".repeat(64)}`;
    await expect(session.inspect(SIGNER)).resolves.toMatchObject({ state: "WRONG_CHAIN", chainId: null });
  });

  it("uses an injected passive deadline and ignores late settlement", async () => {
    let expire: (() => void) | null = null;
    const timers: WalletProviderTimers = {
      setTimeout(callback) {
        expire = callback;
        return 1;
      },
      clearTimeout: vi.fn(),
    };
    let resolveRead: ((value: unknown) => void) | null = null;
    const request = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveRead = resolve;
    }));
    const session = new SelectedWalletSession("wallet-1", "EIP6963", { request }, {
      timers,
      deadlinesMs: { passiveRead: 1 },
    });
    const pending = session.inspect(SIGNER);
    await Promise.resolve();
    expect(expire).not.toBeNull();
    expire!();
    await expect(pending).rejects.toMatchObject({ code: "ATTEMPT_INVALIDATED" });
    resolveRead!([SIGNER]);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
