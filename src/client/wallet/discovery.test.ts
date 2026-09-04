import { describe, expect, it, vi } from "vitest";
import { InjectedWalletDiscovery } from "./discovery";

class FakeProvider {
  readonly request = vi.fn(async () => []);
  readonly on = vi.fn();
  readonly removeListener = vi.fn();
}

function announce(events: EventTarget, uuid: string, provider: FakeProvider, name = "Test Wallet") {
  events.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: {
        info: {
          uuid,
          name,
          icon: "data:image/png;base64,AA==",
          rdns: "com.example.wallet",
        },
        provider,
      },
    }),
  );
}

describe("EIP-6963 discovery", () => {
  it("performs no provider request during discovery and requires explicit selection", () => {
    const events = new EventTarget();
    const provider = new FakeProvider();
    const discovery = new InjectedWalletDiscovery({ events });
    discovery.start();
    expect(discovery.list()).toEqual([]);
    announce(events, "11111111-1111-4111-8111-111111111111", provider);
    expect(provider.request).not.toHaveBeenCalled();
    const [wallet] = discovery.list();
    expect(wallet).toMatchObject({
      source: "EIP6963",
      metadataTrusted: false,
      status: "AVAILABLE",
      capability: "STRUCTURALLY_ELIGIBLE",
    });
    expect(discovery.selectFromUserAction(wallet!.selectionId).selectionId).toBe(wallet!.selectionId);
  });

  it("deduplicates repeats, accepts late announcements, and quarantines collisions", () => {
    const events = new EventTarget();
    const first = new FakeProvider();
    const second = new FakeProvider();
    const discovery = new InjectedWalletDiscovery({ events });
    const notified = vi.fn();
    discovery.subscribe(notified);
    discovery.start();
    const uuid = "11111111-1111-4111-8111-111111111111";
    announce(events, uuid, first);
    announce(events, uuid, first);
    expect(discovery.list()).toHaveLength(1);
    announce(events, "22222222-2222-4222-8222-222222222222", second, "Late Wallet");
    expect(discovery.list()).toHaveLength(2);
    announce(events, uuid, second);
    expect(discovery.list().map((wallet) => wallet.status)).toEqual(["COLLISION", "COLLISION"]);
    expect(notified).toHaveBeenCalledTimes(3);
  });

  it("supports duplicate start and dispose cycles without duplicate listeners", () => {
    const events = new EventTarget();
    const provider = new FakeProvider();
    const discovery = new InjectedWalletDiscovery({ events });
    const notified = vi.fn();
    discovery.subscribe(notified);
    discovery.start();
    discovery.start();
    announce(events, "11111111-1111-4111-8111-111111111111", provider);
    expect(notified).toHaveBeenCalledOnce();
    discovery.dispose();
    discovery.dispose();
    announce(events, "22222222-2222-4222-8222-222222222222", new FakeProvider());
    expect(discovery.list()).toHaveLength(1);
    discovery.start();
    discovery.start();
    announce(events, "33333333-3333-4333-8333-333333333333", new FakeProvider());
    expect(discovery.list()).toHaveLength(2);
  });

  it("refuses an accessor-backed provider request without invoking it", () => {
    const events = new EventTarget();
    const discovery = new InjectedWalletDiscovery({ events });
    let reads = 0;
    const provider = {};
    Object.defineProperty(provider, "request", {
      get: () => {
        reads += 1;
        return vi.fn();
      },
    });
    discovery.start();
    events.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: {
        info: {
          uuid: "11111111-1111-4111-8111-111111111111",
          name: "Accessor Wallet",
          icon: "data:image/png;base64,AA==",
          rdns: "com.example.wallet",
        },
        provider,
      },
    }));
    expect(reads).toBe(0);
    expect(discovery.list()).toEqual([]);
  });

  it("does not execute accessor-backed metadata", () => {
    const events = new EventTarget();
    const discovery = new InjectedWalletDiscovery({ events });
    let reads = 0;
    discovery.start();
    const info = {};
    Object.defineProperty(info, "uuid", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "11111111-1111-4111-8111-111111111111";
      },
    });
    events.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: { info, provider: new FakeProvider() },
      }),
    );
    expect(reads).toBe(0);
    expect(discovery.list()).toEqual([]);
  });

  it("uses the legacy provider only after explicit fallback selection", () => {
    const provider = new FakeProvider();
    const readLegacyProvider = vi.fn(() => provider);
    const discovery = new InjectedWalletDiscovery({
      events: new EventTarget(),
      readLegacyProvider,
    });
    discovery.start();
    expect(readLegacyProvider).not.toHaveBeenCalled();
    const selected = discovery.selectLegacyProviderFromUserAction();
    expect(selected.source).toBe("LEGACY");
    expect(readLegacyProvider).toHaveBeenCalledOnce();
    expect(provider.request).not.toHaveBeenCalled();
  });
});
