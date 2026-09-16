"use client";

import { useEffect, type Dispatch, type SetStateAction } from "react";
import { useGlobalWallet } from "@/client/wallet/global-wallet-context";
import type { PlanningIssue } from "./run-planning";
import { fields, issueMessage, type Draft, type FieldName } from "./planning-presentation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  FileText,
  Tag,
  Coins,
  Link2,
  KeyRound,
  ArrowRight,
  AlertCircle,
  Loader2,
} from "lucide-react";

const sections = [
  {
    id: "asset",
    number: "01",
    title: "Asset Intent",
    description: "Define the asset and token parameters Edict will execute.",
  },
  {
    id: "authority",
    number: "02",
    title: "Signing Authority",
    description: "Choose the address authorized to execute this mandate.",
  },
] as const;

function fieldIcon(name: FieldName) {
  switch (name) {
    case "assetName":
      return <FileText className="h-4 w-4" />;
    case "symbol":
      return <Tag className="h-4 w-4" />;
    case "supplyCap":
    case "mintAmount":
      return <Coins className="h-4 w-4" />;
    case "documentationUrl":
      return <Link2 className="h-4 w-4" />;
    case "tokenizerWallet":
    case "investorWallet":
      return <KeyRound className="h-4 w-4" />;
    case "investorEmail":
      return <FileText className="h-4 w-4" />;
  }
}

export function MandateForm({
  draft,
  setDraft,
  errors,
  onBlur,
  pending,
  unavailable,
  onSubmit,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  errors: readonly PlanningIssue[];
  onBlur: (name: FieldName) => void;
  pending: boolean;
  unavailable: boolean;
  onSubmit: () => void;
}) {
  const wallet = useGlobalWallet();

  useEffect(() => {
    if (wallet.isConnected && wallet.address && !draft.tokenizerWallet) {
      setDraft((prev) => (prev.tokenizerWallet ? prev : { ...prev, tokenizerWallet: wallet.address ?? "" }));
    }
  }, [wallet.isConnected, wallet.address, draft.tokenizerWallet, setDraft]);

  const hasAnyAllocation = draft.investorEmail.trim() !== "" || draft.investorWallet.trim() !== "" || draft.mintAmount.trim() !== "";

  return (
    <form
      id="mandate-form"
      noValidate
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      aria-busy={pending}
      className="space-y-6"
    >
      <div className="flex items-center justify-between px-0.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-foreground">
            MANDATE SPECIFICATION
          </span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-xs text-muted-foreground">Asset and allocation parameters</span>
        </div>
        <span className="text-[11px] text-muted-foreground font-mono">5 required</span>
      </div>

      {sections.map((section) => (
        <Card key={section.id} id={`section-${section.id}`} className="border-border/70 bg-card/90 shadow-2xs">
          <CardHeader className="pb-3 pt-5 px-5">
            <div className="flex items-center gap-2.5">
              <Badge variant="secondary" className="font-mono text-[11px] font-semibold px-2 py-0.5 border-border/60">
                {section.number}
              </Badge>
              <CardTitle className="text-sm font-semibold tracking-tight">{section.title}</CardTitle>
            </div>
            <CardDescription className="text-xs text-muted-foreground/80 pt-0.5">{section.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-1 px-5 pb-5">
            <fieldset disabled={pending} className="border-0 p-0 m-0 space-y-4">
              <legend className="sr-only">{section.title}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {fields
                  .filter((field) => field.section === section.id)
                  .map((field) => {
                    const issue = errors.find((e) => e.path === field.path);
                    const hint = "hint" in field ? field.hint : undefined;
                    const isWide = "wide" in field && field.wide;

                    return (
                      <div
                        key={field.name}
                        className={`space-y-1.5 ${isWide ? "md:col-span-2" : ""}`}
                      >
                        <div className="flex items-center justify-between">
                          <Label htmlFor={field.name} className="text-xs font-medium">
                            {field.label}
                          </Label>
                          {"numeric" in field && (
                            <span className="text-[10px] text-muted-foreground font-mono uppercase">
                              Whole tokens
                            </span>
                          )}
                        </div>

                        <Input
                          id={field.name}
                          name={`mandate_${field.name}`}
                          type={field.type}
                          autoComplete="one-time-code"
                          autoCorrect="off"
                          data-1p-ignore="true"
                          data-lpignore="true"
                          data-form-type="other"
                          required
                          value={draft[field.name]}
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, [field.name]: e.target.value }))
                          }
                          onBlur={() => onBlur(field.name)}
                          placeholder={field.placeholder}
                          inputMode={"numeric" in field ? "numeric" : undefined}
                          className={cn(
                            "mono" in field && "font-mono text-xs",
                            issue && "border-destructive focus-visible:ring-destructive/30"
                          )}
                          prefixNode={fieldIcon(field.name)}
                          autoCapitalize={field.name === "assetName" ? "sentences" : "none"}
                          spellCheck={field.name === "assetName"}
                          aria-invalid={issue ? true : undefined}
                          aria-describedby={
                            [
                              hint ? `${field.name}-hint` : "",
                              issue ? `${field.name}-error` : "",
                            ]
                              .filter(Boolean)
                              .join(" ") || undefined
                          }
                        />

                        {hint && !issue && (
                          <p id={`${field.name}-hint`} className="text-[11px] text-muted-foreground leading-normal pl-1">
                            {hint}
                          </p>
                        )}
                        {issue && (
                          <div
                            id={`${field.name}-error`}
                            className="flex items-center gap-1.5 text-xs text-destructive font-medium pl-1"
                          >
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span>{issueMessage(issue)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </fieldset>
          </CardContent>
        </Card>
      ))}

      <Card id="section-allocation" className="border-border/70 bg-card/90 shadow-2xs">
        <CardHeader className="pb-3 pt-5 px-5">
          <div className="flex items-center gap-2.5">
            <Badge variant={hasAnyAllocation ? "default" : "secondary"} className="font-mono text-[11px] font-semibold px-2 py-0.5 border-border/60">
              03
            </Badge>
            <CardTitle className="text-sm font-semibold tracking-tight">
              Initial Allocation · {hasAnyAllocation ? (
                <span className="text-amber-600 dark:text-amber-400 font-medium text-xs">
                  All 3 fields required
                </span>
              ) : (
                <span className="text-muted-foreground font-normal text-xs">
                  Optional
                </span>
              )}
            </CardTitle>
          </div>
          <CardDescription className="text-xs text-muted-foreground/80 pt-0.5">
            Authorize an investor and issue an initial allocation after token creation. Leave empty to create the asset only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-1 px-5 pb-5">
          <fieldset disabled={pending} className="border-0 p-0 m-0 space-y-4">
            <legend className="sr-only">Initial Allocation · Optional</legend>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {fields
                .filter((field) => field.section === "allocation")
                .map((field) => {
                  const issue = errors.find((e) => e.path === field.path);
                  const hint = "hint" in field ? field.hint : undefined;
                  const isWide = "wide" in field && field.wide;

                  return (
                    <div
                      key={field.name}
                      className={`space-y-1.5 ${isWide ? "md:col-span-2" : ""}`}
                    >
                      <div className="flex items-center justify-between">
                        <Label htmlFor={field.name} className="text-xs font-medium">
                          {field.label}
                          {hasAnyAllocation && (
                            <span className="text-destructive font-normal text-[11px] ml-1">*</span>
                          )}
                        </Label>
                        {"numeric" in field && (
                          <span className="text-[10px] text-muted-foreground font-mono uppercase">
                            Whole tokens
                          </span>
                        )}
                      </div>

                      <Input
                        id={field.name}
                        name={`mandate_${field.name}`}
                        type={field.type}
                        autoComplete="one-time-code"
                        autoCorrect="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        data-form-type="other"
                        required={hasAnyAllocation}
                        value={draft[field.name]}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, [field.name]: e.target.value }))
                        }
                        onBlur={() => onBlur(field.name)}
                        placeholder={field.placeholder}
                        inputMode={"numeric" in field ? "numeric" : undefined}
                        className={cn(
                          "mono" in field && "font-mono text-xs",
                          issue && "border-destructive focus-visible:ring-destructive/30"
                        )}
                        prefixNode={fieldIcon(field.name)}
                        autoCapitalize="none"
                        spellCheck={false}
                        aria-invalid={issue ? true : undefined}
                        aria-describedby={
                          [
                            hint ? `${field.name}-hint` : "",
                            issue ? `${field.name}-error` : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                      />

                      {hint && !issue && (
                        <p id={`${field.name}-hint`} className="text-[11px] text-muted-foreground leading-normal pl-1">
                          {hint}
                        </p>
                      )}
                      {issue && (
                        <div
                          id={`${field.name}-error`}
                          className="flex items-center gap-1.5 text-xs text-destructive font-medium pl-1"
                        >
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          <span>{issueMessage(issue)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card className="bg-card/70 border-border/80 shadow-2xs">
        <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">Ready to generate your plan</p>
            <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
              Edict will validate this mandate and build the execution steps for your review. No transaction will be submitted.
            </p>
          </div>
          <Button
            type="submit"
            disabled={pending || unavailable}
            className="sm:self-center shrink-0 font-medium text-xs h-9 px-4.5 gap-2 shadow-xs"
          >
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Generating plan…</span>
              </>
            ) : (
              <>
                <span>Review execution plan</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
