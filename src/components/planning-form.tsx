"use client";

import type { Dispatch, SetStateAction } from "react";
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
  Mail,
  KeyRound,
  Wallet,
  ArrowRight,
  AlertCircle,
  Loader2,
} from "lucide-react";

const sections = [
  {
    id: "asset",
    number: "01",
    title: "Asset Intent",
    description: "Define the underlying real-world asset and token economics.",
  },
  {
    id: "authority",
    number: "02",
    title: "Signing Authority",
    description: "Identify the tokenizer and the cryptographic signing address for this run.",
  },
  {
    id: "allocation",
    number: "03",
    title: "Investor Allocation",
    description: "Specify the initial whitelisted investor and planned mint allocation.",
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
    case "tokenizerEmail":
    case "investorEmail":
      return <Mail className="h-4 w-4" />;
    case "tokenizerWallet":
      return <KeyRound className="h-4 w-4" />;
    case "investorWallet":
      return <Wallet className="h-4 w-4" />;
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
      <div className="flex items-center justify-between px-1 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-foreground">
            MANDATE
          </span>
          <span className="text-muted-foreground/60">-</span>
          <span className="text-muted-foreground font-medium">Specification Stage</span>
        </div>
        <span className="text-xs text-muted-foreground font-mono">All 9 fields required</span>
      </div>

      {sections.map((section) => (
        <Card key={section.id} id={`section-${section.id}`} className="shadow-xs">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2.5">
              <Badge variant="secondary" className="font-mono text-xs font-semibold px-2 py-0.5">
                {section.number}
              </Badge>
              <CardTitle className="text-base font-semibold">{section.title}</CardTitle>
            </div>
            <CardDescription className="text-xs pt-1">{section.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
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

      <Card className="bg-muted/40 border-dashed">
        <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold">Ready to record mandate</p>
            <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
              Generating a plan verifies parameters against runtime schemas and computes an immutable 7-operation execution graph. No wallet signature is triggered during planning.
            </p>
          </div>
          <Button
            type="submit"
            disabled={pending || unavailable}
            className="sm:self-center shrink-0 font-medium text-xs h-10 px-5 gap-2 shadow-sm"
          >
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Computing plan…</span>
              </>
            ) : (
              <>
                <span>Create execution plan</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
