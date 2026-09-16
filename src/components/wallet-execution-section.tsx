"use client";

import { useEffect, useRef, useState } from "react";
import {
  createWalletExecutionHttpGateway,
  WalletExecutionGatewayError,
} from "@/client/run-api/wallet-execution-gateway";
import { useGlobalWallet } from "@/client/wallet/global-wallet-context";
import { WalletBoundaryError } from "@/client/wallet/errors";
import { executeSendAuthorizedEnvelopeFromUserAction } from "@/client/wallet/v4-execution";
import type { PublicRunProjection } from "@/shared/run";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, ExternalLink, WalletCards } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  classifyWalletExecutionErrorDetail,
  classifyWalletExecutionFailure,
  initialWalletExecutionUiModel,
  reduceWalletExecutionUi,
  type WalletExecutionErrorDetail,
  type WalletExecutionUiModel,
} from "./wallet-execution-ui-state";
import {
  activeLifecycleOperation,
  brickkenVerificationCopy,
  isIncludedOnChain,
  isLifecycleFinalized,
  pollVerificationOnce,
  shouldPollVerification,
  verificationFailureCopy,
  verificationPollDelayMs,
} from "./wallet-execution-verification";

function shortenAddress(address: string | null): string {
  if (!address) return "";
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function productStatus(run: PublicRunProjection): string {
  const phaseIndex = run.phase === "TOKENIZATION" ? 0 : run.phase === "WHITELIST" ? 1 : run.phase === "MINT" || run.phase === "VERIFICATION" ? 2 : 0;
  const operation = run.operations[phaseIndex] ?? run.operations[0];
  const budgetExhausted = run.execution?.reprepareEligible === false && operation.stage === "PREPARED_STALE";
  if (run.status === "RECONCILIATION_REQUIRED" || budgetExhausted || run.terminalOutcome === "VERIFICATION_FAILED") return "Needs attention";
  if (run.status === "FAILED" || run.terminalOutcome !== null) return "Failed";
  if (run.phase === "VERIFICATION" || (run.phase === "MINT" && run.operations[2]?.stage === "READ_BACK_VERIFIED")) return "Lifecycle complete";
  if (run.phase === "TOKENIZATION" && run.operations[0].stage === "READ_BACK_VERIFIED" && (!run.operations[1] || run.operations[1].stage === "NOT_STARTED")) return "Tokenized asset created";
  if (operation.blockchainTxHash !== null && operation.stage !== "READ_BACK_VERIFIED") return "Verifying";
  if (run.phase === "WHITELIST") return "Authorizing investor";
  if (run.phase === "MINT") return "Minting tokens";
  if (run.operations[0].stage === "READ_BACK_VERIFIED") return "Tokenized asset created";
  return "Ready to execute";
}

export function WalletExecutionSection({ run, onRefresh, onTrackedRun }: {
  readonly run: PublicRunProjection;
  readonly onRefresh: () => Promise<void>;
  readonly onTrackedRun?: (next: PublicRunProjection) => boolean;
}) {
  const wallet = useGlobalWallet();
  const operation = activeLifecycleOperation(run);
  const hasHash = operation.blockchainTxHash !== null;
  const budgetExhausted = run.execution?.reprepareEligible === false && operation.stage === "PREPARED_STALE";
  const verificationFailure = verificationFailureCopy(run);
  const needsAttention = run.status === "RECONCILIATION_REQUIRED" || budgetExhausted || verificationFailure !== null;
  const canExecute = !budgetExhausted && (run.executeEligible ?? false);
  const isFinalized = isLifecycleFinalized(operation.stage);
  const canTrack = shouldPollVerification(run);
  const visible = run.approved && (
    ["TOKENIZATION", "WHITELIST", "MINT", "VERIFICATION"].includes(run.phase) ||
    !!run.tokenizationResult ||
    run.operations.some(op => op.stage === "READ_BACK_VERIFIED")
  );
  const [model, setModel] = useState<WalletExecutionUiModel>(initialWalletExecutionUiModel);
  const [errorDetail, setErrorDetail] = useState<WalletExecutionErrorDetail | null>(null);
  const [executing, setExecuting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [trackingTick, setTrackingTick] = useState(0);
  const [confirmations, setConfirmations] = useState<number | null>(null);
  const busy = useRef(false);
  const trackingPolls = useRef(0);
  const trackedHash = useRef<string | null>(null);

  const isStageIncluded = isIncludedOnChain(operation.stage);
  const isStageFinalized = isLifecycleFinalized(operation.stage);
  const brickkenWait = brickkenVerificationCopy(isStageFinalized, trackingTick);

  const isConnected = wallet.isConnected && wallet.address !== null;
  const isSignerMismatch = isConnected && (wallet.address?.toLowerCase() !== run.requiredSigner.walletAddress.toLowerCase());
  const isNetworkMismatch = isConnected && !wallet.isSepolia;

  const isLocked = operation.blockchainTxHash === null
    ? (model.locked && model.state !== "HASH_RECORDED")
    : model.locked;
  const uiState = !isConnected || isNetworkMismatch || isSignerMismatch
    ? "WALLET_REQUIRED"
    : model.state === "WALLET_REQUIRED" && operation.blockchainTxHash === null
    ? "READY"
    : model.state;

  useEffect(() => {
    if (!hasHash || operation.stage === "READ_BACK_VERIFIED") return;
    let cancelled = false;

    const checkConfirmations = async () => {
      try {
        if (typeof window === "undefined") return;
        const ethereum = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
        if (!ethereum) return;
        const receipt = (await ethereum.request({
          method: "eth_getTransactionReceipt",
          params: [operation.blockchainTxHash],
        })) as { blockNumber?: string } | null;
        if (!receipt?.blockNumber) return;
        const currentBlockHex = (await ethereum.request({
          method: "eth_blockNumber",
        })) as string;
        if (!currentBlockHex) return;
        const diff = Number(BigInt(currentBlockHex) - BigInt(receipt.blockNumber) + 1n);
        if (!cancelled && Number.isFinite(diff) && diff >= 0) {
          setConfirmations(Math.max(1, diff));
        }
      } catch {
        // Quietly ignore RPC lookup errors
      }
    };

    void checkConfirmations();
    return () => {
      cancelled = true;
    };
  }, [hasHash, operation.blockchainTxHash, operation.stage, trackingTick]);

  useEffect(() => {
    if (!canTrack) return;
    if (trackedHash.current !== operation.blockchainTxHash) {
      trackedHash.current = operation.blockchainTxHash;
      trackingPolls.current = 0;
    }
    let cancelled = false;
    const delay = verificationPollDelayMs(trackingPolls.current, isFinalized);
    const timer = window.setTimeout(() => {
      trackingPolls.current += 1;
      void pollVerificationOnce({
        run,
        track: (runId, expectedRevision) => createWalletExecutionHttpGateway().track(runId, expectedRevision),
        applyRun: (next) => onTrackedRun?.(next) ?? false,
        pullLatest: () => onRefresh().catch(() => undefined),
      }).finally(() => {
        if (!cancelled) setTrackingTick((current) => current + 1);
      });
    }, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [canTrack, isFinalized, onRefresh, onTrackedRun, operation.blockchainTxHash, run, trackingTick]);

  if (!visible) return null;

  async function prepare() {
    if (busy.current || preparing || isLocked || !canExecute) return;
    busy.current = true;
    setPreparing(true);
    setErrorDetail(null);
    try {
      const gateway = createWalletExecutionHttpGateway();
      await gateway.reprepare(run.id, run.revision);
      await onRefresh();
    } catch (error) {
      const code = error instanceof WalletBoundaryError
        ? error.code
        : error instanceof WalletExecutionGatewayError
          ? error.code
          : "PREPARATION_FAILED";
      setErrorDetail(classifyWalletExecutionErrorDetail(code, {
        reprepareEligible: run.execution?.reprepareEligible,
      }));
      await onRefresh().catch(() => undefined);
    } finally {
      busy.current = false;
      setPreparing(false);
    }
  }

  async function execute() {
    if (!isConnected || busy.current || isLocked || !canExecute) return;
    busy.current = true;
    setExecuting(true);
    setErrorDetail(null);
    setModel((current) => reduceWalletExecutionUi({ ...current, state: uiState }, { type: "START" }));
    try {
      const selected = await wallet.getWalletSession();
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
      const code = error instanceof WalletBoundaryError
        ? error.code
        : error instanceof WalletExecutionGatewayError
          ? error.code
          : "EXECUTION_FAILED";
      const failure = classifyWalletExecutionFailure(code);
      setModel((current) => reduceWalletExecutionUi(current, failure.event));
      setErrorDetail(classifyWalletExecutionErrorDetail(code, {
        reprepareEligible: run.execution?.reprepareEligible,
      }));
      if (failure.refresh) await onRefresh().catch(() => undefined);
    } finally {
      busy.current = false;
      setExecuting(false);
    }
  }

  const phaseLabel = run.phase === "WHITELIST" ? "whitelist" : run.phase === "MINT" ? "mint" : "tokenization";

  return (
    <Card className="border-border/80 shadow-xs" aria-busy={executing || model.state === "PROMPT_IN_PROGRESS"}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <Badge variant="outline">Ethereum Sepolia</Badge>
          <Badge variant={needsAttention ? "destructive" : hasHash ? "success" : "secondary"}>{productStatus(run)}</Badge>
        </div>
        <CardTitle className="flex items-center gap-2 text-lg"><WalletCards className="h-4 w-4" />Execute mandate</CardTitle>
        <CardDescription>
          {run.phase === "WHITELIST" 
            ? "Edict whitelists the investor address on the token contract. Confirm in your wallet."
            : run.phase === "MINT"
            ? "Edict mints the allocated tokens to the whitelisted investor. Confirm in your wallet."
            : "Edict prepares, validates, and verifies the tokenization. You only confirm the exact transaction in your wallet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {run.operations[1] && (run.operations[1].stage !== "NOT_STARTED" || run.phase !== "TOKENIZATION") ? (
          <div className="flex items-center gap-1 text-xs">
            <span className={cn("font-medium", run.operations[0].stage === "READ_BACK_VERIFIED" ? "text-emerald-600" : "text-foreground")}>① Create</span>
            <span className="text-muted-foreground">→</span>
            <span className={cn("font-medium", run.operations[1].stage === "READ_BACK_VERIFIED" ? "text-emerald-600" : run.phase === "WHITELIST" ? "text-foreground" : "text-muted-foreground")}>② Authorize</span>
            <span className="text-muted-foreground">→</span>
            <span className={cn("font-medium", run.operations[2]?.stage === "READ_BACK_VERIFIED" ? "text-emerald-600" : run.phase === "MINT" ? "text-foreground" : "text-muted-foreground")}>③ Issue</span>
          </div>
        ) : null}
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs space-y-1">
          <p><strong>Purpose:</strong> {run.phase === "WHITELIST" ? "Authorize the approved investor" : run.phase === "MINT" ? "Issue the approved allocation" : "Create the approved tokenized asset"}</p>
          <p><strong>Required signer:</strong> <span className="font-mono break-all">{run.requiredSigner.walletAddress}</span></p>
          <p><strong>Network:</strong> Ethereum Sepolia</p>
          <p><strong>Destination:</strong> {run.phase === "WHITELIST" || run.phase === "MINT"
            ? (run.tokenizationResult?.tokenAddress
              ? <span className="font-mono break-all">{run.tokenizationResult.tokenAddress}</span>
              : "Verified token contract from tokenization")
            : "Reviewed Brickken tokenization contract"}</p>
          <p><strong>Estimated fee:</strong> Computed from Brickken&apos;s prepared transaction before the wallet opens</p>
          <p><strong>Maximum fee:</strong> Server-capped per preparation, always below the 0.1 ETH policy ceiling</p>
          <p><strong>Wallet:</strong> {isConnected ? `${wallet.connectorName ?? "Connected wallet"} · ${shortenAddress(wallet.address)}` : "Not connected"}</p>
        </div>
        {run.execution?.reprepareEligible === false && <p role="status">The replacement preparation is no longer usable. Create a new mandate to continue.</p>}
        {canExecute && !isConnected && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Connect your browser wallet to execute this mandate.</p>
            <Button size="sm" type="button" onClick={wallet.openConnectModal}>
              Connect wallet
            </Button>
          </div>
        )}
        {canExecute && isConnected && isNetworkMismatch && (
          <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-2">
            <p className="font-semibold text-amber-800 dark:text-amber-300">Wallet is not on Ethereum Sepolia.</p>
            <p className="text-muted-foreground">This mandate must be executed on Ethereum Sepolia (Sandbox).</p>
            <Button size="sm" variant="outline" type="button" onClick={() => void wallet.switchChain()}>
              Switch to Ethereum Sepolia
            </Button>
          </div>
        )}
        {canExecute && isConnected && !isNetworkMismatch && isSignerMismatch && (
          <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-2">
            <p className="font-semibold text-amber-800 dark:text-amber-300">Wallet account doesn&apos;t match this mandate.</p>
            <div className="space-y-1 font-mono text-[11px]">
              <p><span className="text-muted-foreground">Required: </span><span className="break-all">{run.requiredSigner.walletAddress}</span></p>
              <p><span className="text-muted-foreground">Connected: </span><span className="break-all">{wallet.address}</span></p>
            </div>
            <Button size="sm" variant="outline" type="button" onClick={wallet.openConnectModal}>
              Switch account / wallet
            </Button>
          </div>
        )}
        {canExecute && isConnected && !isNetworkMismatch && !isSignerMismatch && (
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
              disabled={isLocked || executing || preparing}
              onClick={() => void (operation.stage === "PREPARED" ? execute() : prepare())}
            >
              {executing || model.state === "PROMPT_IN_PROGRESS"
                ? "Opening wallet…"
                : preparing
                ? "Preparing with Brickken…"
                : operation.stage === "PREPARED"
                ? "Confirm in wallet"
                : operation.stage === "PREPARED_STALE"
                ? (run.phase === "TOKENIZATION" ? "Reprepare tokenization" : `Reprepare ${phaseLabel}`)
                : `Execute ${phaseLabel}`}
            </Button>
            {(isLocked || executing || preparing) && (
              <p className="text-[11px] text-muted-foreground">
                {executing || model.state === "PROMPT_IN_PROGRESS"
                  ? "Waiting for wallet prompt confirmation."
                  : preparing
                  ? "Contacting Brickken to prepare the transaction."
                  : model.state === "HASH_RECORDED"
                  ? "Transaction broadcast recorded. Awaiting on-chain inclusion."
                  : model.state === "DURABLE_REFRESH_REQUIRED"
                  ? "Durable record changed. Refresh the record to continue."
                  : "Action temporarily locked while processing."}
              </p>
            )}
          </div>
        )}
        {!canExecute && !hasHash && !needsAttention && !budgetExhausted && run.phase !== "VERIFICATION" && (
          <p className="text-xs text-muted-foreground">
            {run.status === "PREPARING"
              ? "Edict is preparing this operation with Brickken."
              : "Operation is not ready for execution. Refresh the record to sync status."}
          </p>
        )}
        {canTrack && (
          <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs space-y-2.5">
            {/* Transaction submitted. Edict is verifying it automatically; no further submission will occur. */}
            <ul className="space-y-1.5 font-sans">
              <li className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold" aria-hidden="true">✓</span>
                  <span className="font-medium text-foreground">Transaction submitted</span>
                </div>
                {operation.blockchainTxHash && (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${operation.blockchainTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground underline decoration-muted-foreground/40 underline-offset-2"
                  >
                    <span>{shortenAddress(operation.blockchainTxHash)}</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </li>
              <li className="flex items-center gap-2">
                {isStageIncluded ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold" aria-hidden="true">✓</span>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold animate-pulse" aria-hidden="true">●</span>
                )}
                <span className="font-medium text-foreground">
                  Included on Ethereum Sepolia
                </span>
              </li>
              <li className="flex items-center gap-2">
                {isStageFinalized ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold" aria-hidden="true">✓</span>
                ) : isStageIncluded ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold animate-pulse" aria-hidden="true">●</span>
                ) : (
                  <span className="text-muted-foreground/60 font-bold" aria-hidden="true">○</span>
                )}
                <span className={cn(isStageFinalized || isStageIncluded ? "font-medium text-foreground" : "text-muted-foreground")}>
                  {isStageFinalized
                    ? "Finalized on Ethereum Sepolia"
                    : `Finalizing — ${confirmations !== null ? `${confirmations} / 2` : "1 / 2"} required confirmations`}
                </span>
              </li>
              <li className="flex items-center gap-2">
                {isStageFinalized ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold animate-pulse" aria-hidden="true">●</span>
                ) : (
                  <span className="text-muted-foreground/60 font-bold" aria-hidden="true">○</span>
                )}
                <span className={cn(isStageFinalized ? "font-medium text-foreground" : "text-muted-foreground")}>
                  Verifying lifecycle state
                </span>
              </li>
            </ul>
            {brickkenWait && (
              <p className="text-[11px] font-medium text-foreground">{brickkenWait}</p>
            )}
            <p className="text-[11px] text-muted-foreground pt-1.5 border-t border-emerald-500/20">
              Transaction submitted. Edict is verifying it automatically; no further submission will occur. No action required. Edict will continue automatically.
            </p>
          </div>
        )}
        {run.operations[2]?.stage === "READ_BACK_VERIFIED" && (
          <div role="status" className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
            <CheckCircle2 className="h-4 w-4 shrink-0" />Asset tokenized, investor authorized, and tokens minted.
          </div>
        )}
        {run.operations[0]?.stage === "READ_BACK_VERIFIED" && run.operations[2]?.stage !== "READ_BACK_VERIFIED" && (
          <div role="status" className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
            <CheckCircle2 className="h-4 w-4 shrink-0" />Tokenized asset created and verified.
          </div>
        )}
        {run.tokenizationResult && <dl className="text-xs space-y-2 break-all">
          <div><dt>Token address</dt><dd>{run.tokenizationResult.tokenAddress}</dd></div>
          <div><dt>Escrow</dt><dd>{run.tokenizationResult.escrowAddress ?? "Not recorded in this historical run"}</dd></div>
          <div><dt>Tokenization ID</dt><dd>{run.tokenizationResult.tokenizationId ?? "Not recorded in this historical run"}</dd></div>
          <div><dt>Transaction</dt><dd>{run.tokenizationResult.transactionHash}</dd></div>
          <div><dt>Verification</dt><dd>{run.tokenizationResult.verificationStatus}</dd></div>
        </dl>}
        {needsAttention && <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />{verificationFailure
            ?? (budgetExhausted
              ? "All allowed preparation attempts (maximum 2) have expired. This execution cannot proceed. Create a new mandate to continue."
              : "We couldn't confirm the preparation with Brickken. No wallet transaction was requested. This execution needs attention.")}
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
            <div><dt className="inline font-medium">Phase: </dt><dd className="inline">{run.phase}</dd></div>
            <div><dt className="inline font-medium">Status: </dt><dd className="inline">{run.status}</dd></div>
            {run.operations.map((op) => (
              <div key={op.id}><dt className="inline font-medium">{op.kind} stage: </dt><dd className="inline">{op.stage}</dd></div>
            ))}
            {operation.blockchainTxHash && <div><dt className="inline font-medium">Transaction: </dt><dd className="inline font-mono break-all">{operation.blockchainTxHash}</dd></div>}
          </dl>
        </details>
      </CardContent>
    </Card>
  );
}
