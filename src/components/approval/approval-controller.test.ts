import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createApprovalReadinessController, type ApprovalReadinessTarget } from "./approval-controller";

const SIGNER = "0xb91155113039693456491ac398614bc81fef5ea7";
const OTHER = "0x1111111111111111111111111111111111111111";
const UUID = "11111111-1111-4111-8111-111111111111";

const target: ApprovalReadinessTarget = Object.freeze<ApprovalReadinessTarget>({
  id: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  manifestHash: `sha256:${"1".repeat(64)}`,
  planHash: `sha256:${"2".repeat(64)}`,
  environment: "sandbox",
  chainId: "11155111",
  requiredSigner: { role: "tokenizer", walletAddress: SIGNER },
  phase: "PLAN",
  status: "AWAITING_APPROVAL",
  approved: false,
  terminalOutcome: null,
});

class Provider {
  accounts: string[] = [OTHER, SIGNER];
  chain = "0xaa36a7";
  switchFailure: number | null = null;
  readonly handlers = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return this.accounts;
    if (method === "eth_chainId") return this.chain;
    if (method === "wallet_switchEthereumChain") {
      if (this.switchFailure !== null) {
        throw Object.assign(new Error("private provider detail"), { code: this.switchFailure });
      }
      this.chain = "0xaa36a7";
      return null;
    }
    throw new Error("Unexpected method");
  });
  on = (event: string, listener: (...args: readonly unknown[]) => void) => {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(listener);
    this.handlers.set(event, listeners);
  };
  removeListener = (event: string, listener: (...args: readonly unknown[]) => void) => {
    this.handlers.get(event)?.delete(listener);
  };
  emit(event: string) {
    for (const listener of this.handlers.get(event) ?? []) listener();
  }
  listenerCount() {
    return [...this.handlers.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

function announce(events: EventTarget, provider: Provider, uuid = UUID, name = "Test Wallet") {
  events.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: {
      info: {
        uuid,
        name,
        icon: "data:image/png;base64,AA==",
        rdns: "com.example.wallet",
      },
      provider,
    },
  }));
}

function harness(input: {
  readonly initialTarget?: ApprovalReadinessTarget;
  readonly legacy?: () => unknown;
} = {}) {
  const events = new EventTarget();
  const states: ReturnType<ReturnType<typeof createApprovalReadinessController>["getState"]>[] = [];
  let settleDiscovery: (() => void) | null = null;
  const controller = createApprovalReadinessController({
    target: input.initialTarget ?? target,
    publish: (state) => states.push(state),
    events,
    readLegacyProvider: input.legacy,
    timers: {
      setTimeout(callback) {
        settleDiscovery = callback;
        return 1;
      },
      clearTimeout: vi.fn(),
    },
  });
  return {
    controller,
    events,
    states,
    state: () => controller.getState(),
    settle: () => settleDiscovery?.(),
  };
}

async function selectAnnounced(h: ReturnType<typeof harness>, provider: Provider) {
  announce(h.events, provider);
  const selectionId = h.state().providers[0]!.selectionId;
  h.controller.chooseProvider(selectionId);
  await h.controller.selectWallet();
  return selectionId;
}

describe("approval readiness controller", () => {
  it("starts passive EIP-6963 discovery without selecting or invoking any provider", () => {
    const h = harness();
    const provider = new Provider();
    const requested = vi.fn();
    h.events.addEventListener("eip6963:requestProvider", requested);
    h.controller.start();
    expect(requested).toHaveBeenCalledOnce();
    expect(h.state().status).toBe("SEARCHING");
    expect(h.state().selectedProviderId).toBeNull();
    expect(provider.request).not.toHaveBeenCalled();
    h.settle();
    expect(h.state().status).toBe("NO_PROVIDER_DISCOVERED");
  });

  it("deduplicates announcements, ignores malformed metadata, and preserves selection on late arrivals", async () => {
    const h = harness();
    const first = new Provider();
    const late = new Provider();
    h.controller.start();
    announce(h.events, first);
    announce(h.events, first);
    expect(h.state().providers).toHaveLength(1);
    const selectionId = await selectAnnounced(h, first);
    expect(h.state()).toMatchObject({ selectedProviderId: selectionId, status: "READY" });

    h.events.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: {}, provider: late } }));
    announce(h.events, late, "22222222-2222-4222-8222-222222222222", "Late Wallet");
    expect(h.state().providers).toHaveLength(2);
    expect(h.state()).toMatchObject({ selectedProviderId: selectionId, candidateSelectionId: selectionId, status: "READY" });
  });

  it("quarantines a collision of the selected provider and disposes its readiness session", async () => {
    const h = harness();
    const first = new Provider();
    const second = new Provider();
    h.controller.start();
    announce(h.events, first, UUID, "First Wallet");
    announce(h.events, second, "22222222-2222-4222-8222-222222222222", "Second Wallet");
    const selectionId = h.state().providers[0]!.selectionId;
    h.controller.chooseProvider(selectionId);
    await h.controller.selectWallet();
    expect(h.state().status).toBe("READY");
    expect(first.listenerCount()).toBe(4);

    announce(h.events, second, UUID, "Colliding Wallet");
    expect(h.state()).toMatchObject({
      selectedProviderId: null,
      candidateSelectionId: null,
      status: "PROVIDER_COLLISION",
    });
    expect(h.state().providers.every((provider) => provider.status === "COLLISION")).toBe(true);
    expect(first.listenerCount()).toBe(0);
    h.controller.chooseProvider(selectionId);
    expect(h.state().candidateSelectionId).toBeNull();
  });

  it("creates one session only after explicit selection and passively reads only accounts and chain", async () => {
    const h = harness();
    const provider = new Provider();
    h.controller.start();
    announce(h.events, provider);
    expect(provider.request).not.toHaveBeenCalled();
    h.controller.chooseProvider(h.state().providers[0]!.selectionId);
    await Promise.all([h.controller.selectWallet(), h.controller.selectWallet()]);
    expect(provider.listenerCount()).toBe(4);
    expect(provider.request.mock.calls.map(([request]) => request.method)).toEqual([
      "eth_accounts",
      "eth_chainId",
    ]);
    expect(h.state().status).toBe("READY");
  });

  it("keeps the legacy provider reader dormant until its explicit action", async () => {
    const provider = new Provider();
    const legacy = vi.fn(() => provider);
    const h = harness({ legacy });
    h.controller.start();
    expect(legacy).not.toHaveBeenCalled();
    expect(provider.request).not.toHaveBeenCalled();
    await h.controller.selectLegacyProvider();
    expect(legacy).toHaveBeenCalledOnce();
    expect(h.state()).toMatchObject({ selectedSource: "LEGACY", status: "READY" });
  });

  it("requests account access exactly once and accepts the required signer at a later index", async () => {
    const h = harness();
    const provider = new Provider();
    provider.accounts = [];
    h.controller.start();
    await selectAnnounced(h, provider);
    expect(h.state().status).toBe("ACCOUNT_ACCESS_REQUIRED");
    provider.accounts = [OTHER, SIGNER];
    await Promise.all([h.controller.allowAccountAccess(), h.controller.allowAccountAccess()]);
    expect(provider.request.mock.calls.filter(([request]) => request.method === "eth_requestAccounts")).toHaveLength(1);
    expect(h.state().status).toBe("READY");
  });

  it("never substitutes the first account and keeps a missing signer not ready", async () => {
    const h = harness();
    const provider = new Provider();
    provider.accounts = [OTHER];
    h.controller.start();
    await selectAnnounced(h, provider);
    expect(h.state().status).toBe("REQUIRED_SIGNER_MISSING");
    expect(h.state().status).not.toBe("READY");
  });

  it("requires an explicit Sepolia switch and maps rejection and unsupported outcomes safely", async () => {
    for (const failure of [4001, 4200] as const) {
      const h = harness();
      const provider = new Provider();
      provider.chain = "0x1";
      provider.switchFailure = failure;
      h.controller.start();
      await selectAnnounced(h, provider);
      expect(h.state().status).toBe("WRONG_NETWORK");
      expect(provider.request.mock.calls.some(([request]) => request.method === "wallet_switchEthereumChain")).toBe(false);
      await h.controller.switchToSepolia();
      expect(provider.request.mock.calls.filter(([request]) => request.method === "wallet_switchEthereumChain")).toHaveLength(1);
      expect(h.state().status).toBe(failure === 4001 ? "SWITCH_REJECTED" : "SWITCH_UNSUPPORTED");
    }
  });

  it("switches once from an explicit action and reaches ready only after Sepolia reinspection", async () => {
    const h = harness();
    const provider = new Provider();
    provider.chain = "0x1";
    h.controller.start();
    await selectAnnounced(h, provider);
    await h.controller.switchToSepolia();
    expect(provider.request.mock.calls.filter(([request]) => request.method === "wallet_switchEthereumChain")).toHaveLength(1);
    expect(h.state().status).toBe("READY");
  });

  it.each(["accountsChanged", "chainChanged", "connect", "disconnect"])(
    "%s invalidates readiness without automatic wallet action and explicit recheck restores it",
    async (event) => {
      const h = harness();
      const provider = new Provider();
      h.controller.start();
      await selectAnnounced(h, provider);
      const calls = provider.request.mock.calls.length;
      provider.emit(event);
      expect(h.state().status).toBe("READINESS_INVALIDATED");
      expect(provider.request).toHaveBeenCalledTimes(calls);
      await h.controller.checkWallet();
      expect(h.state().status).toBe("READY");
      expect(provider.request).toHaveBeenCalledTimes(calls + 2);
    },
  );

  it("invalidates a mutated provider and requires explicit reselection", async () => {
    const h = harness();
    const provider = new Provider();
    h.controller.start();
    await selectAnnounced(h, provider);
    provider.request = vi.fn(async () => [SIGNER]);
    await h.controller.checkWallet();
    expect(h.state()).toMatchObject({
      status: "READINESS_INVALIDATED",
      selectedProviderId: null,
      candidateSelectionId: h.state().providers[0]!.selectionId,
    });
    expect(provider.listenerCount()).toBe(0);
    expect(h.state().status).not.toBe("READY");
  });

  it("clears readiness and listeners when the run or revision changes", async () => {
    const h = harness();
    const provider = new Provider();
    h.controller.start();
    await selectAnnounced(h, provider);
    h.controller.updateTarget({ ...target, revision: 2 });
    expect(h.state()).toMatchObject({ selectedProviderId: null, candidateSelectionId: null });
    expect(h.state().status).not.toBe("READY");
    expect(provider.listenerCount()).toBe(0);
    h.controller.updateTarget({ ...target, revision: 3, approved: true, phase: "TOKENIZATION", status: "PREPARING" });
    expect(h.state().status).toBe("APPROVAL_RECORDED");
    announce(h.events, new Provider(), "33333333-3333-4333-8333-333333333333");
    h.settle();
    expect(h.state().status).toBe("APPROVAL_RECORDED");
  });

  it("does not start discovery for an already-approved target", () => {
    const approved: ApprovalReadinessTarget = {
      ...target,
      revision: 2,
      approved: true,
      phase: "TOKENIZATION",
      status: "PREPARING",
    };
    const h = harness({ initialTarget: approved });
    const requested = vi.fn();
    h.events.addEventListener("eip6963:requestProvider", requested);
    h.controller.start();
    expect(requested).not.toHaveBeenCalled();
    expect(h.state().status).toBe("APPROVAL_RECORDED");
  });

  it("disposes discovery and session listeners and ignores stale asynchronous settlement", async () => {
    const h = harness();
    const provider = new Provider();
    let resolveAccounts!: (accounts: string[]) => void;
    provider.request.mockImplementationOnce(() => new Promise((resolve) => { resolveAccounts = resolve; }));
    h.controller.start();
    announce(h.events, provider);
    h.controller.chooseProvider(h.state().providers[0]!.selectionId);
    const pending = h.controller.selectWallet();
    await Promise.resolve();
    h.controller.dispose();
    resolveAccounts([SIGNER]);
    await pending;
    expect(provider.listenerCount()).toBe(0);
    expect(h.state().status).not.toBe("READY");
    announce(h.events, new Provider(), "33333333-3333-4333-8333-333333333333");
    expect(h.state().providers).toHaveLength(1);
  });

  it("contains no direct signing method, execution, storage, secret, logging, or automatic focus capability", () => {
    const source = ["approval-controller.ts", "approval-section.tsx"]
      .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
      .join("\n");
    expect(readFileSync(new URL("approval-section.tsx", import.meta.url), "utf8")).not.toMatch(/eth_sign|requestExplicit|submitApproval|approval-challenges/u);
    expect(source).not.toMatch(/eth_sendTransaction|personal_sign|client\/wallet\/execution|Brickken|RPC|localStorage|sessionStorage|document\.cookie|console\./u);
  });
});
