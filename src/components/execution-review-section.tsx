"use client";

import type { PlanningView } from "./run-planning";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, CheckCircle2, FileSearch } from "lucide-react";

function ReviewRow({ label, value }: { readonly label: string; readonly value?: string }) {
  return (
    <div className="grid gap-1 border-b border-border/50 py-2 last:border-0 sm:grid-cols-[11rem_1fr]">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <code className="break-all text-xs text-foreground">{value ?? "Not supplied"}</code>
    </div>
  );
}

export function ExecutionReviewSection({
  view,
  pending,
  preparationUnconfirmed,
  onPrepare,
}: {
  readonly view: PlanningView;
  readonly pending: boolean;
  readonly preparationUnconfirmed: boolean;
  readonly onPrepare: () => void;
}) {
  const execution = view.run.execution;
  if (execution === null) return null;
  const review = execution.transactionReview;
  const ready = execution.preparationStatus === "READY_FOR_PREPARATION" && !preparationUnconfirmed;
  const blocked = preparationUnconfirmed || [
    "PREPARATION_PENDING",
    "PREPARATION_UNCONFIRMED",
  ].includes(execution.preparationStatus);

  return (
    <Card className="shadow-xs border-border/80" aria-busy={pending}>
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Badge variant="outline" className="w-fit font-mono text-[10px] uppercase tracking-wider">
            Next operation
          </Badge>
          <Badge
            variant={review ? "success" : blocked ? "destructive" : "secondary"}
            className="w-fit text-[10px] uppercase"
          >
            {review ? "Prepared for review" : blocked ? "Preparation unresolved" : "Ready for preparation"}
          </Badge>
        </div>
        <CardTitle className="text-xl font-bold tracking-tight">
          01 · {execution.nextOperation.name}
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed max-w-2xl">
          The durable run—not the browser—identified TOKENIZE as the next legal operation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 text-xs sm:grid-cols-2">
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
            <span className="font-medium text-muted-foreground">Approved signer</span>
            <code className="block break-all text-[11px]">{view.run.requiredSigner.walletAddress}</code>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
            <span className="font-medium text-muted-foreground">Network</span>
            <p className="font-semibold">Ethereum Sepolia</p>
            <code className="text-[11px] text-muted-foreground">11155111</code>
          </div>
        </div>

        {ready && (
          <>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
              Preparing makes one server-authorized Brickken sandbox request and durably records its outcome. It does not request wallet confirmation or submit an on-chain transaction.
            </div>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              aria-busy={pending}
              onClick={onPrepare}
              className="min-w-52"
            >
              {pending ? "Preparation request in progress" : "Prepare transaction for review"}
            </Button>
          </>
        )}

        {blocked && (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground">
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span>
                The preparation outcome is not safely known. Refresh the durable record; Edict will not automatically repeat the preparation request.
              </span>
            </span>
          </div>
        )}

        {review && (
          <>
            <div role="status" aria-live="polite" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
              <span className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Transaction prepared. Wallet confirmation has not been requested.</span>
              </span>
            </div>

            <Separator />

            <section aria-labelledby="transaction-review-heading" className="space-y-3">
              <div className="flex items-center gap-2">
                <FileSearch className="h-4 w-4 text-muted-foreground" />
                <h3 id="transaction-review-heading" className="text-sm font-semibold">Transaction review</h3>
              </div>
              <div className="rounded-lg border bg-muted/20 px-3">
                <ReviewRow label="Brickken action" value={review.brickken.method} />
                <ReviewRow label="Execution mode" value={review.brickken.executionMode} />
                <ReviewRow label="Destination" value={review.walletRequest.to} />
                <ReviewRow label="From" value={review.walletRequest.from} />
                <ReviewRow label="Value" value={review.walletRequest.value} />
                <ReviewRow label="Gas limit" value={review.walletRequest.gas} />
                <ReviewRow label="Transaction type" value={review.walletRequest.type} />
                <ReviewRow label="Nonce" value={review.walletRequest.nonce} />
                <ReviewRow label="Max fee per gas" value={review.walletRequest.maxFeePerGas} />
                <ReviewRow label="Priority fee per gas" value={review.walletRequest.maxPriorityFeePerGas} />
                <ReviewRow label="Legacy gas price" value={review.walletRequest.gasPrice} />
                <ReviewRow label="Prepared transaction ID" value={review.preparedTransactionId} />
                <ReviewRow label="Prepared fingerprint" value={review.integrity.preparedTransactionFingerprint} />
              </div>
              <details className="rounded-lg border bg-muted/20 p-3 text-xs">
                <summary className="cursor-pointer font-medium text-foreground">Exact prepared calldata</summary>
                <code className="mt-3 block max-h-64 overflow-auto break-all rounded bg-background p-3 text-[11px]">
                  {review.walletRequest.data}
                </code>
              </details>
              <p className="text-xs text-muted-foreground">
                Calldata is preserved exactly but remains opaque; Edict does not claim ABI-decoded function semantics at this boundary.
              </p>
            </section>

            <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
              This review is not wallet authorization. The browser wallet boundary below requires a separate durable authority release, fresh wallet checks, and an explicit human action. Production authorization remains deny-all.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
