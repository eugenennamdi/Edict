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

type ViewState =
  | "WALLET_REQUIRED"
  | "PROVIDER_SELECTION"
  | "ACCOUNT_ACCESS_REQUIRED"
  | "WRONG_CHAIN"
  | "REQUIRED_SIGNER_UNAVAILABLE"
  | "READY"
  | "AUTHORIZATION_UNAVAILABLE"
  | "PROMPT_IN_PROGRESS"
  | "HASH_RECORDED"
  | "BROADCAST_UNCERTAIN"
  | "RECONCILIATION_REQUIRED";

function label(state: ViewState): string {
  const labels: Record<ViewState, string> = {
    WALLET_REQUIRED: "Wallet required",
    PROVIDER_SELECTION: "Select a wallet provider",
    ACCOUNT_ACCESS_REQUIRED: "Grant account access",
    WRONG_CHAIN: "Switch to Ethereum Sepolia",
    REQUIRED_SIGNER_UNAVAILABLE: "Required signer unavailable",
    READY: "Ready for wallet prompt",
    AUTHORIZATION_UNAVAILABLE: "Execution authorization unavailable",
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
  const eligible = run.approved && run.status === "AWAITING_WALLET" && run.operations[0].stage === "PREPARED";
  const [providers, setProviders] = useState<readonly DiscoveredWallet[]>([]);
  const [state, setState] = useState<ViewState>("WALLET_REQUIRED");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = useRef<SelectedWalletSession | null>(null);
  const discovery = useRef<InjectedWalletDiscovery | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!eligible) return;
    const value = new InjectedWalletDiscovery({
      events: window,
      readLegacyProvider: () => (window as Window & { ethereum?: unknown }).ethereum,
    });
    discovery.current = value;
    const update = () => {
      const list = value.list();
      setProviders(list);
      if (!session.current) setState(list.length > 0 ? "PROVIDER_SELECTION" : "WALLET_REQUIRED");
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
  }, [eligible, run.id, run.revision]);

  if (!eligible) return null;

  async function inspect(selected: SelectedWalletSession) {
    const readiness = await selected.inspect(run.requiredSigner.walletAddress);
    setState(
      readiness.state === "READY"
        ? "READY"
        : readiness.state === "UNAUTHORIZED"
          ? "ACCOUNT_ACCESS_REQUIRED"
          : readiness.state === "WRONG_CHAIN"
            ? "WRONG_CHAIN"
            : "REQUIRED_SIGNER_UNAVAILABLE",
    );
  }

  async function select(selectionId: string) {
    if (busy.current || !discovery.current) return;
    session.current?.dispose();
    const selected = discovery.current.selectFromUserAction(selectionId);
    session.current = selected;
    setSelectedId(selectionId);
    await inspect(selected).catch(() => setState("WALLET_REQUIRED"));
  }

  async function connect() {
    const selected = session.current;
    if (!selected || busy.current) return;
    await selected.requestAccountsFromUserAction(run.requiredSigner.walletAddress)
      .then(() => inspect(selected))
      .catch(() => setState("REQUIRED_SIGNER_UNAVAILABLE"));
  }

  async function switchNetwork() {
    const selected = session.current;
    if (!selected || busy.current) return;
    await selected.switchToSepoliaFromUserAction(run.requiredSigner.walletAddress)
      .then(() => inspect(selected))
      .catch(() => setState("WRONG_CHAIN"));
  }

  async function execute() {
    const selected = session.current;
    if (!selected || busy.current || state !== "READY") return;
    busy.current = true;
    setState("PROMPT_IN_PROGRESS");
    try {
      await executeSendAuthorizedEnvelopeFromUserAction({
        runId: run.id,
        expectedRevision: run.revision,
        requiredSigner: run.requiredSigner.walletAddress,
        wallet: selected,
        gateway: createWalletExecutionHttpGateway(),
      });
      setState("HASH_RECORDED");
      await onRefresh();
    } catch (error) {
      if (error instanceof WalletBoundaryError && error.reconciliationRequired) {
        setState(error.code === "BROADCAST_OUTCOME_UNKNOWN" ? "BROADCAST_UNCERTAIN" : "RECONCILIATION_REQUIRED");
      } else if (error instanceof WalletBoundaryError && error.code === "SEMANTIC_POLICY_REFUSED") {
        setState("AUTHORIZATION_UNAVAILABLE");
      } else {
        setState("REQUIRED_SIGNER_UNAVAILABLE");
      }
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
