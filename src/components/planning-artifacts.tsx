"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PlanningView } from "./run-planning";
import { displayUtc, recordStatus, operationLabels, type Draft } from "./planning-presentation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Check,
  Copy,
  FileCode,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

export function CopyValue({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground font-medium text-[11px]">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground font-mono transition-colors focus-visible:outline-none cursor-pointer"
          aria-label={`Copy ${label}`}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3 opacity-70" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 hover:bg-secondary/60 px-2.5 py-1.5 border border-border/70 transition-colors">
        <code className="font-mono text-xs text-foreground truncate select-all">{value}</code>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between py-1.5 text-xs gap-4 border-b border-border/40 last:border-0">
      <span className="text-muted-foreground font-medium shrink-0">{label}</span>
      <span
        className={`text-right truncate ${
          mono ? "font-mono text-foreground font-medium" : "text-foreground"
        }`}
      >
        {children || <span className="text-muted-foreground/60 italic font-normal">Not entered</span>}
      </span>
    </div>
  );
}

export function DraftSummary({
  draft,
  ready,
  filled,
}: {
  draft: Draft;
  ready: boolean;
  filled: number;
}) {
  const mandateFilled = Math.min(
    5,
    Math.max(
      0,
      typeof filled === "number"
        ? Math.min(5, filled)
        : [
            draft.assetName,
            draft.symbol,
            draft.supplyCap,
            draft.documentationUrl,
            draft.tokenizerWallet,
          ].filter((val) => val.trim().length > 0).length
    )
  );

  return (
    <div className="space-y-5 lg:pt-8">
      <Card className="border-border/70 bg-card/90 shadow-2xs">
        <CardHeader className="pb-3 pt-5 px-5">
          <div className="flex items-center justify-end">
            <Badge variant={ready ? "success" : "secondary"} className="text-[11px]">
              {ready ? "Ready to record" : `${mandateFilled}/5 fields`}
            </Badge>
          </div>
          <CardTitle className="text-base font-semibold pt-1 tracking-tight">Mandate Preview</CardTitle>
          <CardDescription className="text-xs text-muted-foreground/80">
            Preview the mandate Edict will turn into an execution plan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-1 px-5 pb-5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="text-[11px]">Mandate completeness</span>
              <span className="font-mono text-[11px] font-medium text-foreground">{Math.round((mandateFilled / 5) * 100)}%</span>
            </div>
            <Progress value={mandateFilled} max={5} indicatorClassName={ready ? "bg-emerald-600 dark:bg-emerald-500" : "bg-primary"} />
          </div>

          <Separator className="bg-border/60" />

          <div className="space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block pb-1">
              01 · Asset parameters
            </span>
            <Row label="Asset name">{draft.assetName}</Row>
            <Row label="Symbol" mono>{draft.symbol}</Row>
            <Row label="Supply cap" mono>{draft.supplyCap ? `${draft.supplyCap} tokens` : ""}</Row>
            <Row label="Documentation">{draft.documentationUrl}</Row>
          </div>

          <Separator className="bg-border/60" />

          <div className="space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block pb-1">
              02 · Signing Authority
            </span>
            <Row label="Signer" mono>{draft.tokenizerWallet ? `${draft.tokenizerWallet.slice(0, 8)}…${draft.tokenizerWallet.slice(-6)}` : ""}</Row>
          </div>

          <Separator className="bg-border/60" />

          <div className="space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block pb-1">
              03 · Allocation
            </span>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Optional after token creation. Excluded from this mandate.
            </p>
          </div>

          <div className="rounded-md bg-secondary/50 p-2 border border-border/60 flex items-center justify-between text-xs text-muted-foreground font-mono">
            <span>RWA_TOKEN</span>
            <span>Sepolia · 11155111</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function RecordedManifest({ view }: { view: PlanningView }) {
  const { manifest: m, run } = view;
  const [jsonOpen, setJsonOpen] = useState(false);

  return (
    <div className="space-y-5">
      <Card className="border-border/70 bg-card/90 shadow-2xs">
        <CardHeader className="pb-3 pt-5 px-5">
          <CardTitle className="text-base font-semibold tracking-tight">Normalized Manifest</CardTitle>
          <CardDescription className="text-xs text-muted-foreground/80">
            Server-recorded, canonical representation of your tokenization mandate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-1 px-5 pb-5">
          <div className="space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block pb-1">
              01 · Asset
            </span>
            <Row label="Asset name">{m.asset.name}</Row>
            <Row label="Symbol" mono>{m.asset.symbol}</Row>
            <Row label="Supply cap" mono>{m.asset.supplyCap} tokens</Row>
            <Row label="Documentation">{m.asset.documentationUrl}</Row>
          </div>

          <Separator className="bg-border/60" />

          <div className="space-y-2">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
              02 · Signing Authority
            </span>
            {m.tokenizer.email && <Row label="Tokenizer email">{m.tokenizer.email}</Row>}
            <CopyValue label="Required signer" value={run.requiredSigner.walletAddress} compact />
          </div>

          {m.investor && (
            <>
              <Separator className="bg-border/60" />
              <div className="space-y-2">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
                  03 · Future allocation
                </span>
                <Row label="Investor email">{m.investor.email}</Row>
                <CopyValue label="Recipient address" value={m.investor.walletAddress} compact />
                <Row label="Mint amount" mono>{m.investor.mintAmount} tokens</Row>
              </div>
            </>
          )}

          <div className="rounded-md bg-secondary/50 p-2 border border-border/60 flex items-center justify-between text-xs text-muted-foreground font-mono">
            <span>{m.asset.tokenType}</span>
            <span>Sepolia · {m.chainId}</span>
          </div>

          <CopyValue label="Manifest hash" value={run.manifestHash} />

          <div className="border border-border/70 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setJsonOpen(!jsonOpen)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium bg-secondary/40 hover:bg-secondary/70 transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-1.5 font-mono text-muted-foreground hover:text-foreground">
                <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                Inspect normalized JSON
              </span>
              {jsonOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
            {jsonOpen && (
              <pre className="p-3 text-[11px] font-mono bg-secondary/30 overflow-x-auto text-foreground border-t border-border/60 max-h-60">
                <code>{JSON.stringify(m, null, 2)}</code>
              </pre>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function PlanDocument({ view }: { view: PlanningView }) {
  const outcomes = view.plan.operations.map((operation) => ({
    title: operation.kind === "TOKENIZE" ? "Create tokenized asset" :
      operation.kind === "CONFIRM_TOKENIZATION" ? "Verify tokenization" : operationLabels[operation.kind],
    summary: operation.summary,
  }));
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Badge variant="brand" className="font-mono text-[10px] font-semibold tracking-wide">
          MANDATE PLAN
        </Badge>
        <span className="text-xs text-muted-foreground font-mono">
          {outcomes.length} outcomes
        </span>
      </div>

      <Card className="border-border/70 bg-card/90 shadow-2xs">
        <CardHeader className="pb-4 pt-5 px-5">
          <CardTitle className="text-lg font-bold tracking-tight">
            What Edict will accomplish
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground/80 leading-relaxed max-w-xl">
            A deterministic, approved outcome plan. Edict handles preparation, durable transitions, and verification internally.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-0 px-5 pb-5">
          <div className="rounded-lg bg-secondary/40 p-3.5 border border-border/70 space-y-2">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
              Required signer authority
            </span>
            <CopyValue label="Tokenizer public key" value={view.run.requiredSigner.walletAddress} compact />
          </div>

          <div className="relative pl-6 space-y-5 before:absolute before:left-2.5 before:top-3 before:bottom-3 before:w-[2px] before:bg-border/60">
            {outcomes.map((outcome, index) => {
              const isFinal = index === outcomes.length - 1;
              return (
                <div key={outcome.title} className="relative group">
                  <div
                    className={`absolute -left-6 top-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-[10px] font-mono font-bold transition-all shadow-2xs ${
                      isFinal
                        ? "border-emerald-500 text-emerald-600 dark:text-emerald-400 ring-2 ring-emerald-500/20"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </div>

                  <div className="p-3.5 rounded-lg border border-border/60 bg-secondary/30 hover:bg-secondary/50 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 pb-1">
                      <h3 className="text-xs font-semibold text-foreground flex items-center gap-2">
                        {outcome.title}
                      </h3>
                      <Badge
                        variant={isFinal ? "success" : "secondary"}
                        className="text-[10px] shrink-0 font-medium tracking-wide w-fit"
                      >
                        {isFinal ? "Verified result" : "Mandate outcome"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{outcome.summary}</p>
                  </div>
                </div>
              );
            })}
          </div>

          <Separator className="bg-border/60" />

          <div className="space-y-2">
            <CopyValue label="Plan hash" value={view.run.planHash} />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Manifest and execution plan are cryptographically immutable. Revisions track status changes without altering hashes.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function RecordDetails({
  view,
  retrievedAt,
}: {
  view: PlanningView;
  retrievedAt: string | null;
}) {
  const { run } = view;

  return (
    <div className="space-y-6">
      <Card className="border-border/70 bg-card/90 shadow-2xs">
        <CardHeader className="pb-4 pt-5 px-5">
          <CardTitle className="text-lg font-bold tracking-tight">Run Identity & State</CardTitle>
          <CardDescription className="text-xs text-muted-foreground/80">
            Persistent identifiers and verification timestamps for this planning run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 pt-0 px-5 pb-5">
          <CopyValue label="Run ID" value={run.id} />
          <CopyValue label="Plan hash" value={run.planHash} />
          <CopyValue label="Manifest hash" value={run.manifestHash} />

          <Separator className="bg-border/60" />

          <div className="space-y-1">
            <Row label="Status">{recordStatus(run)}</Row>
            <Row label="Public status" mono>{run.status}</Row>
            <Row label="Phase" mono>{run.phase}</Row>
            <Row label="Revision" mono>{String(run.revision)}</Row>
            <Row label="Plan approval">{run.approved ? "Recorded" : "Not recorded (Offline in sandbox)"}</Row>
            <Row label="Environment">Sandbox / Ethereum Sepolia ({run.chainId})</Row>
            <Row label="Created"><time dateTime={run.createdAt}>{displayUtc(run.createdAt)}</time></Row>
            <Row label="Updated"><time dateTime={run.updatedAt}>{displayUtc(run.updatedAt)}</time></Row>
            {retrievedAt && <Row label="Retrieved"><time dateTime={retrievedAt}>{displayUtc(retrievedAt)}</time></Row>}
          </div>

          <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-800 dark:text-amber-300">
            <strong className="font-semibold">Run access:</strong>
            <p className="pt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
              This durable record can be reopened at its run URL only while this browser holds the valid run capability. The run ID alone does not grant access.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
