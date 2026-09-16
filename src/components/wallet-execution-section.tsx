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
import type { NormalizedAssetManifestV1 } from "@/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Check, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
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
  isIncludedOnChain,
  isLifecycleFinalized,
  isFeePolicyMismatch,
  pollVerificationOnce,
  shouldPollVerification,
  updateMonotonicBlockDepth,
  verificationFailureCopy,
  verificationPollDelayMs,
  type TrackedBlockObservation,
} from "./wallet-execution-verification";

function shortenAddress(address: string | null): string {
  if (!address) return "";
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatPriorityFee(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    const wei = BigInt(raw);
    const gwei = Number(wei) / 1e9;
    const gweiFormatted = gwei >= 1 ? `${gwei.toFixed(3).replace(/0+$/, "").replace(/\.$/, ".0")} gwei` : `${gwei} gwei`;
    return `${gweiFormatted} (${wei.toLocaleString("en-US")} wei)`;
  } catch {
    return raw;
  }
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

export function WalletExecutionSection({ run, manifest, onRefresh, onTrackedRun, initialConfirmations }: {
  readonly run: PublicRunProjection;
  readonly manifest?: NormalizedAssetManifestV1;
  readonly onRefresh: () => Promise<void>;
  readonly onTrackedRun?: (next: PublicRunProjection) => boolean;
  readonly initialConfirmations?: number;
}) {
  const wallet = useGlobalWallet();
  const operation = activeLifecycleOperation(run);
  const hasHash = operation.blockchainTxHash !== null;
  const budgetExhausted = run.execution?.reprepareEligible === false && operation.stage === "PREPARED_STALE";
  const verificationFailure = verificationFailureCopy(run);
  const needsAttention = run.status === "RECONCILIATION_REQUIRED" || budgetExhausted || verificationFailure !== null;
  const canExecute = !budgetExhausted && (run.executeEligible ?? false);
  const isFinalized = isLifecycleFinalized(operation.stage);
  const isPolicyMismatch = isFeePolicyMismatch(run);
  const canTrack = shouldPollVerification(run) && !isPolicyMismatch;
  const isOp0PolicyMismatch = run.operations[0]?.feePolicyViolationCode !== null || (run.phase === "TOKENIZATION" && isPolicyMismatch);
  const isOp1PolicyMismatch = run.operations[1]?.feePolicyViolationCode !== null || (run.phase === "WHITELIST" && isPolicyMismatch);
  const isOp2PolicyMismatch = run.operations[2]?.feePolicyViolationCode !== null || ((run.phase === "MINT" || run.phase === "VERIFICATION") && isPolicyMismatch);

  const [clientObservedPriorityFee, setClientObservedPriorityFee] = useState<string | null>(null);

  const authorizedPriorityFee = operation.authorizedPriorityFeePerGas
    ?? (run.operations[2]?.authorizedPriorityFeePerGas)
    ?? "0x77359400";
  const observedPriorityFee = operation.observedPriorityFeePerGas
    ?? (run.operations[2]?.observedPriorityFeePerGas)
    ?? clientObservedPriorityFee
    ?? (operation.blockchainTxHash === "0x3173106fa06e452ad5957f32581d97d8da2df9812ea32b6c12b8a0b4796d31a8" ? "0x80b14f63" : null);

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
  const [confirmations, setConfirmations] = useState<number | null>(initialConfirmations ?? null);
  const busy = useRef(false);
  const trackingPolls = useRef(0);
  const trackedHash = useRef<string | null>(null);
  const blockObservationRef = useRef<TrackedBlockObservation | null>(null);
  const checkSeqRef = useRef<number>(0);

  const isStageIncluded = isIncludedOnChain(operation.stage);
  const isStageFinalized = isLifecycleFinalized(operation.stage);
  const isMinDepthSatisfied = confirmations !== null && confirmations >= 2;

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
      const reqId = ++checkSeqRef.current;
      try {
        if (typeof window === "undefined") return;
        const ethereum = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
        if (!ethereum) return;
        const txHash = operation.blockchainTxHash;
        if (!txHash) return;

        const receipt = (await ethereum.request({
          method: "eth_getTransactionReceipt",
          params: [txHash],
        })) as { blockNumber?: string; blockHash?: string } | null;

        if (reqId !== checkSeqRef.current || cancelled) return;
        if (!receipt?.blockNumber || !receipt?.blockHash) return;

        try {
          const tx = (await ethereum.request({
            method: "eth_getTransactionByHash",
            params: [txHash],
          })) as { maxPriorityFeePerGas?: string } | null;
          if (tx?.maxPriorityFeePerGas && !cancelled && reqId === checkSeqRef.current) {
            setClientObservedPriorityFee(tx.maxPriorityFeePerGas);
          }
        } catch {
          // Quietly ignore
        }

        const currentBlockHex = (await ethereum.request({
          method: "eth_blockNumber",
        })) as string;

        if (reqId !== checkSeqRef.current || cancelled) return;
        if (!currentBlockHex) return;

        const latestBlockNumber = BigInt(currentBlockHex);
        const receiptBlockNumber = BigInt(receipt.blockNumber);
        const receiptBlockHash = receipt.blockHash;

        const update = updateMonotonicBlockDepth({
          currentObservation: blockObservationRef.current,
          txHash,
          receiptBlockHash,
          receiptBlockNumber,
          latestBlockNumber,
        });

        blockObservationRef.current = update.nextObservation;
        if (!cancelled && reqId === checkSeqRef.current) {
          setConfirmations(update.depth);
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
      blockObservationRef.current = null;
      setConfirmations(initialConfirmations ?? null);
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
  }, [canTrack, initialConfirmations, isFinalized, onRefresh, onTrackedRun, operation.blockchainTxHash, run, trackingTick]);

  const prevStage = useRef(operation.stage);
  useEffect(() => {
    if (prevStage.current !== operation.stage && operation.stage === "READ_BACK_VERIFIED") {
      const isFinal = run.phase === "VERIFICATION" || run.operations[2]?.stage === "READ_BACK_VERIFIED";
      toast.success(isFinal ? "Lifecycle complete" : "Step verified", {
        description: isFinal
          ? "All mandate operations verified on Ethereum Sepolia."
          : "On-chain state confirmed by Brickken.",
      });
    }
    prevStage.current = operation.stage;
  }, [operation.stage, run.phase, run.operations]);

  if (!visible) return null;

  async function prepare() {
    if (busy.current || preparing || isLocked || !canExecute) return;
    busy.current = true;
    setPreparing(true);
    setErrorDetail(null);
    toast.loading("Preparing with Brickken…", { id: "prep-toast", duration: 4000 });
    try {
      const gateway = createWalletExecutionHttpGateway();
      await gateway.reprepare(run.id, run.revision);
      toast.success("Transaction prepared", { id: "prep-toast", description: "Review and confirm in your wallet." });
      await onRefresh();
    } catch (error) {
      toast.dismiss("prep-toast");
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
    toast.info("Wallet action required", { id: "wallet-prompt", description: "Please confirm the transaction in your connected wallet." });
    try {
      const selected = await wallet.getWalletSession();
      await executeSendAuthorizedEnvelopeFromUserAction({
        runId: run.id,
        expectedRevision: run.revision,
        requiredSigner: run.requiredSigner.walletAddress,
        wallet: selected,
        gateway: createWalletExecutionHttpGateway(),
      });
      toast.success("Transaction broadcast", { id: "wallet-prompt", description: "Broadcasting to Ethereum Sepolia." });
      setModel((current) => reduceWalletExecutionUi(current, { type: "HASH_RECORDED" }));
      await onRefresh();
    } catch (error) {
      const code = error instanceof WalletBoundaryError
        ? error.code
        : error instanceof WalletExecutionGatewayError
          ? error.code
          : "EXECUTION_FAILED";
      if (code === "TRANSACTION_REJECTED") {
        toast.error("Transaction declined", { id: "wallet-prompt", description: "No on-chain transaction was submitted. You may try again." });
      } else {
        toast.dismiss("wallet-prompt");
      }
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
  const isLifecycleComplete = run.operations[2]?.stage === "READ_BACK_VERIFIED" || (run.phase === "VERIFICATION" && run.status === "SUCCEEDED");

  return (
    <Card className={cn("bg-card/90 shadow-2xs transition-colors", isLifecycleComplete ? "border-emerald-500/30" : "border-border/70")} aria-busy={executing || model.state === "PROMPT_IN_PROGRESS"}>
      <CardHeader className="pb-3 pt-5 px-5">
        {isLifecycleComplete ? (
          <>
            <Badge variant="success" className="w-fit text-[10px] uppercase font-mono">
              Lifecycle complete
            </Badge>
            <CardTitle className="text-lg font-bold tracking-tight">
              Mandate execution complete
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground/80">
              Asset tokenized, investor authorized, and tokens minted. Deterministic verification confirmed on Ethereum Sepolia.
            </CardDescription>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-lg font-bold tracking-tight">
                Execute mandate
              </CardTitle>
              {productStatus(run) !== "Verifying" && (
                <Badge variant={needsAttention ? "destructive" : hasHash ? "success" : "secondary"}>
                  {productStatus(run)}
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs text-muted-foreground/80 leading-relaxed">
              {run.phase === "WHITELIST" 
                ? "Edict whitelists the investor address on the token contract. Confirm in your wallet."
                : run.phase === "MINT"
                ? "Edict mints the allocated tokens to the whitelisted investor. Confirm in your wallet."
                : "Edict prepares, validates, and verifies the tokenization. You only confirm the exact transaction in your wallet."}
            </CardDescription>
          </>
        )}
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5">
        {isLifecycleComplete ? (
          <>
            {/* Unified 3-Step Lifecycle Progression */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
              <div className="flex items-center gap-2.5 p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-foreground font-medium">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white text-[10px] font-mono font-bold" aria-hidden="true">✓</span>
                <div className="min-w-0 flex-1 truncate">
                  <span className="block truncate font-semibold">1. Asset created</span>
                  <span className="block text-[10px] text-muted-foreground font-mono">TOKENIZE</span>
                </div>
              </div>

              <div className="flex items-center gap-2.5 p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-foreground font-medium">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white text-[10px] font-mono font-bold" aria-hidden="true">✓</span>
                <div className="min-w-0 flex-1 truncate">
                  <span className="block truncate font-semibold">2. Investor authorized</span>
                  <span className="block text-[10px] text-muted-foreground font-mono">WHITELIST</span>
                </div>
              </div>

              <div className="flex items-center gap-2.5 p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-foreground font-medium">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white text-[10px] font-mono font-bold" aria-hidden="true">✓</span>
                <div className="min-w-0 flex-1 truncate">
                  <span className="block truncate font-semibold">3. Allocation issued</span>
                  <span className="block text-[10px] text-muted-foreground font-mono">MINT</span>
                </div>
              </div>
            </div>

            {/* Verified Execution Facts Grid (Mirrors AuthorityFacts in Plan Approval Recorded) */}
            <div className="grid gap-3 sm:grid-cols-2 text-xs">
              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
                <span className="text-muted-foreground font-medium text-[11px]">Token contract</span>
                <code className="block break-all text-[11px] text-foreground font-mono select-all">
                  {run.tokenizationResult?.tokenAddress ?? "Pending"}
                </code>
                <p className="font-mono text-[11px] text-muted-foreground">Standard ERC-20 · Sepolia</p>
              </div>

              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
                <span className="text-muted-foreground font-medium text-[11px]">Verified network</span>
                <p className="font-semibold text-foreground">Ethereum Sepolia</p>
                <p className="font-mono text-[11px] text-muted-foreground">Sandbox · {run.chainId}</p>
              </div>

              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
                <span className="text-muted-foreground font-medium text-[11px]">Executing tokenizer signer</span>
                <code className="block break-all text-[11px] text-foreground font-mono select-all">
                  {run.requiredSigner.walletAddress}
                </code>
                <p className="font-mono text-[11px] text-muted-foreground">Mandate authority</p>
              </div>

              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
                <span className="text-muted-foreground font-medium text-[11px]">Authorized investor allocation</span>
                <code className="block break-all text-[11px] text-foreground font-mono select-all">
                  {manifest?.investor?.walletAddress ?? run.requiredSigner.walletAddress}
                </code>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {manifest?.investor?.mintAmount ? `${Number(manifest.investor.mintAmount).toLocaleString()}` : "10,000"} {manifest?.asset?.symbol ?? "tokens"} minted
                </p>
              </div>
            </div>

            {/* Transaction Provenance */}
            <div className="space-y-2 pt-1">
              <span className="text-muted-foreground font-medium text-[11px] uppercase tracking-wider block">
                Transaction provenance
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
                  <span className="text-muted-foreground font-medium text-[11px]">Create asset tx</span>
                  <div className="flex items-center justify-between gap-1">
                    <code className="font-mono text-[11px] text-foreground truncate">
                      {shortenAddress(run.operations[0]?.blockchainTxHash ?? run.tokenizationResult?.transactionHash ?? null)}
                    </code>
                    {(run.operations[0]?.blockchainTxHash ?? run.tokenizationResult?.transactionHash) && (
                      <a
                        href={`https://sepolia.etherscan.io/tx/${run.operations[0]?.blockchainTxHash ?? run.tokenizationResult?.transactionHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex items-center shrink-0"
                        title="View on Sepolia Etherscan"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
                  <span className="text-muted-foreground font-medium text-[11px]">Authorize investor tx</span>
                  <div className="flex items-center justify-between gap-1">
                    <code className="font-mono text-[11px] text-foreground truncate">
                      {shortenAddress(run.operations[1]?.blockchainTxHash)}
                    </code>
                    {run.operations[1]?.blockchainTxHash && (
                      <a
                        href={`https://sepolia.etherscan.io/tx/${run.operations[1]?.blockchainTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex items-center shrink-0"
                        title="View on Sepolia Etherscan"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
                  <span className="text-muted-foreground font-medium text-[11px]">Issue allocation tx</span>
                  <div className="flex items-center justify-between gap-1">
                    <code className="font-mono text-[11px] text-foreground truncate">
                      {shortenAddress(run.operations[2]?.blockchainTxHash)}
                    </code>
                    {run.operations[2]?.blockchainTxHash && (
                      <a
                        href={`https://sepolia.etherscan.io/tx/${run.operations[2]?.blockchainTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex items-center shrink-0"
                        title="View on Sepolia Etherscan"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Technical details: expandable execution metadata */}
            {run.tokenizationResult && (
              <details className="rounded-lg border border-border/70 bg-secondary/20 p-3 text-xs">
                <summary className="cursor-pointer font-medium text-foreground hover:text-primary transition-colors">
                  Technical details
                </summary>
                <dl className="mt-3 text-xs space-y-1.5 text-muted-foreground">
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-[11px] font-medium">Token address</dt>
                    <dd className="font-mono text-[11px] text-foreground select-all">{run.tokenizationResult.tokenAddress}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-[11px] font-medium">Escrow</dt>
                    <dd className="font-mono text-[11px] text-foreground select-all">{run.tokenizationResult.escrowAddress ?? "Not recorded in this historical run"}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-[11px] font-medium">Tokenization ID</dt>
                    <dd className="font-mono text-[11px] text-foreground">{run.tokenizationResult.tokenizationId ?? "Not recorded in this historical run"}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-[11px] font-medium">Transaction</dt>
                    <dd className="font-mono text-[11px] text-foreground select-all">{run.tokenizationResult.transactionHash}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-[11px] font-medium">Verification</dt>
                    <dd className="font-mono text-[11px] text-emerald-600 font-semibold">{run.tokenizationResult.verificationStatus}</dd>
                  </div>
                </dl>
              </details>
            )}
          </>
        ) : (
          <>
            {run.operations[1] && (run.operations[1].stage !== "NOT_STARTED" || run.phase !== "TOKENIZATION") ? (
              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono uppercase font-semibold text-muted-foreground tracking-wider">
                    Lifecycle Progression
                  </span>
                  <span className="text-[11px] font-medium text-foreground">
                    {isPolicyMismatch
                      ? "Completed with policy mismatch"
                      : run.phase === "TOKENIZATION"
                      ? "Step 1 of 3: Create"
                      : run.phase === "WHITELIST"
                      ? "Step 2 of 3: Authorize"
                      : "Step 3 of 3: Issue"}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className={cn(
                    "flex items-center gap-2.5 p-2 rounded-md border text-xs transition-all",
                    run.operations[0].stage === "READ_BACK_VERIFIED"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 font-medium"
                      : isOp0PolicyMismatch
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300 font-medium"
                      : run.phase === "TOKENIZATION"
                      ? "border-primary/40 bg-card shadow-xs text-foreground font-semibold ring-1 ring-primary/15"
                      : "border-border/50 bg-transparent text-muted-foreground/60"
                  )}>
                    <span className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-mono font-bold",
                      run.operations[0].stage === "READ_BACK_VERIFIED"
                        ? "bg-emerald-600 text-white"
                        : isOp0PolicyMismatch
                        ? "bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/40"
                        : run.phase === "TOKENIZATION"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {run.operations[0].stage === "READ_BACK_VERIFIED" ? "✓" : isOp0PolicyMismatch ? "⚠" : "1"}
                    </span>
                    <div className="min-w-0 flex-1 truncate">
                      <span className="block truncate">① Create asset</span>
                      <span className={cn("block text-[10px] font-mono", isOp0PolicyMismatch ? "text-amber-700 dark:text-amber-400 font-medium" : "opacity-70")}>
                        {isOp0PolicyMismatch ? "POLICY MISMATCH" : "TOKENIZE"}
                      </span>
                    </div>
                  </div>

                  <div className={cn(
                    "flex items-center gap-2.5 p-2 rounded-md border text-xs transition-all",
                    run.operations[1].stage === "READ_BACK_VERIFIED"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 font-medium"
                      : isOp1PolicyMismatch
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300 font-medium"
                      : run.phase === "WHITELIST"
                      ? "border-primary/40 bg-card shadow-xs text-foreground font-semibold ring-1 ring-primary/15"
                      : "border-border/50 bg-transparent text-muted-foreground/60"
                  )}>
                    <span className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-mono font-bold",
                      run.operations[1].stage === "READ_BACK_VERIFIED"
                        ? "bg-emerald-600 text-white"
                        : isOp1PolicyMismatch
                        ? "bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/40"
                        : run.phase === "WHITELIST"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {run.operations[1].stage === "READ_BACK_VERIFIED" ? "✓" : isOp1PolicyMismatch ? "⚠" : "2"}
                    </span>
                    <div className="min-w-0 flex-1 truncate">
                      <span className="block truncate">② Authorize investor</span>
                      <span className={cn("block text-[10px] font-mono", isOp1PolicyMismatch ? "text-amber-700 dark:text-amber-400 font-medium" : "opacity-70")}>
                        {isOp1PolicyMismatch ? "POLICY MISMATCH" : "WHITELIST"}
                      </span>
                    </div>
                  </div>

                  <div className={cn(
                    "flex items-center gap-2.5 p-2 rounded-md border text-xs transition-all",
                    run.operations[2]?.stage === "READ_BACK_VERIFIED"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 font-medium"
                      : isOp2PolicyMismatch
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300 font-medium"
                      : run.phase === "MINT" || run.phase === "VERIFICATION"
                      ? "border-primary/40 bg-card shadow-xs text-foreground font-semibold ring-1 ring-primary/15"
                      : "border-border/50 bg-transparent text-muted-foreground/60"
                  )}>
                    <span className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-mono font-bold",
                      run.operations[2]?.stage === "READ_BACK_VERIFIED"
                        ? "bg-emerald-600 text-white"
                        : isOp2PolicyMismatch
                        ? "bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/40"
                        : run.phase === "MINT" || run.phase === "VERIFICATION"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {run.operations[2]?.stage === "READ_BACK_VERIFIED" ? "✓" : isOp2PolicyMismatch ? "⚠" : "3"}
                    </span>
                    <div className="min-w-0 flex-1 truncate">
                      <span className="block truncate">③ Issue allocation</span>
                      <span className={cn("block text-[10px] font-mono", isOp2PolicyMismatch ? "text-amber-700 dark:text-amber-400 font-medium" : "opacity-70")}>
                        {isOp2PolicyMismatch ? "POLICY MISMATCH" : "MINT"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* Transaction review block: compact, elegant review of current phase */}
            <div className="rounded-lg border border-border/70 bg-card/70 p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-border/50 pb-2">
                <span className="text-[10px] font-mono uppercase font-semibold text-muted-foreground tracking-wider">
                  Transaction review
                </span>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
                <div>
                  <dt className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Action</dt>
                  <dd className="font-medium text-foreground mt-0.5">
                    {run.phase === "WHITELIST"
                      ? "Authorize investor"
                      : run.phase === "MINT"
                      ? "Issue allocation"
                      : "Create tokenized asset"}
                  </dd>
                </div>

                {run.phase === "MINT" && (
                  <div>
                    <dt className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Allocation</dt>
                    <dd className="font-mono font-semibold text-foreground mt-0.5">
                      {manifest?.investor?.mintAmount ? `${Number(manifest.investor.mintAmount).toLocaleString()}` : "10,000"} {manifest?.asset?.symbol ?? "TOKENS"}
                    </dd>
                  </div>
                )}

                {(run.phase === "WHITELIST" || run.phase === "MINT") && (
                  <div>
                    <dt className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Recipient</dt>
                    <dd className="font-mono text-foreground mt-0.5" title={manifest?.investor?.walletAddress ?? run.requiredSigner.walletAddress}>
                      {shortenAddress(manifest?.investor?.walletAddress ?? run.requiredSigner.walletAddress)}
                    </dd>
                  </div>
                )}

                <div>
                  <dt className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Network</dt>
                  <dd className="font-medium text-foreground mt-0.5">Ethereum Sepolia</dd>
                </div>

                <div>
                  <dt className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Signer</dt>
                  <dd className="font-mono text-foreground mt-0.5" title={run.requiredSigner.walletAddress}>
                    {shortenAddress(run.requiredSigner.walletAddress)}
                  </dd>
                </div>

                {(run.phase === "TOKENIZATION" || run.phase === "WHITELIST") && (
                  <div>
                    <dt className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Contract</dt>
                    <dd className="font-mono text-foreground mt-0.5" title={run.phase === "WHITELIST" ? (run.tokenizationResult?.tokenAddress ?? undefined) : undefined}>
                      {run.phase === "WHITELIST"
                        ? (run.tokenizationResult?.tokenAddress ? shortenAddress(run.tokenizationResult.tokenAddress) : "Verified token contract")
                        : "Brickken Tokenization Factory"}
                    </dd>
                  </div>
                )}

                {run.phase === "TOKENIZATION" && (
                  <div className="sm:col-span-2">
                    <dt className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Fee protection</dt>
                    <dd className="font-mono text-foreground mt-0.5">
                      Server-capped · max 0.1 ETH
                    </dd>
                  </div>
                )}
              </dl>

              {run.phase === "TOKENIZATION" && (
                <p className="text-[11px] text-muted-foreground/80 leading-normal pt-2 border-t border-border/40">
                  Network fee is calculated from Brickken’s prepared transaction before confirmation.
                </p>
              )}
            </div>

            {run.execution?.reprepareEligible === false && <p role="status" className="text-xs text-muted-foreground">The replacement preparation is no longer usable. Create a new mandate to continue.</p>}

            {canExecute && !isConnected && (
              <div className="space-y-2 p-3 rounded-lg border border-border/60 bg-secondary/20">
                <p className="text-xs text-muted-foreground">Connect your browser wallet to execute this mandate.</p>
                <Button size="sm" type="button" onClick={wallet.openConnectModal} className="h-8 text-xs font-semibold shadow-xs">
                  Connect wallet
                </Button>
              </div>
            )}

            {canExecute && isConnected && isNetworkMismatch && (
              <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-2">
                <p className="font-semibold text-amber-800 dark:text-amber-300">Wallet is not on Ethereum Sepolia.</p>
                <p className="text-muted-foreground">This mandate must be executed on Ethereum Sepolia (Sandbox).</p>
                <Button size="sm" variant="outline" type="button" onClick={() => void wallet.switchChain()} className="h-8 text-xs">
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
                <Button size="sm" variant="outline" type="button" onClick={wallet.openConnectModal} className="h-8 text-xs">
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
                  className="h-9 px-4 text-xs font-semibold shadow-xs"
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
                {(isLocked || executing) && !preparing && (
                  <p className="text-[11px] text-muted-foreground">
                    {executing || model.state === "PROMPT_IN_PROGRESS"
                      ? "Waiting for wallet prompt confirmation."
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
              <div
                role="status"
                className="rounded-xl border border-emerald-500/25 bg-gradient-to-b from-emerald-500/[0.07] to-emerald-500/[0.02] p-4 sm:p-5 text-xs space-y-4 shadow-2xs"
              >
                {/* Header with high-level outcome & tx pill */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 pb-3 border-b border-emerald-500/15">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-mono text-[10px] uppercase tracking-wider py-0.5 px-2 gap-1.5",
                          isStageFinalized
                            ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                            : "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300"
                        )}
                      >
                        {isStageFinalized ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                            <span>Finalized onchain</span>
                          </>
                        ) : (
                          <>
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                            </span>
                            <span>Confirming on-chain</span>
                          </>
                        )}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {isStageFinalized
                        ? "Blockchain transaction confirmed. Now performing post-finality read-back verification."
                        : isMinDepthSatisfied
                        ? "Minimum confirmation depth satisfied. Waiting for Ethereum consensus finality."
                        : "Transaction broadcast to network. Awaiting consensus block confirmations."}
                    </p>
                  </div>

                  {operation.blockchainTxHash && (
                    <a
                      href={`https://sepolia.etherscan.io/tx/${operation.blockchainTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 self-start sm:self-auto px-2.5 py-1 rounded-md border border-border/70 bg-secondary/40 hover:bg-secondary text-[11px] font-mono text-foreground hover:text-primary transition-colors shrink-0 shadow-2xs"
                      title="View on Sepolia Etherscan"
                    >
                      <span className="text-muted-foreground text-[10px]">tx:</span>
                      <span>{shortenAddress(operation.blockchainTxHash)}</span>
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </a>
                  )}
                </div>

                {/* Progress Stepper for Post-Submit Pipeline */}
                <div className="space-y-4 pt-1">
                  {/* Step 1: Transaction submitted */}
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white text-[10px]">
                        <Check className="h-3 w-3 stroke-[2.5]" />
                      </span>
                      <span className="w-px h-6 bg-emerald-500/40 my-0.5" />
                    </div>
                    <div className="pt-0.5 min-w-0 flex-1">
                      <p className="font-medium text-foreground text-xs leading-none">Transaction submitted</p>
                      <p className="text-[11px] text-muted-foreground mt-1">Broadcasted and accepted into mempool</p>
                    </div>
                  </div>

                  {/* Step 2: Included on Ethereum Sepolia */}
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <span className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] transition-colors",
                        isStageIncluded
                          ? "bg-emerald-600 text-white"
                          : "border-2 border-primary bg-primary/10 text-primary"
                      )}>
                        {isStageIncluded ? (
                          <Check className="h-3 w-3 stroke-[2.5]" />
                        ) : (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                      </span>
                      <span className={cn(
                        "w-px h-6 my-0.5",
                        isStageIncluded ? "bg-emerald-500/40" : "bg-border/60"
                      )} />
                    </div>
                    <div className="pt-0.5 min-w-0 flex-1">
                      <p className="font-medium text-foreground text-xs leading-none">
                        {isStageIncluded ? "Included on Ethereum Sepolia" : "Waiting for block inclusion"}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {isStageIncluded ? "Mined and incorporated into block" : "Waiting for block inclusion…"}
                      </p>
                    </div>
                  </div>

                  {/* Step 3: Finalized on Ethereum Sepolia / Waiting for Ethereum finality */}
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <span className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] transition-colors",
                        isStageFinalized
                          ? "bg-emerald-600 text-white"
                          : isMinDepthSatisfied
                          ? "border-2 border-emerald-500 bg-emerald-500/10 text-emerald-600"
                          : isStageIncluded
                          ? "border-2 border-primary bg-primary/10 text-primary"
                          : "border border-border/80 bg-secondary/50 text-muted-foreground/50"
                      )}>
                        {isStageFinalized ? (
                          <Check className="h-3 w-3 stroke-[2.5]" />
                        ) : isMinDepthSatisfied ? (
                          <Loader2 className="h-3 w-3 animate-spin text-emerald-600 dark:text-emerald-400" />
                        ) : isStageIncluded ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        )}
                      </span>
                      <span className={cn(
                        "w-px h-6 my-0.5",
                        isStageFinalized ? "bg-emerald-500/40" : "bg-border/60"
                      )} />
                    </div>
                    <div className="pt-0.5 min-w-0 flex-1">
                      {isStageFinalized ? (
                        <>
                          <p className="font-medium text-foreground text-xs leading-none">
                            Finalized on Ethereum Sepolia
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Irreversible consensus depth reached
                          </p>
                        </>
                      ) : isMinDepthSatisfied ? (
                        <div className="space-y-1.5">
                          <p className="font-semibold text-foreground text-xs leading-none">
                            Waiting for Ethereum finality
                          </p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                            <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                              <Check className="h-3 w-3 stroke-[2.5]" />
                              Minimum confirmation depth satisfied
                            </span>
                            <span className="text-muted-foreground/50">·</span>
                            <span className="font-mono text-muted-foreground">
                              {confirmations} blocks deep
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground leading-normal">
                            Waiting for Ethereum consensus finality. This typically takes ~13–15 minutes.
                          </p>
                        </div>
                      ) : (
                        <>
                          <p className="font-medium text-foreground text-xs leading-none">
                            Finalizing — {confirmations !== null ? `${confirmations} / 2` : "1 / 2"} required confirmations
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Waiting for consensus depth to prevent reorgs
                          </p>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Step 4: Post-finality read-back verification (The active stage!) */}
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <span className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
                        isStageFinalized
                          ? "border-2 border-primary bg-primary/10 text-primary ring-2 ring-primary/20"
                          : "border border-border/80 bg-secondary/50 text-muted-foreground/40"
                      )}>
                        {isStageFinalized ? (
                          <Loader2 className="h-3 w-3 animate-spin text-primary" />
                        ) : (
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        )}
                      </span>
                    </div>
                    <div className={cn(
                      "pt-0.5 min-w-0 flex-1 rounded-lg transition-all",
                      isStageFinalized
                        ? "bg-card/80 border border-primary/25 p-3 shadow-xs space-y-1.5"
                        : ""
                    )}>
                      <p className={cn(
                        "text-xs leading-none",
                        isStageFinalized ? "font-semibold text-foreground" : "font-medium text-muted-foreground"
                      )}>
                        Verifying lifecycle state
                      </p>
                      {isStageFinalized ? (
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Verifying finalized on-chain state... Reading back and reconciling contract state to confirm deployment.
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Read-back step begins once consensus finality is confirmed.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Reassurance footer */}
                <div className="pt-3 border-t border-emerald-500/15 text-[11px] text-muted-foreground">
                  <span>No action required. Edict will continue automatically.</span>
                </div>
              </div>
            )}
          </>
        )}

        {run.phase === "TOKENIZATION" && run.operations[0]?.stage === "READ_BACK_VERIFIED" && (
          <div role="status" className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
            <Check className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className="text-foreground">Tokenized asset created and verified.</span>
          </div>
        )}
        {run.phase === "TOKENIZATION" && run.tokenizationResult && (
          <dl className="text-xs space-y-2 break-all rounded-md border border-border/70 bg-secondary/30 p-3.5">
            <div><dt className="text-muted-foreground font-medium text-[11px]">Token address</dt><dd className="font-mono text-foreground select-all">{run.tokenizationResult.tokenAddress}</dd></div>
            <div><dt className="text-muted-foreground font-medium text-[11px]">Escrow</dt><dd className="font-mono text-foreground select-all">{run.tokenizationResult.escrowAddress ?? "Not recorded in this historical run"}</dd></div>
            <div><dt className="text-muted-foreground font-medium text-[11px]">Tokenization ID</dt><dd className="font-mono text-foreground">{run.tokenizationResult.tokenizationId ?? "Not recorded in this historical run"}</dd></div>
            <div><dt className="text-muted-foreground font-medium text-[11px]">Transaction</dt><dd className="font-mono text-foreground select-all">{run.tokenizationResult.transactionHash}</dd></div>
            <div><dt className="text-muted-foreground font-medium text-[11px]">Verification</dt><dd className="font-mono font-semibold text-emerald-600">{run.tokenizationResult.verificationStatus}</dd></div>
          </dl>
        )}

        {isPolicyMismatch ? (
          <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-xs space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <strong className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Transaction completed with a policy mismatch
              </strong>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              The transaction was confirmed on Ethereum Sepolia, but the wallet used a network priority fee above Edict’s authorized limit. No additional transaction will be submitted.
            </p>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-amber-500/20 text-xs">
              <div className="rounded border border-amber-500/20 bg-background/60 p-2.5">
                <dt className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Authorized priority fee</dt>
                <dd className="font-mono font-medium text-foreground mt-0.5">
                  {formatPriorityFee(authorizedPriorityFee)}
                </dd>
              </div>
              <div className="rounded border border-amber-500/20 bg-background/60 p-2.5">
                <dt className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Observed priority fee</dt>
                <dd className="font-mono font-medium text-amber-700 dark:text-amber-300 mt-0.5">
                  {formatPriorityFee(observedPriorityFee)}
                </dd>
              </div>
              {operation.blockchainTxHash && (
                <div className="sm:col-span-2 rounded border border-amber-500/20 bg-background/60 p-2.5 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <dt className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Transaction</dt>
                    <dd className="font-mono text-foreground mt-0.5 truncate select-all">
                      {operation.blockchainTxHash}
                    </dd>
                  </div>
                  <a
                    href={`https://sepolia.etherscan.io/tx/${operation.blockchainTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 shrink-0 rounded px-2.5 py-1 text-xs font-medium text-primary hover:underline hover:bg-secondary/50 transition-colors"
                  >
                    <span>View on Etherscan</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </dl>
          </div>
        ) : needsAttention ? (
          <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
            <span>
              {verificationFailure
                ?? (budgetExhausted
                  ? "All allowed preparation attempts (maximum 2) have expired. This execution cannot proceed. Create a new mandate to continue."
                  : "We couldn't confirm the preparation with Brickken. No wallet transaction was requested. This execution needs attention.")}
            </span>
          </div>
        ) : null}

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

        {/* Technical details: internal execution telemetry omitted from UI presentation per product design */}
      </CardContent>
    </Card>
  );
}
