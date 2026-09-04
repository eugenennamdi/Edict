import { describe, expect, it, vi } from "vitest";
import { SelectedWalletSession } from "./session";
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
});
