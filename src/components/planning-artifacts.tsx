import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PlanningView } from "./run-planning";
import { displayUtc, operationLabels, recordStatus, type Draft } from "./planning-presentation";

export function CopyValue({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    const current = ++attempt.current;
    if (timer.current) clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(value); if (current !== attempt.current) return; setResult("copied"); }
    catch { if (current !== attempt.current) return; setResult("failed"); }
    timer.current = setTimeout(() => setResult(null), 2500);
  }
  return <div className={`copy-value ${compact ? "copy-compact" : ""}`}>
    <div className="copy-heading"><span>{label}</span><button type="button" className="copy-button" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 5h8v9H5zM3 11H2V2h8v1" stroke="currentColor" strokeWidth="1.2" /></svg>{result === "copied" ? "Copied" : "Copy"}</button></div>
    <code>{value}</code>
    <span role="status" className={result === "failed" ? "copy-failure" : "sr-only"}>{result === "copied" ? `${label} copied.` : result === "failed" ? "Select and copy the value manually." : ""}</span>
  </div>;
}

function Row({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="artifact-row"><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{children || <span className="empty-value">Not entered</span>}</dd></div>;
}

export function DraftSummary({ draft, ready, filled }: { draft: Draft; ready: boolean; filled: number }) {
  return <div className="artifact-body draft-artifact">
    <div className="artifact-provenance"><span className="provenance-mark" aria-hidden="true" /><span>Provisional · In this page</span></div>
    <h2>Draft summary</h2><p className="artifact-description">Your intent, taking shape.<br />The server records a manifest after submission.</p>
    <div className="artifact-section"><span className="small-label">01 / Asset</span><dl>
      <Row label="Name">{draft.assetName}</Row><Row label="Symbol" mono>{draft.symbol}</Row>
      <Row label="Supply cap" mono>{draft.supplyCap ? `${draft.supplyCap} tokens` : ""}</Row>
      <Row label="Document">{draft.documentationUrl}</Row>
    </dl></div>
    <div className="artifact-section"><span className="small-label">02 / Authority</span><dl>
      <Row label="Tokenizer">{draft.tokenizerEmail}</Row><Row label="Signer" mono>{draft.tokenizerWallet}</Row>
    </dl></div>
    <div className="artifact-section"><span className="small-label">03 / Allocation</span><dl>
      <Row label="Investor">{draft.investorEmail}</Row><Row label="Recipient" mono>{draft.investorWallet}</Row>
      <Row label="Mint amount" mono>{draft.mintAmount ? `${draft.mintAmount} tokens` : ""}</Row>
    </dl></div>
    <div className="artifact-fixed"><span>RWA_TOKEN</span><span>Sepolia · 11155111</span></div>
    <div className="draft-readiness"><span className="readiness-ticks" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} data-filled={i < filled} />)}</span><span>{ready ? "Ready to create a plan" : `${filled} of 9 fields entered`}</span></div>
    <p className="artifact-footnote">{ready ? "Local validation passed. Server validation follows." : "Draft only. No server record has been created."}</p>
  </div>;
}

export function RecordedManifest({ view }: { view: PlanningView }) {
  const { manifest: m, run } = view;
  return <div className="artifact-body recorded-artifact">
    <div className="artifact-provenance"><span className="provenance-mark recorded" aria-hidden="true" /><span>Server recorded · Manifest v{m.schemaVersion}</span></div>
    <h2>Recorded manifest</h2><p className="artifact-description">The normalized mandate returned by Edict.</p>
    <div className="artifact-section"><span className="small-label">01 / Asset</span><dl>
      <Row label="Name">{m.asset.name}</Row><Row label="Symbol" mono>{m.asset.symbol}</Row>
      <Row label="Supply cap" mono>{m.asset.supplyCap} tokens</Row><Row label="Document">{m.asset.documentationUrl}</Row>
    </dl></div>
    <div className="artifact-section"><span className="small-label">02 / Authority</span><dl><Row label="Tokenizer">{m.tokenizer.email}</Row></dl>
      <CopyValue label="Required signer" value={run.requiredSigner.walletAddress} compact />
    </div>
    <div className="artifact-section"><span className="small-label">03 / Allocation</span><dl><Row label="Investor">{m.investor.email}</Row></dl>
      <CopyValue label="Recipient address" value={m.investor.walletAddress} compact />
      <dl><Row label="Mint amount" mono>{m.investor.mintAmount} tokens</Row></dl>
    </div>
    <div className="artifact-fixed"><span>{m.asset.tokenType}</span><span>Sepolia · {m.chainId}</span></div>
    <details className="structured-detail"><summary>Inspect normalized JSON<span aria-hidden="true">+</span></summary><p>Readable JSON of the server-normalized manifest; formatting is not the canonical hash input.</p><pre tabIndex={0} aria-label="Normalized manifest JSON"><code>{JSON.stringify(m, null, 2)}</code></pre></details>
    <CopyValue label="Manifest hash" value={run.manifestHash} />
  </div>;
}

export function PlanDocument({ view }: { view: PlanningView }) {
  return <section className="plan-document" aria-labelledby="plan-heading">
    <div className="editor-intro"><span className="small-label">Deterministic plan</span><span>Version {view.plan.planVersion} / 7 operations</span></div>
    <div className="plan-intro"><h2 id="plan-heading">Every operation, in order.</h2><p>Three wallet operations. Explicit confirmation and read-back between each. Listed operations have not been started by this workspace.</p></div>
    <div className="plan-authority"><span className="small-label">Required tokenizer signer</span><CopyValue label="Signer address" value={view.run.requiredSigner.walletAddress} compact /></div>
    <ol className="operation-list">{view.plan.operations.map(op => <li key={op.id} data-mode={op.mode}>
      <span className="operation-index" aria-hidden="true">{String(op.sequence).padStart(2, "0")}</span>
      <div><div className="operation-heading"><h3>{operationLabels[op.kind]}</h3><span className="operation-symbol" aria-hidden="true">{op.mode === "WALLET_TRANSACTION" ? "↗" : op.mode === "FINAL_VERIFICATION" ? "◎" : "↳"}</span></div>
        <p>{op.summary}</p><span className="operation-mode">{op.mode === "WALLET_TRANSACTION" ? "Separate wallet confirmation required" : op.mode === "CONFIRM_AND_READ" ? "Confirmation & read-back" : "Final verification"}</span>
      </div>
    </li>)}</ol>
    <div className="plan-identity"><CopyValue label="Plan hash" value={view.run.planHash} /><p>The manifest and plan are immutable. Revision tracks changes to the run record, not edits to the plan.</p></div>
  </section>;
}

export function RecordDetails({ view, retrievedAt }: { view: PlanningView; retrievedAt: string | null }) {
  const { run } = view;
  return <section className="record-details" aria-labelledby="record-heading"><div className="editor-intro"><span className="small-label">Provenance</span><span>Server-returned record</span></div>
    <h2 id="record-heading">Run identity & details</h2><p className="section-description">Identifiers connect this run to its immutable mandate and plan.</p>
    <CopyValue label="Run ID" value={run.id} /><CopyValue label="Plan hash" value={run.planHash} /><CopyValue label="Manifest hash" value={run.manifestHash} />
    <dl className="record-metadata"><Row label="Status">{recordStatus(run)}</Row><Row label="Public status" mono>{run.status}</Row><Row label="Phase" mono>{run.phase}</Row><Row label="Revision" mono>{run.revision}</Row><Row label="Plan approval">{run.approved ? "Recorded" : "Not recorded"}</Row><Row label="Environment">Sandbox / Ethereum Sepolia ({run.chainId})</Row><Row label="Created"><time dateTime={run.createdAt}>{displayUtc(run.createdAt)}</time></Row><Row label="Record updated"><time dateTime={run.updatedAt}>{displayUtc(run.updatedAt)}</time></Row>{retrievedAt && <Row label="Last retrieved"><time dateTime={retrievedAt}>{displayUtc(retrievedAt)}</time></Row>}</dl>
    <div className="record-limitation"><strong>Keep this page open.</strong><p>This workspace holds one active run in page memory. Reloading does not restore this view. A run ID alone does not grant access.</p></div>
  </section>;
}
