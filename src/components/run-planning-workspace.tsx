"use client";

import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { createPlanningWorkspace, initialWorkspace, type PlanningView } from "./run-planning";

function Field({ label, hint, name, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; name: string }) {
  return <div className="field">
    <label htmlFor={name}>{label}</label>
    <input id={name} name={name} required aria-describedby={hint ? `${name}-hint` : undefined} {...props} />
    {hint && <p id={`${name}-hint`} className="field-hint">{hint}</p>}
  </div>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail"><dt>{label}</dt><dd>{children}</dd></div>;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [notice, setNotice] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied.`); }
    catch { setNotice("Select and copy the value manually."); }
  }
  return <div className="copy-value">
    <div className="copy-label"><span>{label}</span><button type="button" className="text-button" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>Copy</button></div>
    <code>{value}</code><span className="copy-notice" role="status">{notice}</span>
  </div>;
}

function PlanReview({ view }: { view: PlanningView }) {
  const { run, manifest, plan } = view;
  return <>
    <section className="workspace-section" aria-labelledby="manifest-heading">
      <div className="section-heading"><span className="step-number">01</span><div><h2 id="manifest-heading">Normalized manifest</h2><p>The mandate recorded by Edict. These values are returned by the server.</p></div></div>
      <dl className="detail-grid">
        <Detail label="Asset name">{manifest.asset.name}</Detail>
        <Detail label="Symbol">{manifest.asset.symbol}</Detail>
        <Detail label="Token type">{manifest.asset.tokenType}</Detail>
        <Detail label="Supply cap">{manifest.asset.supplyCap} whole tokens</Detail>
        <Detail label="Documentation"><span className="identifier">{manifest.asset.documentationUrl}</span></Detail>
        <Detail label="Manifest version">{manifest.schemaVersion}</Detail>
        <Detail label="Tokenizer email">{manifest.tokenizer.email}</Detail>
        <Detail label="Investor email">{manifest.investor.email}</Detail>
        <Detail label="Investor address"><code>{manifest.investor.walletAddress}</code></Detail>
        <Detail label="Planned mint amount">{manifest.investor.mintAmount} whole tokens</Detail>
      </dl>
      <CopyValue label="Required tokenizer signer" value={run.requiredSigner.walletAddress} />
    </section>
    <section className="workspace-section" aria-labelledby="plan-heading">
      <div className="section-heading"><span className="step-number">02</span><div><h2 id="plan-heading">Deterministic execution plan</h2><p>Server-generated order · Plan version {plan.planVersion}. Listed operations have not been started by this workspace.</p></div></div>
      <ol className="operation-list">
        {plan.operations.map((operation) => <li key={operation.id}>
          <span className="operation-number" aria-hidden="true">{String(operation.sequence).padStart(2, "0")}</span>
          <div><h3>{operation.kind.toLowerCase().replaceAll("_", " ")}</h3><p>{operation.summary}</p></div>
          <span className="operation-mode">{operation.mode === "WALLET_TRANSACTION" ? "On-chain operation" : operation.mode === "CONFIRM_AND_READ" ? "Confirmation & read" : "Final verification"}</span>
        </li>)}
      </ol>
    </section>
    <section className="workspace-section" aria-labelledby="identity-heading">
      <div className="section-heading"><span className="step-number">03</span><div><h2 id="identity-heading">Run identity</h2><p>Server-generated identifiers for this immutable mandate and plan.</p></div></div>
      <CopyValue label="Run ID" value={run.id} />
      <CopyValue label="Manifest hash" value={run.manifestHash} />
      <CopyValue label="Plan hash" value={run.planHash} />
      <dl className="detail-grid run-metadata">
        <Detail label="Public status">{run.status}</Detail><Detail label="Phase">{run.phase}</Detail>
        <Detail label="Revision">{run.revision}</Detail><Detail label="Approval">{run.approved ? "Recorded" : "Pending"}</Detail>
        <Detail label="Created (UTC)"><time dateTime={run.createdAt}>{run.createdAt.replace("T", " ").replace("Z", " UTC")}</time></Detail>
        <Detail label="Updated (UTC)"><time dateTime={run.updatedAt}>{run.updatedAt.replace("T", " ").replace("Z", " UTC")}</time></Detail>
      </dl>
    </section>
  </>;
}

export default function RunPlanningWorkspace() {
  const [state, setState] = useState(initialWorkspace);
  const [workspace] = useState(() => createPlanningWorkspace(setState));
  const heading = useRef<HTMLHeadingElement>(null);
  const error = useRef<HTMLDivElement>(null);
  const view = state.view;
  const runId = view?.run.id;
  const canceled = view?.run.terminalOutcome === "CANCELLED";
  useEffect(() => { if (runId) heading.current?.focus(); }, [runId, canceled]);
  useEffect(() => { if (state.error) error.current?.focus(); }, [state.error]);

  return <div className="workspace-shell">
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="site-header"><span className="wordmark">edict<span aria-hidden="true">.</span></span><span className="brand-caption">Tokenization, as code.</span><span className="environment-tag">Sandbox · Sepolia</span></header>
    <main id="workspace">
      <div className="page-heading">
        <p className="eyebrow">Run planning workspace</p>
        <h1 ref={heading} tabIndex={-1}>{canceled ? "Run canceled." : view ? "Review your run." : "Define your mandate."}</h1>
        <p className="lede">{canceled ? "This run is closed. Its recorded mandate and plan remain available for review." : view ? "Inspect the normalized mandate and deterministic plan before any future approval." : "Turn a structured tokenization mandate into a clear, deterministic execution plan."}</p>
      </div>
      <ol className="workflow" aria-label="Planning workflow">
        <li aria-current={!view ? "step" : undefined}><span>01</span> Mandate</li>
        <li aria-current={view ? "step" : undefined}><span>02</span> Manifest & plan</li>
        <li><span>03</span> {canceled ? "Canceled" : view?.run.approved ? "Approval recorded" : "Approval pending"}</li>
      </ol>
      <div className="scope-note"><strong>Execution is not enabled.</strong><span>This workspace creates and reviews plans. Wallet approval and on-chain execution are unavailable.</span></div>
      {state.error && <div ref={error} tabIndex={-1} role="alert" className="feedback error">{state.error}</div>}
      <div role="status" aria-live="polite" className={state.notice ? "feedback" : "sr-only"}>{state.notice ?? ""}</div>
      {view ? <>
        <div className="run-toolbar" aria-busy={state.pending !== null}>
          <div><span className="status-tag">{canceled ? "Canceled" : view.run.terminalOutcome?.replaceAll("_", " ") ?? view.run.status.replaceAll("_", " ")}</span><p>{view.run.environment} · Sepolia ({view.run.chainId}) · Revision {view.run.revision}</p></div>
          <div className="button-group">
            <button type="button" className="secondary-button" onClick={() => void workspace.refresh()} disabled={!!state.pending || state.unavailable}>{state.pending === "refresh" ? "Refreshing…" : "Refresh run"}</button>
            {view.run.canCancel && <button type="button" className="cancel-button" onClick={() => void workspace.cancel()} disabled={!!state.pending || state.unavailable}>{state.pending === "cancel" ? "Canceling…" : "Cancel run"}</button>}
          </div>
        </div>
        <PlanReview view={view} />
      </> : <form onSubmit={(event) => { event.preventDefault(); void workspace.create(new FormData(event.currentTarget)); }} aria-busy={state.pending === "create"}>
        <p className="form-intro">All fields are required. Network: Ethereum Sepolia (11155111). Token type: RWA_TOKEN.</p>
        <fieldset disabled={!!state.pending || state.unavailable}>
          <legend><span className="step-number">01</span> Asset</legend>
          <p className="section-description">Define the asset and the maximum number of whole tokens.</p>
          <div className="form-grid">
            <Field name="assetName" label="Asset name" maxLength={240} hint="A descriptive name, up to 120 characters." />
            <Field name="symbol" label="Token symbol" maxLength={5} pattern="[A-Za-z0-9]{3,5}" hint="3–5 letters or digits. Edict normalizes to uppercase." autoCapitalize="characters" spellCheck={false} />
            <Field name="supplyCap" label="Supply cap" inputMode="numeric" pattern="[0-9]+" maxLength={100} hint="A positive whole-token amount." />
            <Field name="documentationUrl" label="Documentation URL" type="url" maxLength={2048} hint="An HTTPS document URL without embedded credentials." />
          </div>
        </fieldset>
        <fieldset disabled={!!state.pending || state.unavailable}>
          <legend><span className="step-number">02</span> Tokenizer</legend>
          <p className="section-description">Identify the tokenizer and the public address required to sign the future plan.</p>
          <div className="form-grid">
            <Field name="tokenizerEmail" label="Tokenizer email" type="email" maxLength={254} autoCapitalize="none" spellCheck={false} />
            <Field name="tokenizerWallet" label="Tokenizer wallet address" pattern="0x[0-9a-fA-F]{40}" maxLength={42} hint="Public Ethereum address: 0x followed by 40 hexadecimal characters." spellCheck={false} autoCapitalize="none" />
          </div>
        </fieldset>
        <fieldset disabled={!!state.pending || state.unavailable}>
          <legend><span className="step-number">03</span> Investor allocation</legend>
          <p className="section-description">The complete mandate includes the intended investor and allocation for the later execution plan.</p>
          <div className="form-grid">
            <Field name="investorEmail" label="Investor email" type="email" maxLength={254} hint="Must differ from the tokenizer email." autoCapitalize="none" spellCheck={false} />
            <Field name="investorWallet" label="Investor wallet address" pattern="0x[0-9a-fA-F]{40}" maxLength={42} hint="The investor’s public Ethereum address." spellCheck={false} autoCapitalize="none" />
            <Field name="mintAmount" label="Planned mint amount" inputMode="numeric" pattern="[0-9]+" maxLength={100} hint="Positive whole tokens, no greater than the supply cap." />
          </div>
        </fieldset>
        <div className="form-actions"><p>Edict validates and normalizes your mandate on the server.<br />Creating a plan does not approve or execute it.</p><button className="primary-button" type="submit" disabled={!!state.pending || state.unavailable}>{state.pending === "create" ? "Creating run…" : "Create execution plan"}<span aria-hidden="true"> →</span></button></div>
      </form>}
    </main>
    <footer className="site-footer"><span>Edict / Run planning</span><span>{view ? "Keep this page open to manage this run." : "Sandbox planning · Execution unavailable"}</span></footer>
  </div>;
}
