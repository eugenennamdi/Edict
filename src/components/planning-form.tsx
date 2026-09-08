import type { Dispatch, SetStateAction } from "react";
import type { PlanningIssue } from "./run-planning";
import { fields, issueMessage, type Draft, type FieldName } from "./planning-presentation";

const sections = [
  { id: "asset", number: "01", title: "Asset intent", description: "Define what will be tokenized." },
  { id: "authority", number: "02", title: "Signing authority", description: "Identify the tokenizer responsible for this mandate." },
  { id: "allocation", number: "03", title: "Investor allocation", description: "Specify one recipient and the intended allocation." },
] as const;

export function MandateForm({ draft, setDraft, errors, onBlur, pending, unavailable, onSubmit }: {
  draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; errors: readonly PlanningIssue[];
  onBlur: (name: FieldName) => void; pending: boolean; unavailable: boolean; onSubmit: () => void;
}) {
  return <form id="mandate-form" noValidate onSubmit={event => { event.preventDefault(); onSubmit(); }} aria-busy={pending}>
    <div className="editor-intro"><span className="small-label">Mandate</span><span>All nine fields required</span></div>
    {sections.map(section => <details className="mandate-section" key={section.id} id={`section-${section.id}`} open>
      <summary><span className="section-index">{section.number}</span><span><span className="section-title">{section.title}</span><span className="section-description">{section.description}</span></span><span className="disclosure-mark" aria-hidden="true">−</span></summary>
      <fieldset disabled={pending}>
        <legend className="sr-only">{section.title}</legend>
        <div className="form-grid">{fields.filter(field => field.section === section.id).map(field => {
          const issue = errors.find(error => error.path === field.path);
          const hint = "hint" in field ? field.hint : undefined;
          return <div className={`field ${"wide" in field ? "field-wide" : ""}`} key={field.name}>
            <label htmlFor={field.name}>{field.label}{"numeric" in field && <span className="field-unit">Whole tokens</span>}</label>
            <input id={field.name} name={field.name} type={field.type} required
              value={draft[field.name]} onChange={event => setDraft(previous => ({ ...previous, [field.name]: event.target.value }))}
              onBlur={() => onBlur(field.name)} placeholder={field.placeholder}
              inputMode={"numeric" in field ? "numeric" : undefined}
              className={"mono" in field ? "mono" : undefined}
              autoCapitalize={field.name === "assetName" ? "sentences" : "none"} spellCheck={field.name === "assetName"}
              aria-invalid={issue ? true : undefined}
              aria-describedby={[hint ? `${field.name}-hint` : "", issue ? `${field.name}-error` : ""].filter(Boolean).join(" ") || undefined} />
            {hint && <p id={`${field.name}-hint`} className="field-hint">{hint}</p>}
            {issue && <p id={`${field.name}-error`} className="field-error">{issueMessage(issue)}</p>}
          </div>;
        })}</div>
      </fieldset>
    </details>)}
    <div className="authority-boundary">
      <div><strong>Make the mandate a record.</strong><p>Creating a plan does not approve or execute it.</p></div>
      <button type="submit" className="button primary" disabled={pending || unavailable}>{pending ? "Creating plan…" : "Create execution plan"}<span aria-hidden="true">↗</span></button>
    </div>
  </form>;
}
