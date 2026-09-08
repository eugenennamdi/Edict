"use client";

import { useEffect, useRef, useState } from "react";
import { createPlanningWorkspace, initialWorkspace } from "./run-planning";
import { draftForm, draftIssues, emptyDraft, fields, issueMessage, recordStatus, type FieldName } from "./planning-presentation";
import { MandateForm } from "./planning-form";
import { DraftSummary, PlanDocument, RecordedManifest, RecordDetails } from "./planning-artifacts";

export default function RunPlanningWorkspace() {
  const [state, setState] = useState(initialWorkspace);
  const [workspace] = useState(() => createPlanningWorkspace(setState));
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
  useEffect(() => { if (runId) heading.current?.focus(); }, [runId, canceled]);

  const issues = draftIssues(draft);
  const serverIssues = submittedDraft === draft ? state.issues : [];
  const visibleIssues = [...issues.filter(issue => submitted || fields.some(field => field.path === issue.path && touched.has(field.name))), ...serverIssues.filter(issue => !issues.some(local => local.path === issue.path))];
  const validationErrors = !view && submitted && visibleIssues.length > 0;
  const requestError = state.error && (state.errorCode !== "BAD_REQUEST" || submittedDraft === draft);
  const showError = validationErrors || requestError;
  const filled = fields.filter(field => draft[field.name].trim().length > 0).length;
  const cancelOpen = view?.run.canCancel && cancelRevision === view.run.revision;

  async function create() {
    setSubmitted(true); setSubmittedDraft(draft); setMode("primary");
    await workspace.create(draftForm(draft));
    requestAnimationFrame(() => error.current?.focus());
  }
  function focusField(name: FieldName) {
    setMode("primary");
    requestAnimationFrame(() => {
      const field = document.getElementById(name);
      const section = field?.closest("details");
      if (section) section.open = true;
      field?.focus();
    });
  }
  async function refresh() {
    setCancelRevision(null); await workspace.refresh();
    requestAnimationFrame(() => error.current?.focus());
  }
  async function cancel() {
    await workspace.cancel(); setCancelRevision(null);
    requestAnimationFrame(() => { if (error.current) error.current.focus(); else cancelButton.current?.focus(); });
  }

  return <div className="edict-workspace">
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="site-header"><div className="header-inner"><span className="wordmark">edict<span>.</span></span><span className="brand-caption">Tokenization, as code.</span><div className="environment"><span className="environment-symbol" aria-hidden="true">◇</span><span>Sandbox<span className="environment-network"> / Ethereum Sepolia</span></span></div></div></header>
    <main id="workspace" className="workspace-shell">
      <div className="context-line"><span>Workspace <span aria-hidden="true">/</span> {view ? "Run record" : "New mandate"}</span><span className="context-right">{view ? `Revision ${view.run.revision}` : "Planning / 01"}</span></div>
      <div className="page-heading"><div><h1 ref={heading} tabIndex={-1}>{canceled ? "Run canceled." : view ? view.manifest.asset.name : "Define your mandate."}</h1><p>{canceled ? "The run is closed. Its mandate and plan remain available for review." : view ? "A recorded mandate. A deterministic plan. Ready for your review." : "Set the intent. Inspect the structure. Make it a record."}</p></div><div className="heading-note">{view ? <><span className="small-label">Run state</span><span>{recordStatus(view.run)}</span></> : <><span className="small-label">Intent → structure</span><span>Human-defined. Server-recorded.</span></>}</div></div>
      <div className="workspace-nav"><nav className="reading-modes" aria-label="Workspace reading mode">
        <button type="button" aria-pressed={mode === "primary"} aria-controls="primary-panel" onClick={() => setMode("primary")}><span aria-hidden="true">{view ? "02" : "01"}</span>{view ? "Execution plan" : "Mandate"}</button>
        <button type="button" className="artifact-mode-button" aria-pressed={mode === "artifact"} aria-controls="artifact-panel" onClick={() => setMode("artifact")}>{view ? "Manifest" : "Draft summary"}</button>
        {view && <button type="button" aria-pressed={mode === "details"} aria-controls="primary-panel" onClick={() => setMode("details")}>Record details</button>}
      </nav><span className="nav-provenance">{view ? "Server recorded" : "Draft / Not submitted"}</span></div>
      {showError && <div ref={error} tabIndex={-1} role="alert" className="feedback error"><span className="feedback-mark" aria-hidden="true">!</span><div><strong>{validationErrors ? "Review the highlighted fields." : state.errorCode === "FORBIDDEN" && !view ? "This request is not authorized in this environment." : state.error}</strong>
        {validationErrors && <ul>{fields.filter(field => visibleIssues.some(issue => issue.path === field.path)).map(field => <li key={field.name}><a href={`#${field.name}`} onClick={event => { event.preventDefault(); focusField(field.name); }}>{field.label}: {issueMessage(visibleIssues.find(issue => issue.path === field.path)!)}</a></li>)}</ul>}
        {view && <p>The last accepted record remains below. Refresh the record before taking another action.</p>}
        {!view && state.errorCode === "NETWORK_ERROR" && <p>Plan creation may have completed. No automatic retry will be made.</p>}
      </div></div>}
      <div role="status" aria-live="polite" className={state.notice ? "record-notice" : "sr-only"}>{state.notice ?? ""}</div>
      {view && <div className="record-toolbar" aria-busy={state.pending !== null}><span><span className="record-indicator" aria-hidden="true" />{canceled ? "Closed record" : view.run.approved ? "Plan approval recorded" : "Plan approval not recorded"}</span><div className="record-actions">
        <button type="button" className="button secondary" onClick={() => void refresh()} disabled={!!state.pending || state.unavailable}><span aria-hidden="true">↻</span>{state.pending === "refresh" ? "Refreshing…" : "Refresh record"}</button>
        {view.run.canCancel && <button ref={cancelButton} type="button" className="button quiet" disabled={!!state.pending || state.unavailable} onClick={() => { setCancelRevision(view.run.revision); requestAnimationFrame(() => confirmButton.current?.focus()); }}>Cancel run</button>}
      </div></div>}
      {cancelOpen && <div className="cancel-confirmation"><div><strong>Cancel this run?</strong><p>This closes the run without executing its plan. Its recorded mandate and plan remain available.</p></div><div className="record-actions"><button ref={confirmButton} type="button" className="button danger" disabled={!!state.pending || state.unavailable} onClick={() => void cancel()}>{state.pending === "cancel" ? "Canceling…" : "Confirm cancellation"}</button><button type="button" className="button secondary" disabled={!!state.pending} onClick={() => { setCancelRevision(null); cancelButton.current?.focus(); }}>Keep run</button></div></div>}
      <div className="work-grid" data-reading-mode={mode}>
        <div id="primary-panel" className="primary-panel">{view ? mode === "details" ? <RecordDetails view={view} retrievedAt={state.retrievedAt} /> : <PlanDocument view={view} /> : <MandateForm draft={draft} setDraft={setDraft} errors={visibleIssues} onBlur={name => setTouched(previous => new Set([...previous, name]))} pending={state.pending === "create"} unavailable={state.unavailable} onSubmit={() => void create()} />}</div>
        <aside id="artifact-panel" className="artifact-panel" aria-label={view ? "Recorded manifest" : "Provisional draft summary"}>
          {view ? <RecordedManifest view={view} /> : <DraftSummary draft={draft} ready={issues.length === 0} filled={filled} />}
          {!view && <button type="button" className="button secondary return-to-mandate" onClick={() => setMode("primary")}>Return to mandate <span aria-hidden="true">←</span></button>}
        </aside>
      </div>
      <div className="scope-note"><span className="scope-symbol" aria-hidden="true">└</span><div><strong>Execution is not enabled.</strong><span> This workspace creates and reviews plans. Wallet approval and on-chain execution are unavailable.</span></div></div>
    </main>
    <footer className="site-footer workspace-shell"><span>Edict <span aria-hidden="true">/</span> Planning workspace</span><span>{view ? "One run. Keep this page open to retain this view." : "Intent first. Authority follows."}</span></footer>
  </div>;
}
