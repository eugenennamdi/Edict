"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPlanningWorkspace, initialWorkspace } from "./run-planning";
import {
  draftForm,
  draftIssues,
  emptyDraft,
  fields,
  issueMessage,
  type FieldName,
} from "./planning-presentation";
import { MandateForm } from "./planning-form";
import { ApprovalReadinessSection } from "./approval/approval-section";
import {
  DraftSummary,
  PlanDocument,
  RecordedManifest,
  RecordDetails,
} from "./planning-artifacts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  RotateCw,
  XCircle,
  AlertTriangle,
  AlertCircle,
  Workflow,
  FileCode,
  FileText,
  ChevronRight,
  ArrowLeft,
} from "lucide-react";

export default function RunPlanningWorkspace({
  initialRunId,
  invalidRunRoute = false,
}: {
  readonly initialRunId?: string;
  readonly invalidRunRoute?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialWorkspace);
  const [workspace] = useState(() => createPlanningWorkspace(
    setState,
    undefined,
    { onCreated: (createdRunId) => router.replace(`/records/${createdRunId}`) },
  ));
  const [draft, setDraft] = useState(emptyDraft);
  const [touched, setTouched] = useState<ReadonlySet<FieldName>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [mode, setMode] = useState<"primary" | "artifact" | "details">("primary");
  const [cancelRevision, setCancelRevision] = useState<number | null>(null);
  const [submittedDraft, setSubmittedDraft] = useState(draft);
  const heading = useRef<HTMLHeadingElement>(null);
  const error = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  const view = state.view;
  const runId = view?.run.id;
  const canceled = view?.run.terminalOutcome === "CANCELLED";
  const durableRoute = initialRunId !== undefined || invalidRunRoute;

  useEffect(() => {
    if (initialRunId !== undefined) void workspace.recover(initialRunId);
  }, [initialRunId, workspace]);

  useEffect(() => {
    if (runId) heading.current?.focus();
  }, [runId, canceled]);

  const issues = draftIssues(draft);
  const serverIssues = submittedDraft === draft ? state.issues : [];
  const visibleIssues = [
    ...issues.filter(
      (issue) =>
        submitted ||
        fields.some((field) => field.path === issue.path && touched.has(field.name))
    ),
    ...serverIssues.filter(
      (issue) => !issues.some((local) => local.path === issue.path)
    ),
  ];
  const validationErrors = !view && submitted && visibleIssues.length > 0;
  const requestError =
    state.error && (state.errorCode !== "BAD_REQUEST" || submittedDraft === draft);
  const showError = validationErrors || requestError || invalidRunRoute;
  const filled = fields.filter((field) => draft[field.name].trim().length > 0).length;
  const cancelOpen = view?.run.canCancel && cancelRevision === view.run.revision;

  async function create() {
    setSubmitted(true);
    setSubmittedDraft(draft);
    setMode("primary");
    await workspace.create(draftForm(draft));
    requestAnimationFrame(() => error.current?.focus());
  }

  function focusField(name: FieldName) {
    setMode("primary");
    requestAnimationFrame(() => {
      const field = document.getElementById(name);
      field?.focus();
    });
  }

  async function refresh() {
    setCancelRevision(null);
    await workspace.refresh();
    requestAnimationFrame(() => error.current?.focus());
  }

  async function cancel() {
    await workspace.cancel();
    setCancelRevision(null);
    requestAnimationFrame(() => {
      if (error.current) error.current.focus();
      else cancelButton.current?.focus();
    });
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans antialiased selection:bg-primary selection:text-primary-foreground">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 z-50 px-4 py-2 bg-primary text-primary-foreground rounded-md shadow-md text-sm font-medium"
        href="#workspace"
      >
        Skip to workspace
      </a>

      {/* Institutional Top Chrome Header */}
      <header className="sticky top-0 z-40 w-full border-b border-border/80 bg-background/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="Edict"
              className="h-6 w-auto object-contain dark:invert"
            />
            <span className="text-xs text-muted-foreground hidden sm:inline border-l border-border/60 pl-3">
              Tokenization, as code.
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-secondary/80 border border-border/70 text-xs">
              <img
                src="/ethereum-logo.svg"
                alt="Ethereum"
                className="h-3.5 w-auto shrink-0"
              />
              <span className="font-medium text-foreground text-[11px] sm:text-xs">Ethereum Sepolia</span>
              <Separator orientation="vertical" className="h-3 bg-border" />
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-medium">
                Sandbox
              </Badge>
            </div>
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main id="workspace" className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full space-y-6">
        {/* Context Breadcrumbs */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
          <span>Workspace</span>
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          <span className="text-foreground">{view || durableRoute ? "Run record" : "New mandate"}</span>
        </div>

        {/* Page Heading & State Hero */}
        <div className="space-y-1.5">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground outline-none"
          >
            {canceled
              ? "Run canceled."
              : view
              ? view.manifest.asset.name
              : durableRoute
              ? invalidRunRoute
                ? "Run unavailable."
                : "Recovering run record."
              : "Define your mandate."}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
            {canceled
              ? "The run is closed. Its mandate and plan remain available for audit and review."
              : view
              ? "A recorded mandate. A deterministic plan. Ready for your review."
              : durableRoute
              ? "Edict is checking this browser's authority before reconstructing the durable record."
              : "Set the intent. Inspect the structure. Make it an immutable record."}
          </p>
        </div>

        {/* Workspace Segmented Navigation (Tabs - when a recorded view exists) */}
        {view && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="inline-flex p-1 rounded-lg bg-secondary/70 border border-border/60 text-xs font-medium">
              <button
                type="button"
                aria-pressed={mode === "primary"}
                aria-controls="primary-panel"
                onClick={() => setMode("primary")}
                className={cn(
                  "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md transition-all",
                  mode === "primary"
                    ? "bg-background text-foreground shadow-sm font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Workflow className="h-3.5 w-3.5" />
                <span>Execution plan</span>
                <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                  7 ops
                </Badge>
              </button>

              <button
                type="button"
                aria-pressed={mode === "artifact"}
                aria-controls="artifact-panel"
                onClick={() => setMode("artifact")}
                className={cn(
                  "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md transition-all",
                  mode === "artifact"
                    ? "bg-background text-foreground shadow-sm font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                  "lg:hidden"
                )}
              >
                <FileCode className="h-3.5 w-3.5" />
                <span>Manifest</span>
              </button>

              <button
                type="button"
                aria-pressed={mode === "details"}
                aria-controls="primary-panel"
                onClick={() => setMode("details")}
                className={cn(
                  "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md transition-all",
                  mode === "details"
                    ? "bg-background text-foreground shadow-sm font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <FileText className="h-3.5 w-3.5" />
                <span>Record details</span>
              </button>
            </div>
          </div>
        )}

        {/* Validation or API Errors Callout */}
        {showError && (
          <div
            ref={error}
            tabIndex={-1}
            role="alert"
            className="p-4 rounded-lg border border-destructive/30 bg-destructive/5 text-destructive-foreground flex gap-3.5 items-start outline-none"
          >
            <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-2 text-sm flex-1">
              <strong className="font-semibold block text-destructive">
                {validationErrors
                  ? "Review the highlighted fields."
                  : invalidRunRoute
                  ? "This run link is invalid or unavailable."
                  : durableRoute && state.errorCode === "FORBIDDEN"
                  ? "This browser cannot access this run. Access may have expired or been replaced."
                  : state.errorCode === "FORBIDDEN" && !view
                  ? "This request is not authorized in this environment."
                  : state.error}
              </strong>
              {validationErrors && (
                <ul className="list-disc list-inside space-y-1 text-xs text-foreground/80">
                  {fields
                    .filter((field) =>
                      visibleIssues.some((issue) => issue.path === field.path)
                    )
                    .map((field) => (
                      <li key={field.name}>
                        <a
                          href={`#${field.name}`}
                          onClick={(event) => {
                            event.preventDefault();
                            focusField(field.name);
                          }}
                          className="font-medium underline underline-offset-2 hover:text-foreground"
                        >
                          {field.label}:{" "}
                          {issueMessage(
                            visibleIssues.find(
                              (issue) => issue.path === field.path
                            )!
                          )}
                        </a>
                      </li>
                    ))}
                </ul>
              )}
              {view && (
                <p className="text-xs text-muted-foreground">
                  The last accepted record remains below. Refresh the record before taking another action.
                </p>
              )}
              {!view && state.errorCode === "NETWORK_ERROR" && (
                <p className="text-xs text-muted-foreground">
                  Plan creation may have completed. No automatic retry will be made.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Status Notice Live Region */}
        <div
          role="status"
          aria-live="polite"
          className={
            state.notice && !state.notice.startsWith("Run created")
              ? "p-3 rounded-lg border border-border bg-secondary/40 text-xs text-foreground"
              : "sr-only"
          }
        >
          {state.notice && !state.notice.startsWith("Run created") ? state.notice : ""}
        </div>

        {/* Recorded Run Action Toolbar */}
        {view && (
          <Card className="border-border/80 bg-card/60 shadow-xs" aria-busy={state.pending !== null}>
            <CardContent className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-xs">
                <span className="relative flex h-2 w-2">
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="font-medium text-foreground">
                  {canceled
                    ? "Closed record"
                    : view.run.approved
                    ? "Plan approval recorded"
                    : "Plan approval not recorded"}
                </span>
                <Separator orientation="vertical" className="h-3 bg-border" />
                <span className="text-muted-foreground">Execution controls offline</span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh()}
                  disabled={!!state.pending || state.unavailable}
                  className="h-8 gap-1.5 text-xs"
                >
                  <RotateCw
                    className={cn(
                      "h-3.5 w-3.5",
                      state.pending === "refresh" && "animate-spin"
                    )}
                  />
                  <span>{state.pending === "refresh" ? "Refreshing…" : "Refresh record"}</span>
                </Button>

                {view.run.canCancel && (
                  <Button
                    ref={cancelButton}
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!!state.pending || state.unavailable}
                    onClick={() => {
                      setCancelRevision(view.run.revision);
                      requestAnimationFrame(() => confirmButton.current?.focus());
                    }}
                    className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    <span>Cancel run</span>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cancel Confirmation Dialog Card */}
        {cancelOpen && (
          <Card className="border-destructive/40 bg-destructive/5 shadow-sm">
            <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex gap-3 items-start">
                <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div className="space-y-1 text-sm">
                  <strong className="font-semibold text-foreground">Cancel this run?</strong>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    This closes the run without executing its plan. Its recorded mandate and plan remain available for review.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Button
                  ref={confirmButton}
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={!!state.pending || state.unavailable}
                  onClick={() => void cancel()}
                  className="h-8 text-xs"
                >
                  {state.pending === "cancel" ? "Canceling…" : "Confirm cancellation"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!!state.pending}
                  onClick={() => {
                    setCancelRevision(null);
                    cancelButton.current?.focus();
                  }}
                  className="h-8 text-xs"
                >
                  Keep run
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Responsive Two-Column Work Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Primary Panel */}
          <div
            id="primary-panel"
            className={cn(
              durableRoute && !view ? "lg:col-span-12" : "lg:col-span-7 xl:col-span-8",
              "space-y-6",
              mode === "artifact" && "hidden lg:block"
            )}
          >
            {view ? (
              mode === "details" ? (
                <RecordDetails view={view} retrievedAt={state.retrievedAt} />
              ) : (
                <div className="space-y-6">
                  <PlanDocument view={view} />
                  <ApprovalReadinessSection
                    view={view}
                    acceptDurableRun={workspace.acceptDurableRun}
                  />
                </div>
              )
            ) : durableRoute ? (
              <Card className="shadow-xs border-border/80" aria-busy={state.pending === "recover"}>
                <CardContent className="p-6 text-sm text-muted-foreground space-y-2">
                  <strong className="text-foreground font-semibold block">
                    {invalidRunRoute
                      ? "The run record cannot be opened."
                      : state.pending === "recover"
                      ? "Recovering the server record…"
                      : state.error
                      ? "The run record was not reconstructed."
                      : "Preparing recovery…"}
                  </strong>
                  <p className="text-xs leading-relaxed max-w-2xl">
                    {invalidRunRoute
                      ? "Check the run URL. A run identifier is only a locator and does not grant access."
                      : state.errorCode === "FORBIDDEN"
                      ? "Only the browser holding the valid run capability can open this record."
                      : state.errorCode === "NOT_FOUND"
                      ? "No authorized durable record is available at this URL."
                      : state.error
                      ? "No partial manifest or plan has been displayed."
                      : "This read does not create, approve, cancel, or execute the run."}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <MandateForm
                draft={draft}
                setDraft={setDraft}
                errors={visibleIssues}
                onBlur={(name) =>
                  setTouched((prev) => new Set([...prev, name]))
                }
                pending={state.pending === "create"}
                unavailable={state.unavailable}
                onSubmit={() => void create()}
              />
            )}
          </div>

          {/* Artifact Panel (Sticky on desktop) */}
          <aside
            id="artifact-panel"
            aria-label={view ? "Recorded manifest" : "Provisional draft summary"}
            className={cn(
              "lg:col-span-5 xl:col-span-4 lg:sticky lg:top-20 space-y-4",
              durableRoute && !view && "hidden",
              mode === "primary" && "hidden lg:block",
              mode === "details" && "hidden lg:block"
            )}
          >
            {view ? (
              <RecordedManifest view={view} />
            ) : (
              <DraftSummary
                draft={draft}
                ready={issues.length === 0}
                filled={filled}
              />
            )}

            {!view && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode("primary")}
                className="w-full lg:hidden gap-1.5 text-xs"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Return to mandate</span>
              </Button>
            )}
          </aside>
        </div>
      </main>

      {/* Institutional Footer */}
      <footer className="border-t border-border/70 bg-background/80 py-6 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2.5">
            <img
              src="/logo.png"
              alt="Edict"
              className="h-4 w-auto object-contain dark:invert opacity-90"
            />
            <Separator orientation="vertical" className="h-3.5 bg-border" />
            <span>Tokenization Planning Workspace</span>
          </div>
          <div className="font-mono text-[11px]">
            {view
              ? "Durable record · Authorized browser access"
              : durableRoute
              ? "Run locator · Capability required"
              : "Intent first. Authority follows."}
          </div>
        </div>
      </footer>
    </div>
  );
}
