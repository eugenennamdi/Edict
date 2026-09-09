"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicRunProjection } from "@/shared/run";
import type { PlanningView } from "../run-planning";
import {
  createBrowserApprovalReadinessController,
  initialApprovalReadinessState,
  type ApprovalReadinessState,
  type ApprovalReadinessTarget,
} from "./approval-controller";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";

function approvalEligible(target: ApprovalReadinessTarget): boolean {
  return !target.approved &&
    target.terminalOutcome === null &&
    target.phase === "PLAN" &&
    target.status === "AWAITING_APPROVAL";
}

function AuthorityFacts({ view }: { readonly view: PlanningView }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 text-xs">
      <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
        <span className="text-muted-foreground font-medium">Approval target</span>
        <p className="font-semibold text-foreground">{view.manifest.asset.name} · {view.manifest.asset.symbol}</p>
        <p className="font-mono text-[11px] text-muted-foreground">Revision {view.run.revision}</p>
      </div>
      <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
        <span className="text-muted-foreground font-medium">Required network</span>
        <p className="font-semibold text-foreground">Ethereum Sepolia</p>
        <p className="font-mono text-[11px] text-muted-foreground">Sandbox · {view.run.chainId}</p>
      </div>
      <div className="rounded-lg border bg-muted/30 p-3 space-y-1 min-w-0">
        <span className="text-muted-foreground font-medium">Required tokenizer signer</span>
        <code className="block break-all text-[11px] text-foreground">{view.run.requiredSigner.walletAddress}</code>
      </div>
      <div className="rounded-lg border bg-muted/30 p-3 space-y-1 min-w-0">
        <span className="text-muted-foreground font-medium">Investor allocation</span>
        <code className="block break-all text-[11px] text-foreground">{view.manifest.investor.walletAddress}</code>
        <p className="font-mono text-[11px] text-muted-foreground">{view.manifest.investor.mintAmount} tokens</p>
      </div>
      <div className="rounded-lg border bg-muted/30 p-3 space-y-1 sm:col-span-2 min-w-0">
        <span className="text-muted-foreground font-medium">Immutable plan hash</span>
        <code className="block break-all text-[11px] text-foreground">{view.run.planHash}</code>
      </div>
    </div>
  );
}

const statusCopy: Readonly<Record<ApprovalReadinessState["status"], string>> = Object.freeze({
  SEARCHING: "Searching for injected wallets…",
  NO_PROVIDER_DISCOVERED: "No injected wallet has been discovered.",
  PROVIDER_AVAILABLE: "Choose an available wallet, then select it explicitly.",
  PROVIDER_COLLISION: "A wallet identity collision was detected. Colliding entries cannot be selected.",
  PROVIDER_SELECTED_UNCHECKED: "Wallet selected. Readiness has not been confirmed.",
  CHECKING: "Checking authorized accounts and network…",
  ACCOUNT_ACCESS_REQUIRED: "This wallet has not granted account access to Edict.",
  ACCOUNT_ACCESS_REJECTED: "Account access was not granted. No retry will occur automatically.",
  REQUIRED_SIGNER_MISSING: "Required signer not available in this wallet.",
  WRONG_NETWORK: "The required signer is available, but the wallet is not on Ethereum Sepolia.",
  SWITCH_PENDING: "Waiting for the explicit Ethereum Sepolia switch to finish…",
  SWITCH_REJECTED: "The Ethereum Sepolia switch was rejected.",
  SWITCH_UNSUPPORTED: "This wallet cannot switch networks automatically. Switch manually, then check again.",
  READINESS_INVALIDATED: "Wallet state changed. Check the wallet again before approval.",
  WALLET_DISCONNECTED: "The selected wallet is unavailable or disconnected.",
  READY: "Wallet ready for plan approval.",
  APPROVAL_RECORDED: "Plan approval recorded.",
  APPROVAL_NOT_ELIGIBLE: "This run is not currently eligible for plan approval.",
});

const alertStatuses = new Set<ApprovalReadinessState["status"]>([
  "PROVIDER_COLLISION",
  "ACCOUNT_ACCESS_REJECTED",
  "REQUIRED_SIGNER_MISSING",
  "SWITCH_REJECTED",
  "SWITCH_UNSUPPORTED",
  "WALLET_DISCONNECTED",
]);

const approvalCopy: Readonly<Record<ApprovalReadinessState["approvalStatus"], string>> = Object.freeze({
  IDLE: "",
  IN_PROGRESS: "Approval request in progress. Check your wallet if prompted.",
  SIGNATURE_REJECTED: "Plan approval was not recorded. The wallet signature was rejected.",
  SIGNING_UNSUPPORTED: "This wallet does not support the required plan-approval signature. Select another provider.",
  NOT_RECORDED: "Plan approval was not recorded. You may review the plan and try again explicitly.",
  STALE_OR_CHANGED: "The run changed. Review its durable state and wallet readiness before trying again.",
  ACCESS_UNAVAILABLE: "Run access is unavailable. Refresh approval status before any further approval action.",
  UNCONFIRMED: "Approval status could not be confirmed. Do not sign again until durable status is refreshed.",
  REQUEST_FAILED: "Plan approval was not recorded. Review the current state before trying again.",
  RECORDED: "Plan approval recorded.",
});

function ActiveReadiness({ view, target, acceptDurableRun }: {
  readonly view: PlanningView;
  readonly target: ApprovalReadinessTarget;
  readonly acceptDurableRun: (run: PublicRunProjection) => boolean;
}) {
  const initialTarget = useRef(target);
  const initialAcceptDurableRun = useRef(acceptDurableRun);
  const controller = useRef<ReturnType<typeof createBrowserApprovalReadinessController> | null>(null);
  const approveButton = useRef<HTMLButtonElement>(null);
  const approvalMessage = useRef<HTMLDivElement>(null);
  const [state, setState] = useState(() => initialApprovalReadinessState(target));

  useEffect(() => {
    const current = createBrowserApprovalReadinessController({
      target: initialTarget.current,
      publish: setState,
      acceptDurableRun: initialAcceptDurableRun.current,
    });
    controller.current = current;
    current.start();
    return () => {
      controller.current = null;
      current.dispose();
    };
  }, []);

  useEffect(() => {
    controller.current?.updateTarget(target);
  }, [target]);

  const selected = state.selectedProviderId !== null;
  const chosen = state.candidateSelectionId !== null;
  const pending = state.pending !== null;
  const alert = alertStatuses.has(state.status);
  const approvalNeedsRefresh = ["ACCESS_UNAVAILABLE", "UNCONFIRMED"].includes(state.approvalStatus);
  const canApprove = state.status === "READY" && [
    "IDLE",
    "SIGNATURE_REJECTED",
    "NOT_RECORDED",
    "REQUEST_FAILED",
  ].includes(state.approvalStatus);
  const approvalPending = state.approvalStatus === "IN_PROGRESS";
  const approvalAlert = [
    "SIGNATURE_REJECTED",
    "SIGNING_UNSUPPORTED",
    "NOT_RECORDED",
    "STALE_OR_CHANGED",
    "ACCESS_UNAVAILABLE",
    "UNCONFIRMED",
    "REQUEST_FAILED",
  ].includes(state.approvalStatus);

  async function approve(): Promise<void> {
    const current = controller.current;
    if (!current) return;
    await current.approvePlan();
    if (controller.current !== current) return;
    const settled = current.getState().approvalStatus;
    requestAnimationFrame(() => {
      if (["SIGNATURE_REJECTED", "NOT_RECORDED", "REQUEST_FAILED"].includes(settled)) {
        approveButton.current?.focus();
      } else if (settled === "SIGNING_UNSUPPORTED") {
        approvalMessage.current?.focus();
      }
    });
  }

  return (
    <Card className="shadow-xs border-border/80">
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Badge variant="outline" className="w-fit font-mono text-[10px] uppercase tracking-wider">
            Approval authority
          </Badge>
          <Badge variant={state.status === "READY" ? "success" : "secondary"} className="w-fit text-[10px] uppercase">
            {state.status === "READY" ? "Ready to approve" : "Readiness required"}
          </Badge>
        </div>
        <CardTitle className="text-xl font-bold tracking-tight">Plan approval readiness</CardTitle>
        <CardDescription className="text-xs leading-relaxed max-w-2xl">
          Verify the exact tokenizer signer and Ethereum Sepolia before plan approval becomes available.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <AuthorityFacts view={view} />

        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          <strong className="font-semibold">No transaction is submitted here.</strong>{" "}
          Approving this plan does not submit an on-chain transaction. Tokenization, whitelist, and mint will each require separate wallet confirmations later.
        </div>

        <Separator />

        {!approvalNeedsRefresh && <fieldset className="space-y-3" disabled={approvalPending}>
          <legend className="text-sm font-semibold text-foreground">Available injected wallets</legend>
          {state.providers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No announced EIP-6963 providers are currently listed.</p>
          ) : (
            <div className="space-y-2">
              {state.providers.map((provider) => {
                const collided = provider.status === "COLLISION";
                return (
                  <label
                    key={provider.selectionId}
                    className="flex items-start gap-3 rounded-lg border p-3 text-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2"
                  >
                    <input
                      type="radio"
                      name="approval-wallet-provider"
                      value={provider.selectionId}
                      checked={state.candidateSelectionId === provider.selectionId}
                      disabled={collided || pending}
                      onChange={() => controller.current?.chooseProvider(provider.selectionId)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-foreground">{provider.displayName}</span>
                      <span className="block break-all text-[11px] text-muted-foreground">
                        Self-reported provider · {provider.rdns ?? "RDNS unavailable"}
                      </span>
                    </span>
                    {collided && <Badge variant="destructive" className="text-[10px]">Collision</Badge>}
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>}

        {!approvalNeedsRefresh && <div className="flex flex-wrap gap-2">
          {chosen && (!selected || state.candidateSelectionId !== state.selectedProviderId) && (
            <Button type="button" size="sm" disabled={pending} onClick={() => void controller.current?.selectWallet()}>
              Select wallet
            </Button>
          )}
          {(!selected || state.approvalStatus === "SIGNING_UNSUPPORTED") && (
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void controller.current?.selectLegacyProvider()}>
              Use legacy injected provider
            </Button>
          )}
          {(state.status === "ACCOUNT_ACCESS_REQUIRED" || state.status === "ACCOUNT_ACCESS_REJECTED") && (
            <Button type="button" size="sm" disabled={pending} onClick={() => void controller.current?.allowAccountAccess()}>
              Allow account access
            </Button>
          )}
          {(state.status === "WRONG_NETWORK" || state.status === "SWITCH_REJECTED") && (
            <Button type="button" size="sm" disabled={pending} onClick={() => void controller.current?.switchToSepolia()}>
              Switch to Ethereum Sepolia
            </Button>
          )}
          {selected && [
            "REQUIRED_SIGNER_MISSING",
            "SWITCH_UNSUPPORTED",
            "READINESS_INVALIDATED",
            "WALLET_DISCONNECTED",
          ].includes(state.status) && (
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void controller.current?.checkWallet()}>
              Check wallet again
            </Button>
          )}
        </div>}

        <div
          role={alert ? "alert" : "status"}
          aria-live="polite"
          className={state.status === "READY"
            ? "rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300"
            : alert
              ? "rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground"
              : "rounded-lg border bg-muted/30 p-3 text-sm text-foreground"}
        >
          <span className="flex items-start gap-2">
            {state.status === "READY"
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              : alert
                ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
            <span>{statusCopy[state.status]}</span>
          </span>
          {state.status === "REQUIRED_SIGNER_MISSING" && (
            <span className="mt-2 block text-[11px]">
              Select or switch to the required account in your wallet, then choose Check wallet again.
              <code className="mt-1 block break-all">Required: {view.run.requiredSigner.walletAddress}</code>
            </span>
          )}
        </div>

        {(canApprove || approvalPending) && (
          <Button
            ref={approveButton}
            type="button"
            size="sm"
            disabled={approvalPending || pending}
            aria-busy={approvalPending}
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
            disabled={pending}
            onClick={() => void controller.current?.refreshApprovalStatus()}
          >
            Refresh approval status
          </Button>
        )}

        {state.approvalStatus !== "IDLE" && (
          <div
            ref={approvalMessage}
            tabIndex={state.approvalStatus === "SIGNING_UNSUPPORTED" ? -1 : undefined}
            role={approvalAlert ? "alert" : "status"}
            aria-live="polite"
            className={approvalAlert
              ? "rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground outline-none"
              : "rounded-lg border bg-muted/30 p-3 text-sm text-foreground"}
          >
            {approvalCopy[state.approvalStatus]}
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

  if (target.approved) {
    return (
      <Card className="shadow-xs border-emerald-500/30">
        <CardHeader>
          <Badge variant="success" className="w-fit text-[10px] uppercase">Approval recorded</Badge>
          <CardTitle className="text-xl font-bold tracking-tight">Plan approval recorded</CardTitle>
          <CardDescription className="text-xs">
            Durable server state confirms this plan approval. Execution is not enabled in this phase.
          </CardDescription>
        </CardHeader>
        <CardContent><AuthorityFacts view={view} /></CardContent>
      </Card>
    );
  }

  if (!approvalEligible(target)) {
    return (
      <Card className="shadow-xs border-border/80">
        <CardHeader>
          <Badge variant="secondary" className="w-fit text-[10px] uppercase">Approval unavailable</Badge>
          <CardTitle className="text-xl font-bold tracking-tight">Plan approval readiness</CardTitle>
          <CardDescription className="text-xs">
            This run is not currently eligible for plan approval. No wallet action is available.
          </CardDescription>
        </CardHeader>
        <CardContent><AuthorityFacts view={view} /></CardContent>
      </Card>
    );
  }

  return <ActiveReadiness view={view} target={target} acceptDurableRun={acceptDurableRun} />;
}
