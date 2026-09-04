"use client";

import "client-only";

import { WALLET_BOUNDARY_LIMITS, type DiscoveredWallet, type EdictEip1193Provider } from "@/shared/wallet";
import { WalletBoundaryError } from "./errors";
import { isEdictProvider, SelectedWalletSession } from "./session";

interface DiscoveryEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  dispatchEvent(event: Event): boolean;
}

export interface InjectedWalletDiscoveryOptions {
  readonly events: DiscoveryEventTarget;
  readonly readLegacyProvider?: () => unknown;
}

interface Entry {
  view: DiscoveredWallet;
  provider: EdictEip1193Provider;
  uuid: string | null;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RDNS = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;
const ICON = /^data:image\/(?:png|webp|svg\+xml)(?:;[^,]*)?,/i;

function dataProperty(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) throw new WalletBoundaryError("PROVIDER_METADATA_MALFORMED");
  return descriptor.value;
}

function metadata(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WalletBoundaryError("PROVIDER_METADATA_MALFORMED");
  }
  const uuid = dataProperty(raw, "uuid");
  const name = dataProperty(raw, "name");
  const icon = dataProperty(raw, "icon");
  const rdns = dataProperty(raw, "rdns");
  if (
    typeof uuid !== "string" ||
    !UUID_V4.test(uuid) ||
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > WALLET_BOUNDARY_LIMITS.providerNameCodeUnits ||
    typeof rdns !== "string" ||
    rdns.length > WALLET_BOUNDARY_LIMITS.providerRdnsCodeUnits ||
    !RDNS.test(rdns) ||
    typeof icon !== "string" ||
    icon.length > WALLET_BOUNDARY_LIMITS.providerIconCodeUnits ||
    !ICON.test(icon)
  ) {
    throw new WalletBoundaryError("PROVIDER_METADATA_MALFORMED");
  }
  return Object.freeze({ uuid: uuid.toLowerCase(), name: name.trim(), icon, rdns: rdns.toLowerCase() });
}

export class InjectedWalletDiscovery {
  readonly #options: InjectedWalletDiscoveryOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #uuidToId = new Map<string, string>();
  readonly #providerToId = new WeakMap<object, string>();
  readonly #listeners = new Set<() => void>();
  #started = false;
  #nextId = 1;

  constructor(options: InjectedWalletDiscoveryOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#options.events.addEventListener("eip6963:announceProvider", this.#announce);
    this.#options.events.dispatchEvent(new Event("eip6963:requestProvider"));
  }

  list(): readonly DiscoveredWallet[] {
    return Object.freeze([...this.#entries.values()].map((entry) => entry.view));
  }

  selectFromUserAction(selectionId: string): SelectedWalletSession {
    const entry = this.#entries.get(selectionId);
    if (!entry || entry.view.status !== "AVAILABLE") {
      throw new WalletBoundaryError("NO_COMPATIBLE_WALLETS_DISCOVERED");
    }
    return new SelectedWalletSession(entry.view.selectionId, entry.view.source, entry.provider);
  }

  selectLegacyProviderFromUserAction(): SelectedWalletSession {
    const raw = this.#options.readLegacyProvider?.();
    if (!isEdictProvider(raw)) throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
    return new SelectedWalletSession(`legacy-${this.#nextId++}`, "LEGACY", raw);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (!this.#started) return;
    this.#options.events.removeEventListener("eip6963:announceProvider", this.#announce);
    this.#started = false;
    this.#listeners.clear();
  }

  readonly #announce: EventListener = (event) => {
    try {
      if (!(event instanceof CustomEvent)) throw new WalletBoundaryError("PROVIDER_METADATA_MALFORMED");
      const detail = event.detail;
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
        throw new WalletBoundaryError("PROVIDER_METADATA_MALFORMED");
      }
      const info = metadata(dataProperty(detail, "info"));
      const provider = dataProperty(detail, "provider");
      if (!isEdictProvider(provider)) throw new WalletBoundaryError("PROVIDER_METADATA_MALFORMED");
      const providerObject = provider as object;
      const uuidMatch = this.#uuidToId.get(info.uuid);
      const providerMatch = this.#providerToId.get(providerObject);
      if (uuidMatch && providerMatch && uuidMatch === providerMatch) return;
      if (uuidMatch || providerMatch) {
        for (const id of [uuidMatch, providerMatch]) {
          if (!id) continue;
          const existing = this.#entries.get(id);
          if (existing) existing.view = Object.freeze({ ...existing.view, status: "COLLISION" });
        }
        for (const listener of this.#listeners) listener();
        return;
      }
      const selectionId = `eip6963-${this.#nextId++}`;
      const view = Object.freeze({
        selectionId,
        source: "EIP6963" as const,
        displayName: info.name,
        rdns: info.rdns,
        iconDataUri: info.icon,
        metadataTrusted: false as const,
        status: "AVAILABLE" as const,
        capability: "STRUCTURALLY_ELIGIBLE" as const,
      });
      this.#entries.set(selectionId, { view, provider, uuid: info.uuid });
      this.#uuidToId.set(info.uuid, selectionId);
      this.#providerToId.set(providerObject, selectionId);
      for (const listener of this.#listeners) listener();
    } catch {
      // Malformed and hostile announcements are ignored without inspecting values.
    }
  };
}
