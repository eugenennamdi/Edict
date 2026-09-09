"use client";

import "client-only";

import type { PublicRunProjection } from "@/shared/run";
import type { DiscoveredWallet, WalletReadiness, WalletSource } from "@/shared/wallet";
import { InjectedWalletDiscovery } from "@/client/wallet/discovery";
import { WalletBoundaryError, type WalletErrorCode } from "@/client/wallet/errors";

export type ApprovalReadinessTarget = Readonly<Pick<
  PublicRunProjection,
  "id" | "revision" | "requiredSigner" | "phase" | "status" | "approved" | "terminalOutcome"
>>;

export type ApprovalReadinessStatus =
  | "SEARCHING"
  | "NO_PROVIDER_DISCOVERED"
  | "PROVIDER_AVAILABLE"
  | "PROVIDER_COLLISION"
  | "PROVIDER_SELECTED_UNCHECKED"
  | "CHECKING"
  | "ACCOUNT_ACCESS_REQUIRED"
  | "ACCOUNT_ACCESS_REJECTED"
  | "REQUIRED_SIGNER_MISSING"
  | "WRONG_NETWORK"
  | "SWITCH_PENDING"
  | "SWITCH_REJECTED"
  | "SWITCH_UNSUPPORTED"
  | "READINESS_INVALIDATED"
  | "WALLET_DISCONNECTED"
  | "READY"
  | "APPROVAL_RECORDED"
  | "APPROVAL_NOT_ELIGIBLE";

export type ApprovalReadinessPending = "SELECT" | "INSPECT" | "ACCOUNT_ACCESS" | "SWITCH" | null;

export interface ApprovalReadinessState {
  readonly target: ApprovalReadinessTarget;
  readonly providers: readonly DiscoveredWallet[];
  readonly candidateSelectionId: string | null;
  readonly selectedProviderId: string | null;
  readonly selectedSource: WalletSource | null;
  readonly status: ApprovalReadinessStatus;
  readonly pending: ApprovalReadinessPending;
  readonly safeErrorCode: WalletErrorCode | null;
}

interface ReadinessSession {
  readonly selectionId: string;
  readonly source: WalletSource;
  readonly generation: number;
  inspect(requiredSigner: string): Promise<WalletReadiness>;
  requestAccountsFromUserAction(requiredSigner: string): Promise<WalletReadiness>;
  switchToSepoliaFromUserAction(requiredSigner: string): Promise<WalletReadiness>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

interface ReadinessDiscovery {
  start(): void;
  list(): readonly DiscoveredWallet[];
  selectFromUserAction(selectionId: string): ReadinessSession;
  selectLegacyProviderFromUserAction(): ReadinessSession;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface ApprovalReadinessTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface ApprovalReadinessControllerOptions {
  readonly target: ApprovalReadinessTarget;
  readonly publish: (state: ApprovalReadinessState) => void;
  readonly discovery?: ReadinessDiscovery;
  readonly events?: Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent">;
  readonly readLegacyProvider?: () => unknown;
  readonly timers?: ApprovalReadinessTimers;
  readonly discoveryWindowMs?: number;
}

const defaultTimers: ApprovalReadinessTimers = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function approvalEligible(target: ApprovalReadinessTarget): boolean {
  return !target.approved &&
    target.terminalOutcome === null &&
    target.phase === "PLAN" &&
    target.status === "AWAITING_APPROVAL";
}

function initialStatus(target: ApprovalReadinessTarget): ApprovalReadinessStatus {
  if (target.approved) return "APPROVAL_RECORDED";
  return approvalEligible(target) ? "SEARCHING" : "APPROVAL_NOT_ELIGIBLE";
}

export function initialApprovalReadinessState(
  target: ApprovalReadinessTarget,
): ApprovalReadinessState {
  return Object.freeze({
    target,
    providers: Object.freeze([]),
    candidateSelectionId: null,
    selectedProviderId: null,
    selectedSource: null,
    status: initialStatus(target),
    pending: null,
    safeErrorCode: null,
  });
}

function targetChanged(current: ApprovalReadinessTarget, next: ApprovalReadinessTarget): boolean {
  return current.id !== next.id ||
    current.revision !== next.revision ||
    current.requiredSigner.walletAddress !== next.requiredSigner.walletAddress ||
    current.phase !== next.phase ||
    current.status !== next.status ||
    current.approved !== next.approved ||
    current.terminalOutcome !== next.terminalOutcome;
}

function providerListStatus(
  providers: readonly DiscoveredWallet[],
  discoverySettled: boolean,
): ApprovalReadinessStatus {
  if (providers.some((provider) => provider.status === "AVAILABLE")) return "PROVIDER_AVAILABLE";
  if (providers.some((provider) => provider.status === "COLLISION")) return "PROVIDER_COLLISION";
  return discoverySettled ? "NO_PROVIDER_DISCOVERED" : "SEARCHING";
}

function readinessStatus(readiness: WalletReadiness): ApprovalReadinessStatus {
  if (readiness.state === "READY") return "READY";
  if (readiness.state === "UNAUTHORIZED") return "ACCOUNT_ACCESS_REQUIRED";
  if (readiness.state === "REQUIRED_ACCOUNT_UNAVAILABLE") return "REQUIRED_SIGNER_MISSING";
  if (readiness.state === "WRONG_CHAIN") return "WRONG_NETWORK";
  if (readiness.state === "DISCONNECTED" || readiness.state === "PROVIDER_UNAVAILABLE") {
    return "WALLET_DISCONNECTED";
  }
  return "READINESS_INVALIDATED";
}

function errorStatus(code: WalletErrorCode): ApprovalReadinessStatus {
  if (code === "ACCOUNT_AUTHORIZATION_REJECTED") return "ACCOUNT_ACCESS_REJECTED";
  if (code === "CHAIN_SWITCH_REJECTED") return "SWITCH_REJECTED";
  if (code === "CHAIN_SWITCH_UNSUPPORTED") return "SWITCH_UNSUPPORTED";
  if (code === "WALLET_DISCONNECTED" || code === "PROVIDER_UNAVAILABLE") return "WALLET_DISCONNECTED";
  if (code === "REQUIRED_ACCOUNT_UNAVAILABLE") return "ACCOUNT_ACCESS_REQUIRED";
  return "READINESS_INVALIDATED";
}

function walletErrorCode(error: unknown): WalletErrorCode {
  return error instanceof WalletBoundaryError ? error.code : "PROVIDER_UNAVAILABLE";
}

export function createApprovalReadinessController(options: ApprovalReadinessControllerOptions) {
  const timers = options.timers ?? defaultTimers;
  const discovery = options.discovery ?? (() => {
    if (!options.events) throw new Error("APPROVAL_READINESS_EVENTS_REQUIRED");
    return new InjectedWalletDiscovery({
      events: options.events,
      readLegacyProvider: options.readLegacyProvider,
    });
  })();
  let state = initialApprovalReadinessState(options.target);
  let target = options.target;
  let session: ReadinessSession | null = null;
  let unsubscribeSession: (() => void) | null = null;
  let unsubscribeDiscovery: (() => void) | null = null;
  let discoveryTimer: unknown;
  let discoverySettled = false;
  let started = false;
  let disposed = false;
  let busy = false;
  let actionSerial = 0;
  let settlementGeneration = 0;

  const publish = (patch: Partial<ApprovalReadinessState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    options.publish(state);
  };

  const clearSession = () => {
    actionSerial += 1;
    settlementGeneration += 1;
    busy = false;
    unsubscribeSession?.();
    unsubscribeSession = null;
    session?.dispose();
    session = null;
  };

  const onSessionInvalidated = () => {
    if (!session || disposed) return;
    settlementGeneration += 1;
    publish({
      status: "READINESS_INVALIDATED",
      safeErrorCode: "ATTEMPT_INVALIDATED",
    });
  };

  const attachSession = (next: ReadinessSession) => {
    session = next;
    unsubscribeSession = next.subscribe(onSessionInvalidated);
    publish({
      selectedProviderId: next.selectionId,
      selectedSource: next.source,
      status: "PROVIDER_SELECTED_UNCHECKED",
      safeErrorCode: null,
    });
  };

  const onDiscovery = () => {
    if (disposed) return;
    const providers = discovery.list();
    if (!approvalEligible(target)) {
      publish({ providers });
      return;
    }
    if (session) {
      const selected = providers.find((provider) => provider.selectionId === session?.selectionId);
      if (session.source === "EIP6963" && (!selected || selected.status !== "AVAILABLE")) {
        clearSession();
        publish({
          providers,
          candidateSelectionId: null,
          selectedProviderId: null,
          selectedSource: null,
          status: "PROVIDER_COLLISION",
          pending: null,
          safeErrorCode: "SELECTED_PROVIDER_DISAPPEARED",
        });
        return;
      }
      publish({ providers });
      return;
    }
    const candidate = state.candidateSelectionId === null
      ? null
      : providers.find((provider) => provider.selectionId === state.candidateSelectionId);
    publish({
      providers,
      candidateSelectionId: candidate?.status === "AVAILABLE" ? candidate.selectionId : null,
      status: candidate?.status === "COLLISION"
        ? "PROVIDER_COLLISION"
        : providerListStatus(providers, discoverySettled),
      safeErrorCode: candidate?.status === "COLLISION" ? "SELECTED_PROVIDER_DISAPPEARED" : null,
    });
  };

  const applyReadiness = (readiness: WalletReadiness) => {
    if (!session || readiness.generation !== session.generation) {
      publish({ status: "READINESS_INVALIDATED", safeErrorCode: "ATTEMPT_INVALIDATED" });
      return;
    }
    publish({ status: readinessStatus(readiness), safeErrorCode: null });
  };

  const perform = async (
    pending: Exclude<ApprovalReadinessPending, null>,
    status: ApprovalReadinessStatus,
    operation: (selected: ReadinessSession) => Promise<WalletReadiness>,
  ): Promise<void> => {
    if (disposed || busy || !session || !approvalEligible(target)) return;
    busy = true;
    const serial = ++actionSerial;
    const generation = settlementGeneration;
    const selected = session;
    publish({ pending, status, safeErrorCode: null });
    try {
      const readiness = await operation(selected);
      if (
        disposed ||
        serial !== actionSerial ||
        generation !== settlementGeneration ||
        selected !== session
      ) return;
      applyReadiness(readiness);
    } catch (error) {
      if (disposed || serial !== actionSerial || selected !== session) return;
      const code = walletErrorCode(error);
      if (code === "SELECTED_PROVIDER_DISAPPEARED") {
        const selectionId = selected.selectionId;
        clearSession();
        const candidate = state.providers.find(
          (provider) => provider.selectionId === selectionId && provider.status === "AVAILABLE",
        );
        publish({
          candidateSelectionId: candidate?.selectionId ?? null,
          selectedProviderId: null,
          selectedSource: null,
          status: "READINESS_INVALIDATED",
          pending: null,
          safeErrorCode: code,
        });
        return;
      }
      publish({ status: errorStatus(code), safeErrorCode: code });
    } finally {
      if (!disposed && serial === actionSerial) {
        busy = false;
        publish({ pending: null });
      }
    }
  };

  const inspect = () => perform(
    "INSPECT",
    "CHECKING",
    (selected) => selected.inspect(target.requiredSigner.walletAddress),
  );

  const select = async (legacy: boolean): Promise<void> => {
    if (disposed || busy || !approvalEligible(target)) return;
    const candidate = state.candidateSelectionId;
    if (!legacy) {
      const available = state.providers.some(
        (provider) => provider.selectionId === candidate && provider.status === "AVAILABLE",
      );
      if (!candidate || !available) return;
    }
    clearSession();
    busy = true;
    const serial = ++actionSerial;
    try {
      const selected = legacy
        ? discovery.selectLegacyProviderFromUserAction()
        : discovery.selectFromUserAction(candidate!);
      if (disposed || serial !== actionSerial) {
        selected.dispose();
        return;
      }
      attachSession(selected);
    } catch (error) {
      if (disposed || serial !== actionSerial) return;
      const code = walletErrorCode(error);
      publish({ status: errorStatus(code), safeErrorCode: code });
      return;
    } finally {
      if (!disposed && serial === actionSerial) busy = false;
    }
    await inspect();
  };

  return Object.freeze({
    getState: () => state,

    start(): void {
      if (disposed || started || !approvalEligible(target)) return;
      started = true;
      unsubscribeDiscovery = discovery.subscribe(onDiscovery);
      discovery.start();
      onDiscovery();
      discoveryTimer = timers.setTimeout(() => {
        if (disposed) return;
        discoverySettled = true;
        onDiscovery();
      }, options.discoveryWindowMs ?? 500);
    },

    chooseProvider(selectionId: string): void {
      if (disposed || busy || !approvalEligible(target)) return;
      const selected = state.providers.find((provider) => provider.selectionId === selectionId);
      if (!selected || selected.status !== "AVAILABLE") return;
      if (session && session.selectionId !== selectionId) clearSession();
      publish({
        candidateSelectionId: selectionId,
        selectedProviderId: session?.selectionId ?? null,
        selectedSource: session?.source ?? null,
        status: session ? state.status : "PROVIDER_AVAILABLE",
        pending: null,
        safeErrorCode: null,
      });
    },

    selectWallet: () => select(false),
    selectLegacyProvider: () => select(true),
    checkWallet: inspect,

    allowAccountAccess: () => {
      if (!["ACCOUNT_ACCESS_REQUIRED", "ACCOUNT_ACCESS_REJECTED"].includes(state.status)) {
        return Promise.resolve();
      }
      return perform(
        "ACCOUNT_ACCESS",
        "CHECKING",
        (selected) => selected.requestAccountsFromUserAction(target.requiredSigner.walletAddress),
      );
    },

    switchToSepolia: () => {
      if (!["WRONG_NETWORK", "SWITCH_REJECTED"].includes(state.status)) return Promise.resolve();
      return perform(
        "SWITCH",
        "SWITCH_PENDING",
        (selected) => selected.switchToSepoliaFromUserAction(target.requiredSigner.walletAddress),
      );
    },

    updateTarget(next: ApprovalReadinessTarget): void {
      if (disposed || !targetChanged(target, next)) return;
      clearSession();
      target = next;
      publish({
        target: next,
        candidateSelectionId: null,
        selectedProviderId: null,
        selectedSource: null,
        status: next.approved
          ? "APPROVAL_RECORDED"
          : approvalEligible(next)
            ? providerListStatus(state.providers, discoverySettled)
            : "APPROVAL_NOT_ELIGIBLE",
        pending: null,
        safeErrorCode: null,
      });
    },

    dispose(): void {
      if (disposed) return;
      if (discoveryTimer !== undefined) timers.clearTimeout(discoveryTimer);
      unsubscribeDiscovery?.();
      unsubscribeDiscovery = null;
      clearSession();
      discovery.dispose();
      disposed = true;
    },
  });
}

export function createBrowserApprovalReadinessController(input: {
  readonly target: ApprovalReadinessTarget;
  readonly publish: (state: ApprovalReadinessState) => void;
}) {
  if (typeof window === "undefined") throw new Error("APPROVAL_READINESS_BROWSER_REQUIRED");
  return createApprovalReadinessController({
    ...input,
    events: window,
    readLegacyProvider: () => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "ethereum");
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    },
  });
}
