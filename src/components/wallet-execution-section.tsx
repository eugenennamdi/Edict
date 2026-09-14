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
  classifyWalletExecutionErrorDetail,
  classifyWalletExecutionFailure,
  initialWalletExecutionUiModel,
  reduceWalletExecutionUi,
  type WalletExecutionErrorDetail,
  type WalletExecutionUiModel,
} from "./wallet-execution-ui-state";

function productStatus(run: PublicRunProjection): string {
  if (run.status === "RECONCILIATION_REQUIRED") return "Needs attention";
  if (run.status === "FAILED" || run.terminalOutcome !== null) return "Failed";
  if (run.operations[0].stage === "READ_BACK_VERIFIED") return "Tokenized asset created";
  if (run.operations[0].blockchainTxHash !== null) return "Verifying";
  return "Ready to execute";
}

export function WalletExecutionSection({ run, onRefresh }: {
  readonly run: PublicRunProjection;
  readonly onRefresh: () => Promise<void>;
}) {
  const operation = run.operations[0];
  const hasHash = operation.blockchainTxHash !== null;
  const needsAttention = run.status === "RECONCILIATION_REQUIRED";
  const canExecute = run.executeEligible ?? (run.executablePlan !== false && run.approved && run.phase === "TOKENIZATION" && run.terminalOutcome === null &&
    run.execution?.reprepareEligible !== false && !hasHash && ["NOT_STARTED", "PREPARED", "PREPARED_STALE"].includes(operation.stage));
  const canTrack = (run.trackingRemaining ?? 30) > 0 && hasHash && run.terminalOutcome === null && !needsAttention && operation.stage !== "READ_BACK_VERIFIED";
  const visible = run.approved && (run.phase === "TOKENIZATION" || !!run.tokenizationResult || operation.stage === "READ_BACK_VERIFIED");
  const [providers, setProviders] = useState<readonly DiscoveredWallet[]>([]);
  const [model, setModel] = useState<WalletExecutionUiModel>(initialWalletExecutionUiModel);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<WalletExecutionErrorDetail | null>(null);
  const [executing, setExecuting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [trackingTick, setTrackingTick] = useState(0);
  const session = useRef<SelectedWalletSession | null>(null);
  const discovery = useRef<InjectedWalletDiscovery | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const busy = useRef(false);
  const trackingPolls = useRef(0);

  useEffect(() => {
    if (!canExecute) return;
    const value = new InjectedWalletDiscovery({ events: window });
    discovery.current = value;
    const update = () => {
      const list = value.list();
      setProviders(list);
      if (!session.current) {
        const candidate = (selectedIdRef.current ? list.find((p) => p.selectionId === selectedIdRef.current) : null) ??
          (list.length === 1 && list[0].status === "AVAILABLE" ? list[0] : null);
        if (candidate && candidate.status === "AVAILABLE") {
          session.current = value.selectFromUserAction(candidate.selectionId);
          setSelectedId(candidate.selectionId);
          setModel((current) => reduceWalletExecutionUi(current, { type: "LOCAL_STATE", state: "READY" }));
        } else {
          setModel((current) => reduceWalletExecutionUi(current, {
            type: "LOCAL_STATE", state: list.length > 0 ? "PROVIDER_SELECTION" : "WALLET_REQUIRED",
          }));
        }
      }
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
  }, [canExecute, run.id]);

  useEffect(() => {
    if (!canTrack || trackingPolls.current >= 30) return;
    let cancelled = false;
    const delay = Math.min(2_000 * (2 ** Math.min(trackingPolls.current, 4)), 30_000);
    const timer = window.setTimeout(() => {
      trackingPolls.current += 1;
      void createWalletExecutionHttpGateway().track(run.id, run.revision)
        .then(() => cancelled ? undefined : onRefresh())
        .catch(async () => {
          if (!cancelled) { await onRefresh().catch(() => undefined); setTrackingTick((current) => current + 1); }
        });
    }, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [canTrack, onRefresh, run.id, run.revision, trackingTick]);

  if (!visible) return null;

  async function select(selectionId: string) {
    if (busy.current || model.locked || !discovery.current) return;
    session.current?.dispose();
    session.current = discovery.current.selectFromUserAction(selectionId);
    setSelectedId(selectionId);
    setErrorDetail(null);
    setModel((current) => reduceWalletExecutionUi(current, { type: "LOCAL_STATE", state: "READY" }));
  }

  async function prepare() {
    if (busy.current || preparing || model.locked || !canExecute) return;
    busy.current = true;
    setPreparing(true);
    setErrorDetail(null);
    try {
      const gateway = createWalletExecutionHttpGateway();
      await gateway.reprepare(run.id, run.revision);
      await onRefresh();
    } catch (error) {
      const code = error instanceof WalletBoundaryError ? error.code : "UNKNOWN";
      setErrorDetail(classifyWalletExecutionErrorDetail(code));
      await onRefresh().catch(() => undefined);
    } finally {
      busy.current = false;
      setPreparing(false);
    }
  }

  async function execute() {
    const selected = session.current;
    if (!selected || busy.current || model.locked || !canExecute) return;
    busy.current = true;
    setExecuting(true);
    setErrorDetail(null);
    setModel((current) => reduceWalletExecutionUi(current, { type: "START" }));
    try {
      await executeSendAuthorizedEnvelopeFromUserAction({
        runId: run.id, expectedRevision: run.revision,
        requiredSigner: run.requiredSigner.walletAddress,
        wallet: selected, gateway: createWalletExecutionHttpGateway(),
      });
      setModel((current) => reduceWalletExecutionUi(current, { type: "HASH_RECORDED" }));
      await onRefresh();
    } catch (error) {
      const code = error instanceof WalletBoundaryError ? error.code : "UNKNOWN";
      const failure = classifyWalletExecutionFailure(code);
      setModel((current) => reduceWalletExecutionUi(current, failure.event));
      setErrorDetail(classifyWalletExecutionErrorDetail(code));
      if (failure.refresh) await onRefresh().catch(() => undefined);
    } finally {
      busy.current = false;
      setExecuting(false);
    }
  }

  return (
    <Card className="border-border/80 shadow-xs" aria-busy={executing || model.state === "PROMPT_IN_PROGRESS"}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <Badge variant="outline">Ethereum Sepolia</Badge>
          <Badge variant={needsAttention ? "destructive" : hasHash ? "success" : "secondary"}>{productStatus(run)}</Badge>
        </div>
        <CardTitle className="flex items-center gap-2 text-lg"><WalletCards className="h-4 w-4" />Execute mandate</CardTitle>
        <CardDescription>Edict prepares, validates, and verifies the tokenization. You only confirm the exact transaction in your wallet.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs space-y-1">
          <p><strong>Purpose:</strong> Create the approved tokenized asset</p>
          <p><strong>Required signer:</strong> <span className="font-mono break-all">{run.requiredSigner.walletAddress}</span></p>
          <p><strong>Network:</strong> Ethereum Sepolia</p>
          <p><strong>Destination:</strong> Reviewed Brickken tokenization contract</p>
          <p><strong>Estimated fee:</strong> Computed from Brickken&apos;s prepared transaction before the wallet opens</p>
          <p><strong>Maximum fee:</strong> Server-capped per preparation, always below the 0.1 ETH policy ceiling</p>
          {selectedId && <p><strong>Wallet:</strong> {providers.find((provider) => provider.selectionId === selectedId)?.displayName ?? "Selected browser wallet"}</p>}
        </div>
        {run.execution?.reprepareEligible === false && <p role="status">The replacement preparation is no longer usable. Create a new mandate to continue.</p>}
        {canExecute && providers.length === 0 && <p className="text-xs text-muted-foreground">Install or enable a browser wallet to execute this mandate.</p>}
        {canExecute && providers.length > 0 && selectedId === null && (
          <div className="space-y-2"><p className="text-xs font-medium">Choose the wallet holding the required signer.</p>
            {providers.map((provider) => <Button key={provider.selectionId} type="button" variant="outline" size="sm"
              disabled={provider.status !== "AVAILABLE"} onClick={() => void select(provider.selectionId)}>Use {provider.displayName}</Button>)}
          </div>
        )}
        {canExecute && selectedId !== null && (
          <div className="space-y-2">
            {operation.stage === "PREPARED" && (
              <p className="text-xs text-muted-foreground">
                Transaction prepared and verified. Click below to open your wallet and confirm the on-chain transaction.
              </p>
            )}
            {operation.stage === "PREPARED_STALE" && (
              <p className="text-xs text-muted-foreground">
                The transaction price report has expired on-chain. Click below to reprepare with Brickken before confirming.
              </p>
            )}
            <Button
              size="sm"
              disabled={model.locked || executing || preparing}
              onClick={() => void (operation.stage === "PREPARED" ? execute() : prepare())}
            >
              {executing || model.state === "PROMPT_IN_PROGRESS"
                ? "Opening wallet…"
                : preparing
                ? "Preparing with Brickken…"
                : operation.stage === "PREPARED"
                ? "Confirm in wallet"
                : operation.stage === "PREPARED_STALE"
                ? "Reprepare tokenization"
                : "Execute mandate"}
            </Button>
          </div>
        )}
        {canTrack && <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
          Transaction submitted. Edict is verifying it automatically; no further submission will occur.
        </div>}
        {operation.stage === "READ_BACK_VERIFIED" && <div role="status" className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
          <CheckCircle2 className="h-4 w-4 shrink-0" />Tokenized asset created and verified.
        </div>}
        {run.tokenizationResult && <dl className="text-xs space-y-2 break-all">
          <div><dt>Token address</dt><dd>{run.tokenizationResult.tokenAddress}</dd></div>
          <div><dt>Escrow</dt><dd>{run.tokenizationResult.escrowAddress ?? "Not recorded in this historical run"}</dd></div>
          <div><dt>Tokenization ID</dt><dd>{run.tokenizationResult.tokenizationId ?? "Not recorded in this historical run"}</dd></div>
          <div><dt>Transaction</dt><dd>{run.tokenizationResult.transactionHash}</dd></div>
          <div><dt>Verification</dt><dd>{run.tokenizationResult.verificationStatus}</dd></div>
        </dl>}
        {run.trackingRemaining === 0 && operation.stage !== "READ_BACK_VERIFIED" && <p role="status">Automatic verification is paused after reaching its tracking limit. This execution needs attention.</p>}
        {needsAttention && <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />{hasHash
            ? "The transaction was submitted, but Edict detected an execution mismatch. Edict will not submit another transaction."
            : "We couldn't confirm the preparation with Brickken. No wallet transaction was requested. This execution needs attention."}
        </div>}
        {errorDetail && (
          <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm font-semibold flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {errorDetail.title}
              </strong>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs hover:bg-amber-500/20"
                onClick={() => setErrorDetail(null)}
              >
                Dismiss
              </Button>
            </div>
            <p className="text-muted-foreground">{errorDetail.description}</p>
            <div className="rounded border border-border/40 bg-background/60 p-2.5 space-y-1">
              <p>
                <span className="font-medium text-foreground">On-chain transaction submitted: </span>
                <span className="font-semibold">
                  {errorDetail.onChainSubmission === "NO"
                    ? "NO (no funds or gas were spent)"
                    : errorDetail.onChainSubmission === "YES"
                    ? "YES"
                    : "UNKNOWN (verification required)"}
                </span>
              </p>
              <p>
                <span className="font-medium text-foreground">Next action: </span>
                <span>{errorDetail.nextStep}</span>
              </p>
            </div>
          </div>
        )}
        <details className="rounded-lg border border-border/60 p-3 text-xs">
          <summary className="cursor-pointer font-medium">Technical details</summary>
          <dl className="mt-3 grid gap-1 text-muted-foreground">
            <div><dt className="inline font-medium">Durable status: </dt><dd className="inline">{run.status}</dd></div>
            <div><dt className="inline font-medium">TOKENIZE stage: </dt><dd className="inline">{operation.stage}</dd></div>
            {operation.blockchainTxHash && <div><dt className="inline font-medium">Transaction: </dt><dd className="inline font-mono break-all">{operation.blockchainTxHash}</dd></div>}
          </dl>
        </details>
      </CardContent>
    </Card>
  );
}
