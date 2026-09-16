"use client";

import { useRef, useState } from "react";
import type { PublicRunProjection } from "@/shared/run";
import type { PlanningView } from "../run-planning";
import { useGlobalWallet } from "@/client/wallet/global-wallet-context";
import {
  ApprovalGatewayError,
  approveRunFromUserAction,
  readApprovalStatusFromUserAction,
} from "@/client/wallet/approval";
import { createApprovalHttpGateway } from "@/client/run-api/approval-gateway";
import { WalletBoundaryError } from "@/client/wallet/errors";
import type { ApprovalReadinessTarget, PlanApprovalStatus } from "./approval-controller";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";

function approvalEligible(target: ApprovalReadinessTarget): boolean {
  return !target.approved &&
    target.terminalOutcome === null &&
    target.phase === "PLAN" &&
    target.status === "AWAITING_APPROVAL";
}

function AuthorityFacts({ view }: { readonly view: PlanningView }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 text-xs">
      <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1">
        <span className="text-muted-foreground font-medium text-[11px]">Approval target</span>
        <p className="font-semibold text-foreground">{view.manifest.asset.name} · {view.manifest.asset.symbol}</p>
        <p className="font-mono text-[11px] text-muted-foreground">Revision {view.run.revision}</p>
      </div>
      <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1">
        <span className="text-muted-foreground font-medium text-[11px]">Required network</span>
        <p className="font-semibold text-foreground">Ethereum Sepolia</p>
        <p className="font-mono text-[11px] text-muted-foreground">Sandbox · {view.run.chainId}</p>
      </div>
      <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
        <span className="text-muted-foreground font-medium text-[11px]">Required tokenizer signer</span>
        <code className="block break-all text-[11px] text-foreground font-mono">{view.run.requiredSigner.walletAddress}</code>
      </div>
      {view.manifest.investor && (
        <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 min-w-0">
          <span className="text-muted-foreground font-medium text-[11px]">Future allocation · not executed</span>
          <code className="block break-all text-[11px] text-foreground font-mono">{view.manifest.investor.walletAddress}</code>
          <p className="font-mono text-[11px] text-muted-foreground">{view.manifest.investor.mintAmount} tokens</p>
        </div>
      )}
      <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 space-y-1 sm:col-span-2 min-w-0">
        <span className="text-muted-foreground font-medium text-[11px]">Immutable plan hash</span>
        <code className="block break-all text-[11px] text-foreground font-mono">{view.run.planHash}</code>
      </div>
    </div>
  );
}

const approvalCopy: Readonly<Record<PlanApprovalStatus, string>> = Object.freeze({
  IDLE: "",
  IN_PROGRESS: "Approval request in progress. Check your wallet if prompted.",
  SIGNATURE_REJECTED: "Plan approval was not recorded. The wallet signature was rejected.",
  SIGNING_UNSUPPORTED: "This wallet does not support the required plan-approval signature. Connect another wallet.",
  NOT_RECORDED: "Plan approval was not recorded. You may review the plan and try again explicitly.",
  STALE_OR_CHANGED: "The run changed. Review its durable state and wallet readiness before trying again.",
  ACCESS_UNAVAILABLE: "Run access is unavailable. Refresh approval status before any further approval action.",
  UNCONFIRMED: "Approval status could not be confirmed. Do not sign again until durable status is refreshed.",
  REQUEST_FAILED: "Plan approval was not recorded. Review the current state before trying again.",
  RECORDED: "Plan approval recorded.",
});

const approvalAlertStatuses = new Set<PlanApprovalStatus>([
  "SIGNATURE_REJECTED",
  "SIGNING_UNSUPPORTED",
  "NOT_RECORDED",
  "STALE_OR_CHANGED",
  "ACCESS_UNAVAILABLE",
  "UNCONFIRMED",
  "REQUEST_FAILED",
]);

function ActiveReadiness({ view, target, acceptDurableRun }: {
  readonly view: PlanningView;
  readonly target: ApprovalReadinessTarget;
  readonly acceptDurableRun: (run: PublicRunProjection) => boolean;
}) {
  const globalWallet = useGlobalWallet();
  const [approvalStatus, setApprovalStatus] = useState<PlanApprovalStatus>(
    target.approved ? "RECORDED" : "IDLE"
  );
  const [approving, setApproving] = useState(false);
  const approveButton = useRef<HTMLButtonElement>(null);
  const approvalMessage = useRef<HTMLDivElement>(null);

  const isConnected = globalWallet.isConnected && globalWallet.address !== null;
  const isNetworkMismatch = isConnected && !globalWallet.isSepolia;
  const isSignerMismatch = isConnected && (globalWallet.address?.toLowerCase() !== view.run.requiredSigner.walletAddress.toLowerCase());
  const isReady = isConnected && !isNetworkMismatch && !isSignerMismatch;

  const approvalNeedsRefresh = ["ACCESS_UNAVAILABLE", "UNCONFIRMED"].includes(approvalStatus);
  const approvalPending = approvalStatus === "IN_PROGRESS";
  const approvalAlert = approvalAlertStatuses.has(approvalStatus);
  const canApprove = isReady && ["IDLE", "SIGNATURE_REJECTED", "NOT_RECORDED", "REQUEST_FAILED"].includes(approvalStatus);

  async function approve(): Promise<void> {
    if (approving || !isReady) return;
    setApproving(true);
    setApprovalStatus("IN_PROGRESS");
    try {
      const session = await globalWallet.getWalletSession();
      const result = await approveRunFromUserAction({
        authority: target,
        wallet: session,
        gateway: createApprovalHttpGateway(),
        nowEpochSeconds: () => BigInt(Math.floor(Date.now() / 1000)),
      });
      if (result.outcome === "APPROVAL_RECORDED") {
        setApprovalStatus("RECORDED");
        acceptDurableRun(result.run);
        toast.success("Plan approved", { description: "Signing authority confirmed for execution." });
      } else if (result.outcome === "APPROVAL_NOT_RECORDED") {
        const nextStatus = result.reason === "STALE_OR_CHANGED" ? "STALE_OR_CHANGED" : "NOT_RECORDED";
        setApprovalStatus(nextStatus);
        acceptDurableRun(result.run);
      } else if (result.outcome === "ACCESS_UNAVAILABLE") {
        setApprovalStatus("ACCESS_UNAVAILABLE");
      } else if (result.outcome === "APPROVAL_UNCONFIRMED") {
        setApprovalStatus("UNCONFIRMED");
      }
    } catch (error) {
      if (error instanceof WalletBoundaryError) {
        if (error.code === "SIGNATURE_REJECTED") {
          setApprovalStatus("SIGNATURE_REJECTED");
          toast.error("Signature declined", { description: "Wallet signature was rejected." });
        } else if (error.code === "TYPED_DATA_SIGNING_UNSUPPORTED" || error.code === "UNSUPPORTED_METHOD") {
          setApprovalStatus("SIGNING_UNSUPPORTED");
        } else {
          setApprovalStatus("REQUEST_FAILED");
        }
      } else if (error instanceof ApprovalGatewayError) {
        setApprovalStatus(error.code === "ACCESS_UNAVAILABLE" ? "ACCESS_UNAVAILABLE" : "REQUEST_FAILED");
      } else {
        setApprovalStatus("REQUEST_FAILED");
      }
    } finally {
      setApproving(false);
      requestAnimationFrame(() => {
        if (["SIGNATURE_REJECTED", "NOT_RECORDED", "REQUEST_FAILED"].includes(approvalStatus)) {
          approveButton.current?.focus();
        } else if (approvalStatus === "SIGNING_UNSUPPORTED") {
          approvalMessage.current?.focus();
        }
      });
    }
  }

  async function refreshApprovalStatus(): Promise<void> {
    if (approving) return;
    setApproving(true);
    try {
      const result = await readApprovalStatusFromUserAction({
        authority: target,
        gateway: createApprovalHttpGateway(),
        unrecordedReason: "REFUSED_OR_UNRECORDED",
      });
      if (result.outcome === "APPROVAL_RECORDED") {
        setApprovalStatus("RECORDED");
        acceptDurableRun(result.run);
      } else if (result.outcome === "APPROVAL_NOT_RECORDED") {
        setApprovalStatus(result.reason === "STALE_OR_CHANGED" ? "STALE_OR_CHANGED" : "NOT_RECORDED");
        acceptDurableRun(result.run);
      } else if (result.outcome === "ACCESS_UNAVAILABLE") {
        setApprovalStatus("ACCESS_UNAVAILABLE");
      } else if (result.outcome === "APPROVAL_UNCONFIRMED") {
        setApprovalStatus("UNCONFIRMED");
      }
    } catch {
      setApprovalStatus("REQUEST_FAILED");
    } finally {
      setApproving(false);
    }
  }

  return (
    <Card className="border-border/70 bg-card/90 shadow-2xs">
      <CardHeader className="pb-4 pt-5 px-5">
        <div className="flex items-center justify-end">
          <Badge
            variant={isReady ? "success" : "secondary"}
            className="w-fit text-[10px] uppercase font-mono"
          >
            {isReady
              ? "Ready to approve"
              : !isConnected
              ? "Wallet disconnected"
              : isNetworkMismatch
              ? "Wrong network"
              : isSignerMismatch
              ? "Wrong account"
              : "Wallet setup"}
          </Badge>
        </div>
        <CardTitle className="text-lg font-bold tracking-tight">Mandate Approval</CardTitle>
        <CardDescription className="text-xs text-muted-foreground/80 leading-relaxed max-w-2xl">
          Verify the exact tokenizer signer and Ethereum Sepolia before plan approval becomes available.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-5 pb-5">
        <AuthorityFacts view={view} />

        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          <strong className="font-semibold">No transaction is submitted here.</strong>{" "}
          Approving this plan does not submit an on-chain transaction. Execution requests wallet confirmation only when a blockchain write is required.
        </div>

        <Separator className="bg-border/60" />

        {!isConnected && (
          <div role="status" className="rounded-lg border border-border/70 bg-secondary/30 p-3 text-xs space-y-2">
            <p className="font-semibold text-foreground">Connect your browser wallet to approve this mandate.</p>
            <Button size="sm" type="button" onClick={globalWallet.openConnectModal} className="h-8 text-xs">
              Connect wallet
            </Button>
          </div>
        )}

        {isConnected && isNetworkMismatch && (
          <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-2">
            <p className="font-semibold text-amber-800 dark:text-amber-300">Wallet is not on Ethereum Sepolia.</p>
            <Button size="sm" type="button" onClick={() => void globalWallet.switchChain()} className="h-8 text-xs">
              Switch to Ethereum Sepolia
            </Button>
          </div>
        )}

        {isConnected && !isNetworkMismatch && isSignerMismatch && (
          <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-2">
            <p className="font-semibold text-amber-800 dark:text-amber-300">Wallet account doesn&apos;t match this mandate.</p>
            <div className="space-y-1 font-mono text-[11px]">
              <p><span className="text-muted-foreground">Required: </span><span className="break-all">{view.run.requiredSigner.walletAddress}</span></p>
              <p><span className="text-muted-foreground">Connected: </span><span className="break-all">{globalWallet.address}</span></p>
            </div>
            <Button size="sm" variant="outline" type="button" onClick={globalWallet.openConnectModal} className="h-8 text-xs">
              Switch account / wallet
            </Button>
          </div>
        )}


        {(canApprove || approvalPending) && (
          <Button
            ref={approveButton}
            type="button"
            size="sm"
            disabled={approvalPending || approving}
            aria-busy={approvalPending || approving}
            onClick={() => void approve()}
            className="min-w-44"
          >
            {approvalPending ? "Approval request in progress" : "Approve this plan"}
          </Button>
        )}

        {approvalNeedsRefresh && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={approving}
            onClick={() => void refreshApprovalStatus()}
          >
            Refresh approval status
          </Button>
        )}

        {approvalStatus !== "IDLE" && (
          <div
            ref={approvalMessage}
            tabIndex={approvalStatus === "SIGNING_UNSUPPORTED" ? -1 : undefined}
            role={approvalAlert ? "alert" : "status"}
            aria-live="polite"
            className={approvalAlert
              ? "rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground outline-none"
              : "rounded-lg border bg-muted/30 p-3 text-sm text-foreground"}
          >
            {approvalCopy[approvalStatus]}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ApprovalReadinessSection({
  view,
  acceptDurableRun = () => false,
}: {
  readonly view: PlanningView;
  readonly acceptDurableRun?: (run: PublicRunProjection) => boolean;
}) {
  const target: ApprovalReadinessTarget = {
    id: view.run.id,
    revision: view.run.revision,
    manifestHash: view.run.manifestHash,
    planHash: view.run.planHash,
    environment: view.run.environment,
    chainId: view.run.chainId,
    requiredSigner: view.run.requiredSigner,
    phase: view.run.phase,
    status: view.run.status,
    approved: view.run.approved,
    terminalOutcome: view.run.terminalOutcome,
  };

  if (view.run.executablePlan === false) return <p role="status">This historical plan includes unavailable operations and cannot be approved or executed. Create a new tokenization mandate.</p>;
  if (target.approved) {
    return (
      <Card className="border-emerald-500/30 bg-card/90 shadow-2xs">
        <CardHeader className="pb-3 pt-5 px-5">
          <Badge variant="success" className="w-fit text-[10px] uppercase font-mono">Approval recorded</Badge>
          <CardTitle className="text-lg font-bold tracking-tight">Plan approval recorded</CardTitle>
          <CardDescription className="text-xs text-muted-foreground/80">
            Durable server state confirms this mandate approval. You can now execute the mandate.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5"><AuthorityFacts view={view} /></CardContent>
      </Card>
    );
  }

  if (!approvalEligible(target)) {
    return (
      <Card className="border-border/70 bg-card/90 shadow-2xs">
        <CardHeader className="pb-3 pt-5 px-5">
          <Badge variant="secondary" className="w-fit text-[10px] uppercase font-mono">Approval unavailable</Badge>
          <CardTitle className="text-lg font-bold tracking-tight">Mandate Approval</CardTitle>
          <CardDescription className="text-xs text-muted-foreground/80">
            This run is not currently eligible for plan approval. No wallet action is available.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5"><AuthorityFacts view={view} /></CardContent>
      </Card>
    );
  }

  return <ActiveReadiness view={view} target={target} acceptDurableRun={acceptDurableRun} />;
}
