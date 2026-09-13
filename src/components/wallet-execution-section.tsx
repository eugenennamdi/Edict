"use client";

import { useEffect, useRef, useState } from "react";
import { createWalletExecutionHttpGateway } from "@/client/run-api/wallet-execution-gateway";
import { InjectedWalletDiscovery } from "@/client/wallet/discovery";
import { WalletBoundaryError } from "@/client/wallet/errors";
import type { SelectedWalletSession } from "@/client/wallet/session";
import { executeSendAuthorizedEnvelopeFromUserAction } from "@/client/wallet/v4-execution";
import type { PublicRunProjection } from "@/shared/run";
import type { DiscoveredWallet } from "@/shared/wallet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, WalletCards } from "lucide-react";
import {
  classifyWalletExecutionFailure,
  initialWalletExecutionUiModel,
  reduceWalletExecutionUi,
  type WalletExecutionUiModel,
  type WalletExecutionViewState,
} from "./wallet-execution-ui-state";

function label(state: WalletExecutionViewState): string {
  const labels: Record<WalletExecutionViewState, string> = {
    WALLET_REQUIRED: "Wallet required",
    PROVIDER_SELECTION: "Select a wallet provider",
    ACCOUNT_ACCESS_REQUIRED: "Grant account access",
    WRONG_CHAIN: "Switch to Ethereum Sepolia",
    REQUIRED_SIGNER_UNAVAILABLE: "Required signer unavailable",
    READY: "Ready for wallet prompt",
    AUTHORIZATION_UNAVAILABLE: "Execution authorization unavailable",
    DURABLE_REFRESH_REQUIRED: "Durable refresh required",
    PROMPT_IN_PROGRESS: "Wallet prompt in progress",
    HASH_RECORDED: "Transaction hash recorded",
    BROADCAST_UNCERTAIN: "Broadcast outcome uncertain",
    RECONCILIATION_REQUIRED: "Reconciliation required",
  };
  return labels[state];
}

export function WalletExecutionSection({
  run,
  onRefresh,
}: {
  readonly run: PublicRunProjection;
  readonly onRefresh: () => Promise<void>;
}) {
  const prepared = run.approved && run.status === "AWAITING_WALLET" && run.operations[0].stage === "PREPARED";
  const needsPromotion = prepared && run.schemaVersion !== "4.0";
  const canCheckReadiness = prepared && run.schemaVersion === "4.0";
  const hasTrackableHash = run.schemaVersion === "4.0" &&
    run.operations[0].blockchainTxHash !== null && run.phase === "TOKENIZATION" &&
    run.terminalOutcome === null;
  const durableReconciliation = run.status === "RECONCILIATION_REQUIRED";
  const canTrack = hasTrackableHash && !durableReconciliation;
  const visible = prepared || hasTrackableHash;
  const [providers, setProviders] = useState<readonly DiscoveredWallet[]>([]);
  const [model, setModel] = useState<WalletExecutionUiModel>(initialWalletExecutionUiModel);
  const [serverReadyRevision, setServerReadyRevision] = useState<number | null>(null);
  const [activationAction, setActivationAction] = useState<"promote" | "readiness" | "track" | null>(null);
  const [activationError, setActivationError] = useState<Readonly<{
    revision: number;
    message: string;
  }> | null>(null);
  const state = model.state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = useRef<SelectedWalletSession | null>(null);
  const discovery = useRef<InjectedWalletDiscovery | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!canCheckReadiness || serverReadyRevision !== run.revision) return;
    const value = new InjectedWalletDiscovery({
      events: window,
    });
    discovery.current = value;
    const update = () => {
      const list = value.list();
      setProviders(list);
      if (!session.current) setModel((current) => reduceWalletExecutionUi(current, {
        type: "LOCAL_STATE",
        state: list.length > 0 ? "PROVIDER_SELECTION" : "WALLET_REQUIRED",
      }));
    };
    const unsubscribe = value.subscribe(update);
    value.start();
    update();
    return () => {
      unsubscribe();
      session.current?.dispose();
      session.current = null;
      value.dispose();
      discovery.current = null;
    };
  }, [canCheckReadiness, serverReadyRevision, run.id, run.revision]);

  if (!visible) return null;

  async function mutateActivation(action: "promote" | "readiness" | "track") {
    if (busy.current || activationAction !== null) return;
    busy.current = true;
    setActivationAction(action);
    setActivationError(null);
    try {
      const gateway = createWalletExecutionHttpGateway();
      const result = action === "promote"
        ? await gateway.promote(run.id, run.revision)
        : action === "readiness"
          ? await gateway.readiness(run.id, run.revision)
          : await gateway.track(run.id, run.revision);
      if (action === "readiness" && result.schemaVersion === "4.0" &&
        result.operations[0].stage === "PREPARED" && result.revision === run.revision) {
        setServerReadyRevision(run.revision);
      } else {
        await onRefresh();
      }
    } catch {
      setServerReadyRevision(null);
      setActivationError({
        revision: run.revision,
        message: "The server did not confirm this action. Refresh the durable record before trying again.",
      });
    } finally {
      busy.current = false;
      setActivationAction(null);
    }
  }

  async function inspect(selected: SelectedWalletSession) {
    const readiness = await selected.inspect(run.requiredSigner.walletAddress);
    setModel((current) => reduceWalletExecutionUi(current, { type: "LOCAL_STATE", state:
      readiness.state === "READY"
        ? "READY"
        : readiness.state === "UNAUTHORIZED"
          ? "ACCOUNT_ACCESS_REQUIRED"
          : readiness.state === "WRONG_CHAIN"
            ? "WRONG_CHAIN"
            : "REQUIRED_SIGNER_UNAVAILABLE" }));
  }

  async function select(selectionId: string) {
    if (busy.current || model.locked || !discovery.current) return;
    session.current?.dispose();
    const selected = discovery.current.selectFromUserAction(selectionId);
    session.current = selected;
    setSelectedId(selectionId);
    await inspect(selected).catch(() => setModel((current) => reduceWalletExecutionUi(current, {
      type: "LOCAL_STATE",
      state: "WALLET_REQUIRED",
    })));
  }

  async function connect() {
    const selected = session.current;
    if (!selected || busy.current || model.locked) return;
    await selected.requestAccountsFromUserAction(run.requiredSigner.walletAddress)
      .then(() => inspect(selected))
      .catch(() => setModel((current) => reduceWalletExecutionUi(current, { type: "LOCAL_STATE", state: "REQUIRED_SIGNER_UNAVAILABLE" })));
  }

  async function switchNetwork() {
    const selected = session.current;
    if (!selected || busy.current || model.locked) return;
    await selected.switchToSepoliaFromUserAction(run.requiredSigner.walletAddress)
      .then(() => inspect(selected))
      .catch(() => setModel((current) => reduceWalletExecutionUi(current, { type: "LOCAL_STATE", state: "WRONG_CHAIN" })));
  }

  async function execute() {
    const selected = session.current;
    if (!selected || busy.current || model.locked || state !== "READY") return;
    busy.current = true;
    setModel((current) => reduceWalletExecutionUi(current, { type: "START" }));
    try {
      await executeSendAuthorizedEnvelopeFromUserAction({
        runId: run.id,
        expectedRevision: run.revision,
        requiredSigner: run.requiredSigner.walletAddress,
        wallet: selected,
        gateway: createWalletExecutionHttpGateway(),
      });
      setModel((current) => reduceWalletExecutionUi(current, { type: "HASH_RECORDED" }));
      await onRefresh();
    } catch (error) {
      const failure = classifyWalletExecutionFailure(
        error instanceof WalletBoundaryError ? error.code : "UNKNOWN",
      );
      setModel((current) => reduceWalletExecutionUi(current, failure.event));
      if (failure.refresh) await onRefresh().catch(() => undefined);
    } finally {
      busy.current = false;
    }
  }

  return (
    <Card className="border-border/80 shadow-xs" aria-busy={state === "PROMPT_IN_PROGRESS"}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <Badge variant="outline">Browser wallet boundary</Badge>
          <Badge variant={state === "HASH_RECORDED" ? "success" : "secondary"}>{label(state)}</Badge>
        </div>
        <CardTitle className="flex items-center gap-2 text-lg"><WalletCards className="h-4 w-4" />Wallet execution</CardTitle>
        <CardDescription>
          The server owns transaction authority. This browser can consume only one exact, server-issued request.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {needsPromotion && (
          <Button size="sm" disabled={activationAction !== null} onClick={() => void mutateActivation("promote")}>
            {activationAction === "promote" ? "Promoting durable run…" : "Promote prepared run to V4"}
          </Button>
        )}
        {canCheckReadiness && serverReadyRevision !== run.revision && (
          <Button size="sm" disabled={activationAction !== null} onClick={() => void mutateActivation("readiness")}>
            {activationAction === "readiness" ? "Checking server readiness…" : "Check server readiness"}
          </Button>
        )}
        {canTrack && (
          <Button size="sm" disabled={activationAction !== null} onClick={() => void mutateActivation("track")}>
            {activationAction === "track" ? "Tracking once…" : "Track transaction status"}
          </Button>
        )}
        {durableReconciliation && (
          <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0" />The durable run requires reconciliation. Edict will not authorize, resend, or replace this transaction.
          </div>
        )}
        {activationError?.revision === run.revision && (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
            {activationError.message}
          </div>
        )}
        {providers.length > 0 && selectedId === null && (
          <div className="space-y-2">
            {providers.map((provider) => (
              <Button
                key={provider.selectionId}
                type="button"
                variant="outline"
                size="sm"
                disabled={provider.status !== "AVAILABLE"}
                onClick={() => void select(provider.selectionId)}
              >
                Select {provider.displayName}
              </Button>
            ))}
          </div>
        )}
        {selectedId && <p className="text-xs text-muted-foreground">Explicit provider selected: {selectedId}</p>}
        {state === "ACCOUNT_ACCESS_REQUIRED" && <Button size="sm" onClick={() => void connect()}>Grant account access</Button>}
        {state === "WRONG_CHAIN" && <Button size="sm" onClick={() => void switchNetwork()}>Switch to Ethereum Sepolia</Button>}
        {state === "READY" && (
          <Button size="sm" onClick={() => void execute()}>
            Request server authorization and open wallet
          </Button>
        )}
        {state === "AUTHORIZATION_UNAVAILABLE" && (
          <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
            Production execution remains deny-all. No wallet transaction request was made.
          </div>
        )}
        {state === "DURABLE_REFRESH_REQUIRED" && (
          <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
            Authorization outcome or durable revision changed. Edict refreshed the run and will not retry authorization automatically.
          </div>
        )}
        {["BROADCAST_UNCERTAIN", "RECONCILIATION_REQUIRED"].includes(state) && (
          <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0" />The transaction may have been broadcast. Edict will not retry it; reconciliation is required.
          </div>
        )}
        {state === "HASH_RECORDED" && (
          <div role="status" className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
            <CheckCircle2 className="h-4 w-4 shrink-0" />The canonical transaction hash is durable.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
