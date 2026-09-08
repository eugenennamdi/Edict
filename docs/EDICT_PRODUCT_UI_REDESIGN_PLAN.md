# Edict product UI redesign plan

**Status: proposal for review; implementation is not authorized.**

Repository assessment: 2026-09-08. Deliverable scope: product design and frontend architecture only. This document proposes a presentation system around the existing application contract. It does not authorize wallet activity, external execution, migrations, new APIs, or changes to deterministic/security logic.

**Reading convention:** **CODE OBSERVATION** identifies behavior inspected in this repository; linked files and named functions are its evidence. **DECISION** identifies a proposed design choice, pending review. **ASSUMPTION** identifies a deduction requiring validation. **OPEN QUESTION** identifies information repository inspection cannot supply. “Verified” in proposed interface copy always describes a specific recorded application result, never this design assessment.

## 1. Executive assessment

Edict translates a complete tokenization mandate into an immutable, reviewable plan, binds human approval to that plan, and is intended to establish evidence of the resulting state. Its product value lies in the boundaries between intent, authority, execution, and proof. The interface should let an operator answer four questions without interpreting implementation enums: **What did I request? What am I authorizing? What is known to have happened? What remains unproven?**

**DECISION —** Make the run a working record. The editable mandate, recorded manifest, ordered operations, and eventual evidence should share a stable grid and recognizable provenance language. Use a quiet document-like workspace with aligned rows and explicit boundaries. The product's distinction should come from the relationship between instructions and recorded facts, not ornamental infrastructure imagery.

### What exists today

**CODE OBSERVATION —** Phase 10 implements one planning workspace at `/`. It creates a run, displays its normalized manifest and seven-operation plan, refreshes its public state, and cancels when permitted. Approval endpoints and offline wallet coordinators exist. Production execution composition, public execution endpoints, detailed evidence delivery, and deployment receipt issuance do not. The initial UI accurately says execution is unavailable. See [README](../README.md), [workspace](../src/components/run-planning-workspace.tsx), [API handlers](../src/server/run-api/handlers.ts), and [execution types](../src/server/execution/types.ts).

The redesign has two delivery boundaries:

| Boundary | What this plan covers | What can ship after design approval |
| --- | --- | --- |
| Planning release | Mandate, provisional summary, server manifest, plan, public run state, errors, refresh, cancellation | Frontend changes using the current three UI endpoints |
| Conditional lifecycle | Approval, wallet handoff, execution, reconciliation, evidence, receipt | Designs only until each missing contract and separate activation gate is satisfied |

A complete lifecycle design is useful now. Presenting the entire lifecycle as an already functional product would be inaccurate.

### Current UI audit

This is a source and static-render assessment. No user screenshot was available beyond the written description. No browser interaction, viewport screenshot, or assistive-technology session was performed; visual conclusions below are design judgments grounded in the JSX/CSS, not measured usability results.

| Finding | Evidence and consequence | Design response |
| --- | --- | --- |
| The introduction occupies too much of the work surface | A 100px header, 54px main inset, heading up to 49px, lead, workflow, and availability block precede the fields in `globals.css` | Compact context header; put the task and first meaningful fields near the top |
| Structure follows form implementation more than operator decisions | Nine fields in equally weighted two-column groups; immutable restrictions appear separately | Give asset intent, signing authority, and recipient allocation distinct hierarchy |
| Edict's central transformation disappears at submission | Form is replaced by three long sections; there is no visible connection between entered and recorded values | Keep a stable artifact region; promote provisional values to server-recorded values only on response |
| Review has weak decision hierarchy | Normalized details, seven descriptions, then hashes/status; the required signer is separated from initial context | Put signer, environment, immutable identity, and operations in the first review viewport |
| Progress language is incomplete | Three workflow items stop at “Approval pending”; persisted enums are also exposed verbatim | Separate artifact navigation from truthful lifecycle state; explain future boundaries once |
| Validation loses actionable detail | Local issues are joined into one deduplicated string; server `issues: {code,path}[]` are ignored | Field-linked messages and a focused error summary using existing stable paths/codes |
| Browser constraints diverge from domain normalization | `assetName` permits 240 code units but describes 120 characters; native patterns can reject whitespace that the domain trims | Make the shared validator authoritative for domain feedback; do not tighten domain policy through HTML attributes |
| Refresh semantics are easily misunderstood | The action fetches a stored run; it does not query Brickken or resume execution | Label it “Refresh record” with a local “Last retrieved” time distinct from server `updatedAt` |
| Recovery is limited | Run/manifest live in page memory; GET omits manifest; no run page, history, or rehydration | State this limitation before leaving the page; do not advertise resumable links |
| Responsive behavior is only a stack | One breakpoint at 640px collapses form/details and wraps operations | Give mobile one reading mode at a time while preserving form and context |
| Accessibility has a good foundation, limited validation | Labels, fieldsets, skip link, focus handling, status region, and reduced-motion styles exist; tests use static markup | Retain these behaviors and add real keyboard, focus, reflow, and announcement checks |

The existing restraint is worth retaining. The shortcomings are hierarchy, artifact continuity, and state interpretation; additional decoration would not solve them.

## 2. Current application map

### Routes and frontend dependencies

| Route / source | Actual behavior | Frontend consequence |
| --- | --- | --- |
| [`src/app/layout.tsx`](../src/app/layout.tsx) | Server root layout, metadata, English document, global CSS | Keep as the server shell boundary |
| [`src/app/page.tsx`](../src/app/page.tsx) | Renders `RunPlanningWorkspace` | One user-facing route; no dashboard or run-detail route |
| `POST /api/runs` | Strict `{manifest}`; server validates, persists V2 revision 1, derives plan, issues capability cookie; returns run, manifest, plan | Only source of the current page's recorded manifest |
| `GET /api/runs/[runId]` | Capability-protected read; returns run and rederived plan, **not manifest** | Refresh requires the previously held manifest; no fresh-page restore contract |
| `POST /api/runs/[runId]/cancel` | `{expectedRevision}`; CAS-protected legal cancellation; returns run only | Merge with previously validated artifacts, then verify cancellation response |
| `POST /api/runs/[runId]/approval-challenges` | `{expectedRevision}`; issues bounded EIP-712 challenge | Exists, but current UI does not call it |
| `POST /api/runs/[runId]/approval` | `{expectedRevision, challengeToken, signature}`; verifies proof and persists approval | Exists, but current UI does not call it |

All API route modules select Node runtime and force dynamic handling. Their implementation lives in [run API handlers](../src/server/run-api/handlers.ts). There is no prepare, prompt/result, confirmation, polling, verification, receipt, listing, or edit route.

### Components and state sources

| Source | Ownership / current behavior |
| --- | --- |
| [`run-planning-workspace.tsx`](../src/components/run-planning-workspace.tsx) | One client component with nested `Field`, `Detail`, `CopyValue`, `PlanReview`; DOM-owned form values, controller state, focus effects, clipboard notices |
| [`run-planning.ts`](../src/components/run-planning.ts) | `creationRequest`, runtime public projection, application-owned errors, serialized create/refresh/cancel controller; synchronous duplicate-action guard |
| [`globals.css`](../src/app/globals.css) | Dark system-font palette, global element styling, 1080px shell, two-column form, 640px breakpoint; no separate token or component style files |
| [`manifest.ts`](../src/core/manifest.ts) | Strict normalized/branded manifest and path/code errors; available to browser for feedback; no network |
| [`execution-plan.ts`](../src/core/execution-plan.ts) | Frozen seven-operation plan, hashed summaries and intents; builder is server-used for this workspace |
| [`run-service.ts`](../src/server/execution/run-service.ts) | Run creation and event application through repository; immutable identities and revision ordering |
| [`types.ts`](../src/server/execution/types.ts), [`transitions.ts`](../src/server/execution/transitions.ts) | Persisted phase/status/outcome, three write operations, fine-grained stages, approval, observations, events, receipt eligibility |
| [`orchestration/service.ts`](../src/server/orchestration/service.ts) | Internal prepare/confirm/poll/read-back/finalize operations, injected adapter, durable ordering, write gates |
| [`wallet-intent.ts`](../src/server/orchestration/wallet-intent.ts), [`shared/wallet/intent.ts`](../src/shared/wallet/intent.ts) | Server derivation from durable prompt and browser recomputation of exact intent |
| [`client/wallet/`](../src/client/wallet/index.ts) | Passive discovery, selected provider session, approval coordinator, transaction coordinator; no production gateway composition |
| [`persistence/codec.ts`](../src/server/persistence/codec.ts), [`schema.ts`](../src/server/persistence/schema.ts), [`repository.ts`](../src/server/persistence/repository.ts) | Strict V1/V2/V3 JSONB aggregate, atomic CAS and version handling; server-only |
| [`brickken/adapter.ts`](../src/server/brickken/adapter.ts) | Server-only SDK prepare/read/confirm/status boundary, runtime schemas, one-attempt configuration; no signing |

The persistence plan snapshot retains identity metadata, not the complete seven-operation body. `publicPlan()` revalidates the stored manifest, rebuilds the plan, and refuses mismatching hashes. A frontend copy change must not alter hashed summary templates.

### What public data actually contains

The server run projection contains run ID, snapshot version, hashes, environment, signer, phase/status/outcome, approval boolean, revision/timestamps, `receiptEligible`, and each operation's ID/kind/stage/prepared ID/hash/Brickken status/timeout. It omits unsigned transactions, approval proof, events, observations, operation timestamps, and V3 comparison/receipt evidence.

The current browser parser narrows further: it discards operation detail after calculating `canCancel`, discards snapshot version and `receiptEligible`, and keeps only plan operation ID/sequence/kind/mode/summary. Expanding a presentation requires an explicit runtime projection; a TypeScript cast to the persistence aggregate is unacceptable.

### Configuration and access

**CODE OBSERVATION —** [README setup](../README.md#environment-configuration), [deployment config](../src/server/run-api/config.ts), and [.env.example](../.env.example) define planning configuration. Planning requires the exact enable flag, trusted origin, server security secret, and durable database. It does not require a Brickken API key. The current page has no readiness endpoint or server availability prop; absence of a response is not proof planning is enabled.

The browser has one 24-hour HttpOnly capability cookie; creating another run replaces it. HTTPS/production and explicit local HTTP use separate cookie policies. A run ID is not authorization. GET may omit Origin under the existing checks; mutations must retain exact-origin enforcement. No client storage, cookie inspection, environment settings screen, or credentials input is proposed.

### Actual state machine and documentation drift

**CODE OBSERVATION —** The executable model is narrower than the older conceptual table in [ARCHITECTURE.md](ARCHITECTURE.md). Preserve both as current implementation versus intended lifecycle; do not add enum members to reconcile the UI.

| Conceptual language | Implemented reality |
| --- | --- |
| `DRAFT`, `VALIDATION`, `READY`, `INVALID` | Local editing/validation concepts; no such persisted run phases/statuses |
| `RETRYABLE_FAILURE` | Absent from `RunStatus`; current ambiguity uses `RECONCILIATION_REQUIRED` |
| Wallet rejection returns to approval | Transition retains plan approval and `AWAITING_WALLET`, operation `WALLET_REJECTED`; browser transaction coordinator treats post-invocation errors as unknown |
| `RECEIPT`, terminal `COMPLETE` | Absent; final verification sets `receiptEligible: true`, with phase `VERIFICATION`, status `SUCCEEDED`, terminal outcome still null |
| Stored requested/observed response snapshots | Read-back observations currently store only operation kind, read label, and timestamp; V3 has separate transaction/receipt evidence |
| Refresh resumes execution | Current GET only reads persisted state; no execution-resume UI or public orchestrator route |

The implemented sequence is:

```text
Local draft / validation (no run)
  → POST create → PLAN / AWAITING_APPROVAL, revision 1
  → verified approval → TOKENIZATION / PREPARING, operation NOT_STARTED
  → PREPARE_INTENT → PREPARED → WALLET_PROMPT_RECORDED
  → BROADCAST_HASH_PERSISTED → CONFIRMATION_SUBMITTED → PENDING / CONFIRMED
  → READ_BACK_VERIFIED
  → WHITELIST / PREPARING → same operation sequence
  → MINT / PREPARING → same operation sequence
  → VERIFICATION / SUCCEEDED, receiptEligible false
  → RECORD_FINAL_VERIFICATION → receiptEligible true
  [deployment receipt issuance is not implemented]
```

V3 transaction comparison and receipt/finality are additional evidence gates, not replacement stage enums. `CONFIRMED` retains run status `CONFIRMING`; `SUCCEEDED` alone does not prove final verification. Older V1/V2 transitions do not establish V3 finality. The presentation must respect these distinctions.

## 3. Design thesis

**DECISION — The run is the interface's organizing object.** Give it a stable title, context line, artifact identity, and ordered body. Avoid permanent app sidebars with empty destinations. There is currently one meaningful job and one active run.

The recognizable Edict system consists of four recurring treatments:

1. **A numbered gutter.** Two-digit operation/section indexes align on a narrow left column. The number identifies structure, not progress percentage.
2. **A provenance line.** “Draft · In this page”, “Manifest · Server recorded”, and later “Evidence · Recorded observation” appear in the same position above each artifact.
3. **An authority boundary.** A full-width rule separates readable instructions from the action granting authority. The consequence of that action sits beside the button.
4. **An identity footer.** Artifact version and full-copyable identity occupy a consistent closing row. Hashes are useful identifiers, not decorative background text.

**DECISION —** Use warm white work surfaces, near-black type, and a narrow restrained blue interaction accent. The current dark-only styling does not define Edict's identity. A lighter working record supports prolonged comparison of addresses, quantities, and prose and connects the future receipt to the workspace. This is a proposed design direction, not a claim of measured user preference. Do not add a theme selector in the first release.

**ASSUMPTION —** The primary operator understands their asset and recipient but may not understand Edict's state names. Human labels should be primary; precise technical identifiers remain one disclosure away. Validate this assumption with actual operators after the first reviewable prototype.

Interaction principles: preserve context; reveal only supported actions; keep one primary action per decision; retain last confirmed facts through transport failures; make uncertainty explicit; let users inspect without accidentally granting authority. No animation, visit, tab selection, or scrolling event authorizes anything.

## 4. Application shell

**DECISION —** Retain `/` for the planning release. Use a compact 64px top header: Edict wordmark at left, tagline where space allows, and plain “Sandbox / Ethereum Sepolia” text at right. Environment is fixed context, not a selectable network and not a green connectivity indicator.

Below it, the run context is two lines: task title and, after creation, asset name/symbol with “Run record · Revision N”. A disclosure exposes the full run ID, hashes, server timestamps, and raw status. Before creation there is no run ID, revision, or approval status.

Artifact navigation and lifecycle state serve different purposes:

| Region | Planning release | Conditional complete lifecycle |
| --- | --- | --- |
| Artifact navigation | Draft: Mandate / Draft summary. Recorded: Plan / Manifest / Record details | Add Evidence only when an authorized projection exists; receipt is opened from evidence once issued |
| Lifecycle line | “Mandate” then “Plan recorded · Approval unavailable here” | Mandate → Plan → Approval → Execution → Verification → Receipt, derived from recorded state |
| Availability | One concise note: “Plan creation and review. Wallet approval and execution are unavailable.” | Separate approval readiness, execution readiness, and observed run state |
| Action boundary | Create execution plan; later Refresh record and legal Cancel run | Operation-specific authority controls only after their gates exist |

Future lifecycle items are plain explanatory text, never dead navigation pretending a screen is available. A disabled deployment can still contain a previously approved record: show both “Approval recorded” and “Execution unavailable”; configuration and run state are independent.

No global “New run” action while another active run is displayed. The present one-capability behavior makes switching destructive to browser access. A future restart flow must explicitly explain replacement access and cannot claim an archive exists. Cancellation preserves the current read-only record.

## 5. Screen-by-screen UX and state coverage

The following is the rendering contract. **Current** means reachable in the existing planning interface. **Projection** means the current API can expose the fact, but the UI currently drops detail. **Conditional** means a real domain/client state exists without production frontend composition. **Missing** means a proposed experience requires a new contract.

### Mandate and record states

| State / source | Screen, feedback, next action | Support |
| --- | --- | --- |
| Empty local form | “Define the mandate”; empty summary rows say “Not entered”; one Create execution plan action | Current |
| Partially completed | Keep entered strings; show section readiness without success marks; incomplete summary remains visibly provisional | Current data; proposed presentation |
| Local invalid | Inline field messages plus linked error summary; open affected mobile pane/section; focus summary on submit | Current validator; proposed presentation |
| Validating / creating | “Creating plan…” only while request is in flight; preserve form footprint and suppress duplicate submission | Current |
| Server 422 validation | Map only recognized `code,path` pairs to fields; otherwise generic safe error; preserve inputs | Existing payload; proposed parser addition |
| `PLAN/AWAITING_APPROVAL` | “Execution plan”; server-recorded manifest and seven operations; approval unavailable note | Current |
| Refresh pending | Keep last record visible; “Refreshing record…” on action; no full-page skeleton or execution pulse | Current |
| Revision/state conflict | Read latest record, announce “Record updated. Review before acting again.” Never retry mutation automatically | Current cancellation behavior |
| Older revision / changed identity / malformed response | Retain prior record, label update unconfirmed, expose Refresh record only for recovery; no acceptance of replacement identity | Current projection refusal |
| `CANCELLED` terminal outcome | “Run canceled”; muted outcome, immutable artifacts retained; refresh permitted, cancel absent | Current; overrides generic `FAILED` status |
| `API_DISABLED` | “Plan creation is unavailable in this environment.” Preserve readable/editable draft; creation stays disabled for this page session | Current code/gate; proposed field-editing presentation |
| `FORBIDDEN` | “This request is not authorized.” With a run: access may have expired or been replaced; before creation: this environment may not allow the request | Current error; proposed context-sensitive copy; do not diagnose the exact cause |
| `NOT_FOUND` | “This run is unavailable”; retain last known record if present, with retrieval limitation | Current |
| `SERVICE_UNAVAILABLE` / network / non-JSON | “The latest result could not be confirmed”; retain prior values and revision, no optimistic success | Current |
| Create response lost | Draft retained; “Plan creation could not be confirmed.” No run ID may be available; do not claim nothing was created or silently POST again | Current ambiguity; no recovery lookup |
| Reload / new tab | No reconstruction of the current manifest/run; initial page only | Current limitation; resume workflow Missing |
| Revised mandate / plan | No PATCH or editable persisted plan. Any future revision workflow creates a separately identified artifact/run under reviewed access semantics | Missing; not a supported run state |

### Approval and wallet states

| State / source | Screen, feedback, next action | Support |
| --- | --- | --- |
| Awaiting approval | Review identity, signer and three wallet operations; explicit “Approve this plan” after account/network readiness | Conditional; endpoints exist |
| No discovered provider | “No browser wallet detected”; explain injected-wallet requirement; explicit legacy-provider option only | Conditional; no WalletConnect/mobile deep link support |
| Available / late provider | Plain selectable list, no automatic selection; additions do not move keyboard focus | Conditional |
| Collision / malformed metadata | Collision entry unavailable; malformed announcements are ignored by discovery; do not invent a diagnostic entry | Conditional |
| Selected / unauthorized account access | Provider selection followed by separate “Allow account access”; not a signing request | Conditional |
| Required account missing | Show full required address and available-account mismatch; “Check wallet again” after user changes wallet account | Conditional |
| Wrong chain | “Switch to Ethereum Sepolia”; explicit action. On refusal/unsupported switch explain manual change, then recheck | Conditional |
| Session invalidated / disconnected / provider changed | Mark readiness unavailable; discard local attempt readiness; require explicit reinspection/reselection | Conditional |
| Challenge requested / signing | “Approval requested. Check your wallet.” Show exact plan identity; generic busy stage unless gateway exposes a confirmed finer event | Conditional |
| Challenge expired | “Approval request expired”; new explicit attempt rereads run and obtains a new challenge | Conditional; five-minute lifetime |
| Challenge/digest mismatch | “Approval request could not be validated”; stop, reread; no raw payload or signature display | Conditional |
| Approval signature rejected | “Plan approval was not recorded”; allow a fresh explicit attempt after reread | Conditional; distinct from transaction rejection |
| Signing unsupported | Explain EIP-712 EOA requirement; choose another eligible provider; no fallback signature method | Conditional |
| Approval submission/read uncertain | Show “Approval result not confirmed”; reread before offering another signature | Conditional; proposed gateway presentation |
| Durable `approved: true` | “Plan approval recorded”; execution availability remains separate | Projection; does not mean an operation started |

### Execution, verification, and outcomes

Apply each operation row to TOKENIZE, WHITELIST, and MINT; never skip the intervening read-back.

| Persisted or client state | Primary reading / permitted presentation | Support |
| --- | --- | --- |
| Approved + `NOT_STARTED` | “Authorized · Operation not started”; no preparing spinner merely because run status is `PREPARING` | Projection |
| `PREPARE_INTENT` | “Preparation requested”; durable request intent is known, response is not. After an interrupted attempt, do not promise work is still running | Projection; initiating action Conditional |
| `PREPARED` | “Transaction prepared”; detailed handoff needs authorized DTO; no second prepare | Projection; DTO display Missing |
| `WALLET_PROMPT_RECORDED`, active local call | “Wallet confirmation requested”; one pending action, no second prompt | Conditional |
| `WALLET_PROMPT_RECORDED`, no active local call | “Wallet outcome not recorded”; treat the durable prompt as a replay lock, not proof a wallet window remains open | Projection |
| `WALLET_REJECTED` | “Wallet request declined before submission” only when the boundary establishes that classification; preserve prepared transaction and approval | Conditional; not emitted for post-invocation errors by the browser coordinator |
| Pre-invocation refusal | “Transaction not submitted”; reason from stable error code. A durable prompt may already be locked; reread before any further action | Conditional |
| Invocation in flight | “Awaiting wallet result”; cannot know exact signing/broadcast instant; no percentage or “mining” claim | Conditional |
| Invalid result / send timeout / post-invocation error, including `4001` | “Broadcast outcome unknown”; persistent explanation that a transaction may have been sent; block send/reprepare | Conditional |
| `BROADCAST_HASH_PERSISTED` / `BROADCAST_RECORDED` | “Transaction hash recorded”; display exact hash; confirmation/finality still unproven | Projection |
| Hash handoff failure | “Transaction record needs reconciliation”; coordinator rereads durable state and accepts only matching hash; do not promise the failed hash is exposed by its error object | Conditional |
| `CONFIRMATION_SUBMITTED` | “Confirmation requested”; persisted intent does not by itself prove Brickken accepted it | Projection |
| `PENDING` / `CONFIRMING` | “Awaiting confirmation”; only existing-hash polling in a later authorized executor, never resend | Projection; polling UI Conditional |
| Confirmation transport failure returning to `BROADCAST_HASH_PERSISTED` | Show recorded hash and unconfirmed reconciliation result; same-pair confirmation exists internally, no browser retry command today | Projection / Conditional |
| `TIMED_OUT` with `PENDING` | “Confirmation check timed out”; nonterminal. Future bounded status check uses same identifiers; current Refresh record only rereads storage | Projection |
| `PREPARE_UNKNOWN` + reconciliation status | “Preparation outcome unknown”; stop automatic activity; copy record identifiers | Projection |
| `PREPARE_UNKNOWN` + terminal `FAILED` | “Preparation failed”; terminal outcome takes precedence over ambiguous-sounding operation enum | Projection |
| `BROADCAST_UNKNOWN` / `RECONCILIATION_REQUIRED` | “Reconciliation required”; explain known facts and missing evidence; refresh/copy only in present scope | Projection |
| V3 transaction `MATCH/CLEAR` | “Transaction matches the approved request”; no finality claim | Conditional; evidence projection Missing |
| V3 receipt `INCLUDED` | “Included in a block”; successful execution and finality are separate fields | Conditional; projection Missing |
| V3 receipt `FINALIZED`, identity match, successful execution | “Finality recorded”; still require operation read-back | Conditional; projection Missing |
| `CONFIRMED` / Brickken `success` | “Brickken reports success · Read-back pending”; do not use global verified state | Projection |
| `READ_BACK_VERIFIED` | “Read-back matched” for this operation; unlock only the server's next permitted stage | Projection |
| Read-back transport failure | Existing stage remains; “Read-back result not available” only when an authorized action returned that error | Conditional; no persisted standalone retry state |
| `VERIFICATION/SUCCEEDED`, eligibility false | “Operation checks complete · Final verification not recorded” | Projection; current parser drops eligibility |
| Same phase/status, eligibility true | “Final verification recorded · Deployment receipt unavailable” | Projection; no receipt exists |
| `REJECTED` or terminal `FAILED` | “Run failed”; retain prior operation results and hashes; no success receipt or rollback claim | Projection |
| Terminal `VERIFICATION_FAILED` | “Verification failed”; show available operation context; field-level mismatch details require stored evidence | Projection; detailed comparison Missing |
| Missing transaction / changed inclusion / evidence mismatch | Reconciliation explanation only if the authoritative evidence supplies that cause; never infer replacement or reorg from waiting | Conditional |
| Issued deployment receipt | Immutable receipt view/download only from a future server artifact | Missing |

**DECISION — State precedence:** render known terminal outcome first, then reconciliation/uncertainty, then operation stage and evidence, then aggregate status. Availability is a separate axis. Unknown/malformed states produce “Record could not be interpreted,” disable mutation, and preserve the last accepted record. Never map an unfamiliar value to success.

## 6. Mandate workspace

### Exact desktop composition

**DECISION —** At 1440px, use a centered 1280px maximum work area with 48px outer minimum gutters when space permits. Inside it, an approximately 760px editing column and 400px artifact column share a 32px structural gap; remaining width accommodates the section gutter. The artifact side has one left rule, not a card. On smaller laptops use a 3:2 allocation with a minimum practical summary width near 320px; switch reading modes when the fields become cramped.

```text
edict.   Tokenization, as code.                       Sandbox / Ethereum Sepolia
──────────────────────────────────────────────────────────────────────────────
Define the mandate                         Draft · In this page
Plan creation and review                    No manifest recorded

01  Asset intent                           │ DRAFT SUMMARY
    Asset name                             │ Asset          Not entered
    Symbol          Supply cap             │ Token type     RWA_TOKEN
    Documentation URL                      │ Supply cap     Not entered
                                           │
02  Signing authority                      │ AUTHORITY
    Tokenizer email                        │ Tokenizer      Not entered
    Required signer address                │ Signer         Not entered
                                           │
03  Investor allocation                    │ ALLOCATION
    Investor email                         │ Recipient      Not entered
    Recipient address                      │ Mint amount    Not entered
    Planned mint amount                    │
──────────────────────────────────────────────────────────────────────────────
Creates a recorded plan. No approval or execution.       Create execution plan
```

The artifact summary is sticky only while it fits within the viewport. Use document scrolling; avoid two competing vertical scrollers. Long identifiers wrap. The bottom action boundary stays in normal flow on desktop; a compact sticky action row may be used on narrow screens with reserved space and safe-area padding.

### Form organization and exact field semantics

| Section | Fields and placement | Reason |
| --- | --- | --- |
| Asset intent | Name full width; symbol and supply cap paired; documentation full width | Name is the human anchor; quantities stay adjacent; URLs need room |
| Signing authority | Tokenizer email then full-width required public signer address | Makes the identity/authority relationship explicit; does not imply a connected wallet |
| Investor allocation | Investor email, full-width recipient public address, mint amount | One recipient only; distinct email requirement adjacent to email |

Keep the exact nine manifest fields. “Signing authority” is a section label; preserve “Tokenizer” in labels because it is the implemented role. Network, schema version, and `RWA_TOKEN` are fixed metadata, not disabled dropdowns. Do not add valuation, jurisdiction, legal structure, decimals, multiple investors, file upload, gas preferences, or wallet connection to the mandate.

### Draft summary strategy

**DECISION — Accept the split-workspace hypothesis, with a provenance constraint.** The live side is a human-readable **Draft summary**, not a canonical manifest or execution plan. It copies entered strings, displays absence honestly, and never calculates identities or hashes. It has no success seal or “saved” label.

Run the existing validator locally for feedback and readiness. When the complete draft validates, “Ready to create a plan” means only that local validation passed. Do not continuously mutate the inputs to normalized values; users must retain their cursor and what they typed. After the server response, replace the draft summary with the **Recorded manifest** and expose material normalization changes using the retained in-memory input snapshot. The server result remains authoritative.

Do not add a JSON editor. Raw draft JSON adds duplication, encourages invalid incomplete objects, and makes the provisional artifact look executable. A pretty-printed normalized manifest is useful only after creation.

### Validation, completion, and CTA

Validate touched fields on blur and all fields on submit using `validateAssetManifestV1`; suppress unrelated required errors until submission. Revalidate dependent email and amount relationships when their inputs change. A single path-to-field map translates `asset.name`, `tokenizer.walletAddress`, and the other existing paths to stable DOM IDs. Map server issues only after validating their code/path shape; never render upstream messages.

Keep quantities as strings. No `type=number`, parsing through `Number`, scientific notation, automatic grouping inside editable fields, or new numerical cap. Names are measured after normalization in Unicode code points; HTML `maxLength` is not that policy. Existing transport limits and any input length guards must be documented separately, not presented as Brickken limits. Domains that accept trimmed addresses/names must not be blocked first by conflicting native patterns. Retain semantic input types, labels, required attributes and appropriate input modes; use application validation deliberately rather than mixed competing error systems.

Use descriptive completion such as “Investor allocation needs a mint amount.” Do not show a circular completion meter. The CTA remains operable on an incomplete draft so it can reveal actionable errors. Disable it only during a request or known API-disabled session. On successful creation focus the plan heading and announce “Plan recorded. Review the operations and required signer.” Never optimistically display a run.

## 7. Manifest and deterministic plan experience

**DECISION —** After creation, the main pane becomes the plan; the accompanying pane becomes the recorded manifest. The headline is the asset name, with “Execution plan” as context. The first viewport includes required signer, environment, plan identity, and the beginning of the operation sequence.

Render all seven operations as an ordered document. Rows 1/3/5 have the action name and “Wallet confirmation required”; rows 2/4/6 describe confirmation and read-back with lower visual weight but remain distinct numbered operations. Row 7 closes the plan with final verification. Never collapse three transaction/read pairs into three completed steps.

UI display names may become “Create tokenization,” “Confirm tokenization and read back,” “Whitelist investor,” “Confirm whitelist,” “Mint allocation,” “Confirm mint and balance,” and “Verify deployment.” Those labels live in a presentation map. Preserve the exact server `summary` as the recorded plan description because it participates in the plan hash.

The manifest is a semantic definition list organized into asset, authority, allocation, and fixed configuration. Show quantities in whole tokens. Show full addresses at authority decisions; a compact identifier elsewhere must expose the full value through selectable text/disclosure and Copy, not hover alone. Documentation remains safe text initially; any future link uses the validated HTTPS value without fetching previews.

“View manifest JSON” opens a text-only `<pre><code>` presentation of the validated server-normalized object. Label it “Normalized manifest JSON.” Pretty printing is not the exact canonical byte stream hashed by Edict. Do not claim canonical-byte export or provide a complete plan JSON export from today's narrowed plan projection. No client plan builder or hash computation is added.

Place manifest hash and plan hash with their respective artifacts, with complete values in details. Revision is a concurrency version of the run, **not a plan version or mandate edit count**. A refreshed higher revision with identical hashes means the record changed; it does not mean the plan changed.

No edit-in-place control for a recorded manifest. No “approve and deploy” button. The planning release ends with a clearly reviewable, durable record and honest availability information.

## 8. Approval and wallet experience

**Conditional design —** These screens are not enabled by the planning redesign. Approval needs an explicitly reviewed frontend composition even though its endpoints exist. Execution additionally needs missing gateway routes, semantic authorization, and independently authorized compatibility evidence.

### Approval boundary

Use an in-page authority section below the plan, not a small modal that obscures it. Keep chain, required signer, asset, cap, recipient, and mint amount visible. Copy: “Approve this exact plan with the required tokenizer wallet. Each transaction requires a separate wallet confirmation.” Primary action: **Approve this plan**. Do not call it Connect, Continue, or Deploy.

Selecting a wallet, allowing account access, switching chain, signing plan approval, and confirming each transaction are separate actions. Readiness checks use the existing session; the required signer may appear anywhere in the authorized account list. Do not substitute the first account.

The existing approval coordinator owns read → challenge → validation → signature → submit → durable reread. A future gateway adapter unwraps the HTTP envelope and delegates unchanged challenge fields. Do not reconstruct the RPC-ready typed-data string. Local UI may observe gateway request boundaries to display busy text; it must not insert a second signing flow or preissue a challenge on render.

Display the five-minute lifetime as a fact of the issued challenge only if the UI actually observes its timestamps. The existing coordinator has no separate challenge-preview screen; a countdown is optional, not grounds to alter it. No automatic challenge renewal or repeated signature requests. Expiry is not run failure.

Only the durable reread can establish “Approval recorded.” The ordinary run projection exposes a boolean, not approval timestamp, proof digest, or approved revision; do not fill those fields from local timers. A signature result alone is insufficient.

### Provider selection and session behavior

Use an inline radio list in the authority section. Show self-reported provider name and, if useful, reverse-DNS text as untrusted metadata. No wallet receives “recommended” or “verified” status from its name. Prefer text-only entries initially; do not inline untrusted SVG, use `dangerouslySetInnerHTML`, or fetch remote logos. Selection binds the existing stable provider reference/selection ID.

Late announcements append without stealing focus. Collisions invalidate eligibility and require explicit reselection/reinspection; do not silently pick another provider. Browser effects may subscribe/dispose discovery, but cannot request accounts, switch chain, sign, or send. Session disposal is not wallet disconnection or transaction cancellation.

On a chain/account event, use the coordinator's invalidation semantics. In particular, the existing switch method may invalidate its generation on `chainChanged`; show “Check wallet again” rather than weakening the generation check to complete a smooth flow.

### Transaction handoff

Before an operation's explicit wallet action, show operation, full signer, target, native value, and Sepolia. Separate token allocation from native transaction value and fee parameters. An advanced disclosure contains exact retained fields—calldata, nonce, gas, fee model, type, access list where present—and the relevant integrity identity. Do not edit, estimate, omit, round-trip through floating point, or default these fields for presentation convenience.

**Missing contract:** the current public run does not expose a prepared DTO. Moreover, `executePreparedTransactionFromUserAction()` records the durable prompt and then proceeds toward invocation; it is not a review-data loader. A future server-authorized read-only preview must derive from the same persisted prepared transaction and strict projection before the user acts. Validate that reviewed operation/revision/identity still matches when the existing coordinator runs. Do not create a durable prompt merely to populate a screen or pause its coordinator behind an unreviewed extra modal. Define that preview contract in the owning backend/wallet specifications before implementation.

The button names the operation: “Confirm tokenization in wallet,” then whitelist, then mint. No automatic next wallet prompt. During send, closing a panel cannot cancel a provider promise. All post-invocation errors follow the existing ambiguous-outcome path, including a returned `4001`.

## 9. Execution and reconciliation experience

**DECISION —** Reuse the seven-row plan as the execution record. Add truthful state text to the same operations instead of replacing it with a dashboard or animated transaction feed. Select the current operation's details beside the list on desktop; use a focused detail view on narrow screens.

Separate three clocks: persisted event time where exposed, server record `updatedAt`, and local last retrieval. Current public data only supplies the latter two. Do not stamp client arrival time onto operation milestones or build an invented event history.

There is no percentage, predicted block countdown, token-price panel, or “3 confirmations remaining” without evidence. A spinner means a local request is pending. A persisted `PENDING` stage receives quiet static text after the request ends. Reloading must not restart effects; future recovery reads state before deciding anything.

### Reconciliation surface

Use a persistent in-page section with three aligned groups:

| Group | Content |
| --- | --- |
| Known | Last accepted stage, operation, run ID, prepared ID or blockchain hash when returned |
| Unknown | Preparation response, broadcast outcome, durable hash handoff, transaction match, or finality—as supported by the actual result |
| Next safe action | Refresh record; copy available identifiers; obtain operator review through an existing human process |

Copy for ambiguous broadcast: “The wallet may have sent this transaction. Edict has not confirmed the outcome. Another submission is blocked.” Copy for confirmation timeout: “The confirmation check timed out. The recorded transaction may still complete.” Keep these meanings distinct.

Do not present “Retry transaction,” “Start again,” “Cancel blockchain transaction,” “Mark resolved,” or an in-app support submission. There is no reconciliation-resolution endpoint. An external operator investigation is not a frontend button. Any later resolution workflow requires its own authenticated transition contract.

The internal confirmation transport-failure path can return to a stored hash and reconfirm the identical pair. It is different from `RECONCILIATION_REQUIRED`, which blocks ordinary advancement. The UI does not broaden either category. “Refresh record” never promises a fresh Brickken/RPC lookup.

## 10. Verification and receipt experience

### Verification must show the scope of the claim

Use an evidence table with columns **Check / Requested / Observed / Result / Source and time**, but populate it only from a reviewed server evidence projection. Do not re-run verification in React or infer observed values by copying the manifest into both columns.

The current verifier checks:

| Operation | Implemented comparison | Presentational limit |
| --- | --- | --- |
| Tokenization | Name with `name`/`tokenName` fallback, symbol, token type, tokenizer email/wallet, supply cap, chain, tokenizer identity; adapter requires a nonzero token address | Documentation URL is not compared; do not mark it verified |
| Whitelist | Expected investor address, symbol, true whitelist flag, blockchain source | Do not equate whitelisting with regulatory/KYC approval |
| Mint | Integer raw balance against whole-token amount scaled by observed decimals, whitelist/source, investor wallet, token address agreement | Exact equality assumes a new investor with zero pre-mint balance; no delta-based existing-investor support |
| V3 transaction / receipt | Field equivalence, identical transaction hash, successful receipt, inclusion/finality evidence | Requires V3 evidence; unavailable in ordinary public projection |

Evidence: [`verifyReadBack()`](../src/server/orchestration/service.ts), [adapter](../src/server/brickken/adapter.ts), [V3 evidence](../src/server/execution/onchain-evidence.ts), and [core balance policy](CORE_DOMAIN_SPEC.md).

Current `ObservationRecord` does not preserve requested/observed values or detailed mismatch reasons. Until that data exists, render “Read-back matched” or “Verification failed” with available operation context; do not render an apparently populated comparison table. A missing observation is “Not available,” never zero, false, or a pass.

### Receipt boundary

**CODE OBSERVATION —** No deployment receipt type, unique receipt persistence, issue/read/download service, terminal `COMPLETE`, or receipt route exists. `TransactionReceiptEvidenceV1` is blockchain inclusion/finality evidence; it is not Edict's final deployment receipt.

**Conditional design —** The future deployment receipt is a restrained document with asset/run identity, approved manifest and plan references, public signer evidence appropriate for disclosure, the three operation hashes, recorded comparisons, final verification outcome, server issuance timestamp, receipt ID/hash/version, and explicit evidence limitations. Its design reuses the workspace grid. No shield, seal, confetti, certification language, or claim of legal validity.

“View receipt” and “Download receipt” appear only when an immutable server artifact exists and is authorized for this browser. Repeated downloads must serve that same artifact. A browser-generated JSON blob of the planning view is not a deployment receipt. Print styling may render the future receipt cleanly; PDF generation is not assumed.

`receiptEligible: true` earns “Final verification recorded,” not “Deployment receipt issued.” Partial success, timeout, cancellation, and mismatch preserve available record evidence without offering a success receipt.

## 11. Design system

**DECISION —** Build a small, Edict-owned set of tokens and semantic components. Retain React, Tailwind availability, and the existing system font stack. No UI kit, icon package, animation library, remote font request, or visual asset dependency is needed for the planning release.

### Typography and density

| Role | Proposed treatment | System rationale |
| --- | --- | --- |
| Task / asset title | 32px / 38px, weight 600, approximately -0.025em tracking; 28px on narrow screens | Task hierarchy without a landing-page hero |
| Section title | 20px / 28px, weight 600 | Distinguishes decision groups without adding containers |
| Body / editable values | 16px / 24px, weight 400 | Comfortable reading and mobile input behavior |
| Labels / operation title | 14px / 20px, weight 500–600 | Compact but readable, stronger than supporting detail |
| Metadata / help | 13px / 20px | Secondary hierarchy; no 10–11px critical information |
| Addresses / hashes / quantities | `ui-monospace`, 13–14px / 20px; tabular numerals | Exact characters and aligned integer comparisons |
| Section indexes | 12px / 20px, monospace, muted | Structural, noncritical annotations |

Use system sans consistently for prose and controls; monospace only for machine values. Long copy stays around 60–72 characters per line. Do not force all text into monospace, uppercase every heading, or use extremely tight line heights. Assess Windows/macOS font metrics during visual review before considering a separately licensed local typeface.

### Space, grid, shape

Use a 4px base: 4/8 for related inline content; 12/16 for control padding and label groups; 24 for related fields; 32 for columns; 48 for decision sections; 64 only for major page divisions. This scale expresses relationship: closer means more related. A 32px numbered gutter aligns sections and operations across screens.

Controls use 4px radius. Work regions and data tables use square edges. No large rounded parent containers. Default control height is 44–48px; text buttons keep a generous hit area without looking like filled buttons. Rules are 1px; selected/focus state may use a 2px stroke. No base shadows; overlays, if later necessary, receive only enough separation to identify their boundary.

### Color and surfaces

| Token role | Proposed value | Use |
| --- | --- | --- |
| Canvas | `#F4F3EF` | Outer page and quiet surrounding space |
| Record surface | `#FDFCF9` | Main readable work area; no texture |
| Primary text | `#202522` | Main content, primary button fill |
| Secondary text | `#59615C` | Supporting copy and metadata |
| Structural rule | `#C9CEC7` | Nonessential separators; not sole control boundary |
| Control boundary | `#788179` | Input outlines and essential boundaries |
| Interactive / focus | `#214FD0` | Focus ring, links, selected reading mode; no decorative flood fill |
| Recorded match | `#276348` | Scoped successful verification text plus explicit label |
| Attention / uncertainty | `#795510` | Unknown, timed out, reconciliation text with matching explanation |
| Failure | `#A13232` | Validation/terminal failure text with icon or label |

These choices keep chroma subordinate to content. Dark text anchors the workspace, blue identifies interaction, and state colors describe facts. Do not color every plan row green when created; a valid mandate is not a verified deployment. Cancellation is neutral, not a red system failure.

Local sRGB contrast calculations for the proposed pairs: primary text on record surface 15.17:1, secondary 6.22:1, interactive 6.62:1, success 6.90:1, attention 6.56:1, failure 6.78:1; control boundary 3.93:1. On canvas, these text roles remain above 5.7:1 and the control boundary is 3.63:1. These are token calculations, not a completed accessibility audit; actual hover, focus, disabled, selection, and overlay combinations need browser checks. Never use the structural rule for a required 3:1 control edge.

### Controls and information presentation

| Element | Behavior / treatment |
| --- | --- |
| Primary button | Near-black fill, light text, one per active decision; sentence case, action-specific verb |
| Secondary button | Plain surface with control outline; Refresh record is visually quieter than creating/authorizing |
| Destructive action | Text-led Cancel run, not adjacent equal-weight primary action; inline confirmation names the run and legal effect |
| Input | Visible label above, value dominant, associated hint/error below; no floating labels or placeholder-only fields |
| Validation | Error text identifies correction; failure border supplements text; reserve reasonable message space without fixed clipping |
| Definition list | Label/value alignment for manifest and identity; no per-field card |
| Operation list | Ordered semantic list with thin rules, number, title, recorded summary, mode/state; stable order |
| Comparison table | Real table for cross-row comparison on desktop; labelled per-check definition lists on mobile when necessary |
| Structured data | Text-only escaped JSON; restrained syntax treatment or plain text; wrap toggle/contained horizontal scroll; no fake terminal frame |
| Copy | Copies full accepted string; localized polite success/failure; never copies capability, challenge, or raw security payload |
| Icons | Only copy, disclosure, external-link, and explicit state marks if useful; simple inline SVG owned by Edict, decorative icons hidden from assistive tech |

### Motion

Use 100–140ms color/focus feedback and at most 160–180ms opacity transitions for a newly accepted artifact or expanded detail. Keep content positions stable. No counting hashes, typing code, simulated construction, pulsing blockchain path, animated progress, or automatic scrolling on background refresh. Focus moves only for meaningful user-triggered transitions and errors. Under reduced motion, state changes are immediate; text and live-region announcements carry the same information.

## 12. Responsive strategy

Breakpoints are content thresholds to validate, not device detection. Preserve one data source and one form instance across modes.

| Width | Layout and priority |
| --- | --- |
| Large desktop, ≥1440px | Centered maximum 1280px workspace; edit/plan and artifact side by side; numbered gutter; summary sticky only if it fits |
| Laptop, 1100–1439px | 32px outer gutters, approximately 3:2 columns, narrower internal spacing; authority addresses still full-width within their section |
| Tablet, 768–1099px | One active main pane with explicit Mandate / Draft summary or Plan / Manifest / Record details navigation; compact persistent context; do not append the entire secondary artifact below the form |
| Narrow, <768px, including 320px | 16px outer gutters; one reading mode; form sections progressively disclosed with completion text; compact run context and visible state; action row respects safe area and keyboard |

Mobile form sections expand independently. The first incomplete section begins open; on errors open and focus the affected section before bringing a field into view. Switching to Draft summary preserves all values, touched state, focus return target, and section expansion. In summary mode show “Return to mandate” rather than a submit action attached to a hidden invalid form.

On recorded mobile views, the Plan tab shows the ordered operations with per-operation disclosure. Manifest and identity are alternate panes, not a second endless list beneath it. The selected operation shows stage and full identifiers; other rows stay compact. Never horizontally scroll the whole page to reveal a wallet action. Only code/table detail may use a labelled local horizontal scroller.

At 200% zoom the layout should switch to a single reading mode; at 400% zoom/reflow it must remain usable at an equivalent 320px width. With short landscape heights or a software keyboard, release sticky elements that would obscure the focused field or authority copy. No desktop/mobile duplicate input trees, duplicate IDs, or CSS-reordered keyboard flow.

Injected provider availability determines mobile wallet capability. Do not imply a desktop extension is usable on a phone; no WalletConnect, QR, universal link, or cross-device handoff exists in this repository.

## 13. Accessibility strategy

**DECISION —** Preserve the existing semantic baseline and verify behavior in a real browser before release.

- Keep one main landmark, one primary heading, logical heading order, skip link, semantic form/fieldset/legend, and associated labels. Run metadata uses definition lists; operations use an ordered list.
- Use native controls for disclosure and selection where possible. If reading modes are ARIA tabs, implement arrow/Home/End navigation, selected state, associated tabpanel, and focus behavior together. Otherwise use ordinary buttons/links with explicit current state; do not partially implement tabs.
- Use a visible 2px focus ring with separation from the component boundary. Sticky headers and footers must not obscure focus; use appropriate scroll margins.
- On submit failure, focus the error summary and provide links to each field. Use `aria-invalid` and `aria-describedby` for current errors; do not announce every keystroke or the entire live summary.
- Use one polite status region for request/record changes. Critical failures get one alert. Avoid duplicated announcements from a banner plus identical inline live region.
- Preserve input values and focus through refresh failures and responsive mode changes. On a new accepted plan move focus to its heading; on polling/status updates leave focus alone.
- Provide full identifiers without hover, keyboard-accessible Copy, selectable fallback, and textual copy failure. Truncation must not hide authority-critical distinctions.
- Maintain readable contrast across states, touch targets near 44px, color-independent status text, reduced-motion support, and forced-colors usability. Do not lower disabled text opacity until it becomes unreadable.
- Local cancellation confirmation should remain inline with clear Confirm cancellation / Keep run actions and predictable focus return. An additional transaction confirmation must never be used to replace wallet confirmation.

## 14. Component architecture

**DECISION —** Retain the existing planning controller as the command boundary. Extract presentation by responsibility, not one generic component for every row. Do not install a global store, query cache with mutation retries, form framework, or generalized workflow engine.

```text
Server layout + page (metadata and composition)
  RunPlanningWorkspace (one stable controller / in-memory draft owner)
    WorkspaceHeader + RecordStatus
    ReadingModeNavigation
    MandateForm ─────── DraftSummary
    PlanDocument ───── ManifestRecord
    RecordDetails + RecordActions
    FeedbackRegion

Browser command boundary: existing run-planning.ts
  create / refresh / cancel → existing HTTP endpoints
  validated public data → pure presentation functions

Conditional later islands, independently gated:
  ApprovalSection → existing approval coordinator + reviewed HTTP gateway
  ExecutionRecord → authorized public execution projection
  TransactionHandoff → reviewed preview + existing transaction coordinator
  EvidenceRecord / DeploymentReceipt → future evidence and receipt DTOs
```

### Ownership rules

| Layer | Owns | Must not own |
| --- | --- | --- |
| Server shell | Metadata, styles, static framing | Reading secret config to serialize into client props; eager runtime construction |
| Workspace controller | One pending command, last accepted record, safe errors, stale reread, submit input snapshot | Hash generation, auto-execution, provider selection, persistence replacement |
| Draft/form state | Raw strings, touched/errors, section/mode selection; memory only | A new normalized-manifest authority, persisted “saved” status |
| Pure presentation | Human labels, exact string formatting, state precedence, allowable UI visibility | Domain transitions, independent verification, arbitrary action derivation |
| HTTP projection | Allowlisted public fields with runtime validation and same-origin transport | Deserializing the full run snapshot into browser memory |
| Existing wallet modules | Stable provider, generation/readiness, validation, exact signing/send ordering | UI styling or speculative progress |

Presentational components under the client workspace remain in its client graph even without their own `use client` directive. Do not claim they become server components merely by moving files. Keep `page.tsx`/`layout.tsx` server components; do not attempt to send provider objects, capabilities, callbacks, or security services across that boundary.

### Retain, refactor, replace

Retain `createPlanningWorkspace`, `creationRequest`, and `readProjection` semantics; add only bounded UI-facing fields/errors and local retrieval state as specified. Preserve request serialization, monotonic revision/identity checks, cancellation reread, no-store, redirect refusal, and no implicit retry.

Refactor `RunPlanningWorkspace` into a thin composition/focus owner. Extract `Field` with path-aware error support; retain `Detail`'s semantic definition-list behavior and `CopyValue`'s safe clipboard fallback. Replace `PlanReview`'s long stacked sections with plan/artifact reading modes. Replace global visual styles with tokens plus scoped workspace styles; retain skip/focus/reduced-motion behavior.

Preserve all core, approval, wallet-intent, provider, adapter, execution, persistence, and origin/security implementations. Any discovered defect in them requires separate review; it is not silently corrected during component extraction.

## 15. File-level implementation plan

Every path below is a proposed change after approval. This task creates only this document. **P** denotes the planning release; **C** denotes conditional lifecycle work after separate prerequisites. Paths for unavailable backend services are intentionally not invented as though their contracts were approved.

### Planning release files

| File | Action | Purpose and reason |
| --- | --- | --- |
| `src/app/layout.tsx` | Review/update P | Retain server metadata and document semantics; attach any agreed global theme class without runtime config exposure |
| `src/app/page.tsx` | Review P | Keep the single workspace composition; no new user route or server data fetch |
| `src/app/globals.css` | Change P | Replace broad visual rules with reset, global typography, focus/selection, token import; prevent generic `main`, `fieldset`, and button rules leaking across later surfaces |
| `src/app/tokens.css` | Add P | Role-based color/type/space/shape/motion variables; one maintained vocabulary |
| `src/components/run-planning-workspace.tsx` | Change P | Thin client composition, stable controller, in-memory draft snapshot and reading modes, focus orchestration |
| `src/components/run-planning.ts` | Change P | Preserve transport/guards; retain validated operation stage/version/eligibility for truthful read-only status, recognized validation issues, error codes, last successful retrieval time |
| `src/components/run-planning.test.ts` | Change P | Preserve request/projection/duplicate/stale/cancel/import tests; adapt expected projection fields deliberately, not by deleting security assertions |
| `src/components/planning/workspace.module.css` | Add P | Scoped grid, panes, operation rows, field layout, responsive/print rules; one style file initially |
| `src/components/planning/workspace-header.tsx` | Add P | Brand, fixed environment, run context, reading-mode navigation; no wallet logic |
| `src/components/planning/mandate-form.tsx` | Add P | Exact nine-field form, responsive section disclosure, shared validator feedback |
| `src/components/planning/form-field.tsx` | Add P | Stable label/hint/error associations and consistent control treatment |
| `src/components/planning/draft-summary.tsx` | Add P | Provisional entered values and readiness; never persisted or hashed |
| `src/components/planning/manifest-record.tsx` | Add P | Server-normalized definition list and safe JSON disclosure |
| `src/components/planning/plan-document.tsx` | Add P | Seven immutable plan rows, UI label map, server summaries, provenance/identity |
| `src/components/planning/record-details.tsx` | Add P | Public IDs, versions, revision, timestamps and operation facts; no internal event timeline |
| `src/components/planning/record-actions.tsx` | Add P | Refresh and server-legal cancellation with inline confirmation; forwards commands only |
| `src/components/planning/record-status.tsx` | Add P | Outcome/ambiguity precedence and current availability, explicit eligibility distinction |
| `src/components/planning/copy-value.tsx` | Add P | Reused full-string Copy/disclosure/fallback; avoids duplicate logic |
| `src/components/planning/feedback-region.tsx` | Add P | Focused validation summary and singular status/alert behavior |
| `src/components/planning/presentation.ts` | Add P | Pure label mapping, stable manifest-path mapping, display-state derivation; no side effects or security decision authority |
| `src/components/planning/presentation.test.ts` | Add P | Meaningful cases for all state precedence, integer precision, unknown input refusal, and error-path mapping |
| `src/components/planning/boundary.test.ts` | Add P | Recursively cover extracted UI modules; prove route/import/storage restrictions cannot be evaded by moving code |
| `package.json`, `package-lock.json` | Change P, testing only | Add reviewed development-only browser/accessibility tooling and explicit UI test script; no runtime design dependencies or broad upgrades |
| `playwright.config.ts` | Add P | Isolated local UI test runner, viewport matrix, deterministic screenshots; no live credentials |
| `tests/ui/planning.spec.ts` | Add P | Form, server-response, refresh, cancellation/conflict, reading-mode/focus/reflow tests using controlled public HTTP fixtures |
| `tests/ui/accessibility.spec.ts` | Add P | Automated accessibility checks plus keyboard assertions for major states |
| `tests/ui/fixtures/planning.ts` | Add P | Test-only public response factories grounded in existing domain/test fixtures; unmistakably not live blockchain evidence |
| `tests/ui/__screenshots__/` | Add P | Named reviewed snapshots for empty, error, plan, cancellation, disabled, and long-content cases at agreed widths |
| `README.md` | Change P | Describe new UI behavior and retained page-memory limitation accurately |
| `docs/MVP_IMPLEMENTATION_PLAN.md` | Change P | Record frontend sequencing/acceptance and the continued execution stop boundary |
| `docs/EDICT_PRODUCT_UI_REDESIGN_PLAN.md` | Update on review | Record approved decisions, actual validation evidence and any scoped deviations |

Runtime projection expansion must validate operation kind/order/stage and identifier shapes, retain existing identity checks, and discard unapproved fields. It grants no new mutation permission. Do not expose raw unsigned transactions to make the table easier to fill.

### Conditional frontend files and prerequisite ownership

| Expected file | Purpose / reason | Prerequisite |
| --- | --- | --- |
| `src/components/approval/approval-section.tsx` | Exact authority review and approval result | Explicit approval-UI activation scope |
| `src/components/approval/wallet-selection.tsx` | Provider list, account and chain readiness | Existing boundary integration and lifecycle tests |
| `src/client/run-api/approval-gateway.ts` | Strict HTTP adapter for existing `ApprovalGateway` | Preserve challenge bytes, safe envelopes, durable reread |
| `src/client/run-api/approval-gateway.test.ts` | Bind actual route shapes to coordinator contract | Offline injected HTTP/provider tests |
| `tests/ui/approval.spec.ts` | User-action, expiry, rejection and invalidation UX | No real provider requests; explicit test doubles |
| `src/components/execution/execution-record.tsx` | Operation status and reconciliation view | Reviewed public execution projection |
| `src/components/execution/transaction-handoff.tsx` | Exact prepared transaction review | Authorized preview contract before durable prompt, plus production execution gateway |
| `src/client/run-api/execution-gateway.ts` | Implements existing injected `ExecutionGateway` with reviewed routes | Separate backend/API/security work; no guessed endpoint implementation |
| `src/client/run-api/execution-gateway.test.ts` | HTTP-to-coordinator ordering and failure tests | Durable prompt/hash contracts approved |
| `tests/ui/execution.spec.ts` | Prompt lock, ambiguous results, same-hash recovery UI | Offline state fixtures and separately reviewed execution scope |
| `src/components/evidence/evidence-record.tsx` | Recorded comparisons and provenance | Persisted allowlisted comparison evidence and public DTO |
| `src/components/evidence/deployment-receipt.tsx` | Immutable receipt view and server download link | Receipt schema, uniqueness, issuance and authorized retrieval |
| `tests/ui/evidence.spec.ts` | Scope of verification claims, missing evidence, immutable receipt rendering | Approved DTOs; no manufactured observed facts |
| `src/components/run-planning-workspace.tsx` | Mount conditional surfaces when allowed | Separate activation review; no hidden experimental controls |
| `src/components/planning/workspace.module.css` | Reuse grid/states and add conditional screen styles | Avoid parallel design systems |

Before any conditional backend implementation, update the affected owners together: `docs/RUN_API_SPEC.md` for public DTOs/routes; `docs/WALLET_EXECUTION_SPEC.md` for preview/coordinator composition; `docs/ARCHITECTURE.md` for evidence/receipt/resume semantics; `docs/BRICKKEN_INTEGRATION_SPEC.md` only for supported external contract changes; `docs/MVP_IMPLEMENTATION_PLAN.md` for sequence and gates. Concrete backend files, migrations and tests belong to that separately reviewed plan, not this frontend redesign's implied scope.

No planning change to `.env.example`, Next security/runtime configuration, core domain, adapter, persistence, existing API routes, or operator harness is expected. No application dependencies are installed by this proposal.

## 16. Risk analysis

| Apparently harmless change | Invariant at risk | Required control |
| --- | --- | --- |
| Rewrite plan summary copy | Summary is hashed plan content | UI label map only; golden hashes unchanged |
| Live “canonical plan” sidebar | Browser acquires false artifact authority | Provisional summary; server-returned manifest/plan identities only |
| Cast public response to full run | Snapshot/security fields enter browser; malformed states trusted | Runtime allowlisted projection, no server imports |
| Auto-fetch on mount to improve readiness | Config/runtime construction or external effects occur without intended action | Planning mount stays network/provider-free; no health-call invention |
| Add wallet manager to global layout | Automatic provider choice/account prompt; remount duplicates listeners | Conditional client island; explicit selection; stable session lifecycle |
| Generic mutation retries | Duplicate prepare, send, or cancellation intent | Preserve synchronous guard and CAS; no auto-retry wrapper |
| Show modal by invoking transaction coordinator | Durable prompt acquired before review; accidental send | Reviewed preview contract; coordinator invoked only at intended user boundary |
| Treat wallet `4001` as always canceled | Broadcast ambiguity lost, second send possible | Preserve post-invocation unknown classification |
| Rebuild transaction for attractive fee display | Signing fields changed or absent/zero conflated | Read-only formatting alongside exact frozen DTO; no enrichment |
| Pick first connected account | Required signer silently changed | Existing readiness accepts exact required address among authorized accounts |
| Suppress chain-generation errors | Chain/account race becomes actionable | Preserve invalidation and explicit reinspection |
| Green `SUCCEEDED` screen | Final verification/receipt falsely implied | Eligibility and evidence-aware labels; never receipt issuance from a boolean |
| Reuse chain receipt as deployment receipt | Evidence scope overstated | Separate artifact names and future issuance contract |
| Cancel whenever hash is absent | Reconciliation or terminal state bypassed | Existing `canCancel` semantics plus server authority; future execution UX must also respect active prompt uncertainty |
| Rename refresh to Resume | Read-only GET falsely promises progress | “Refresh record”; authorized execution polling remains separate |
| Add run URL or browser cache | Access token leakage; false cross-tab/resume promise | No capability in URL/storage; fresh-load manifest/access contract required |
| Add Create another / duplicate mandate | Replaces active capability; can encourage repeated effects | Exclude from current active run; separately design replacement semantics |
| Numerical convenience formatting | Quantity precision lost | String representation; exact integer arithmetic only where already defined |
| UI age timer declares timeout | Browser manufactures persisted run state | Timers label local wait only; server owns timeout status |
| Tooltip-only exact address | User cannot inspect what they authorize | Full visible authority values and accessible copy/disclosure |
| Snapshot tests after moving files | Old static boundary tests no longer scan actual code | Expand recursive coverage; preserve behavioral and route assertions |
| “Download evidence” from current DTO | Missing observations represented as complete proof | No receipt/export claim until proper artifact exists |

**DECISION —** A planning UI can be production-quality within its supported scope while execution remains unavailable. Enabling execution is not a styling acceptance criterion and must never be used to justify relaxing a gate.

## 17. Implementation phases

Use small reviewable increments. The three-day core constraint favors a polished planning release before conditional features; it does not justify compressing unverified execution into the UI work.

| Phase | Work | Exit criterion |
| --- | --- | --- |
| 0 — Review this plan | Confirm visual direction, scope split, terminology, state matrix | Explicit approval before application code changes |
| 1 — Presentation foundation | Tokens, scoped styles, shell, extraction while retaining controller | Same current requests, same route inventory, unchanged core/security behavior; representative desktop and mobile frames reviewed |
| 2 — Mandate and artifacts | Form hierarchy, draft summary, validation paths, plan/manifest modes | Invalid drafts send nothing; valid drafts display server-returned values/hashes; keyboard and narrow-screen flows work |
| 3 — Record states and recovery | Public operation projection, status precedence, refresh/cancel/conflict/disabled/error treatment | No optimistic mutation, no fake progress, canceled and stale states truthful; planning release review |
| 4 — Craft and regression | Typography, long identifiers, short heights, accessibility, visual snapshots, production bundle checks | All planning validation gates pass; document real limitations |
| C1 — Approval integration | Separate approved wallet/approval gateway work | Offline tests pass; explicit scope/compatibility gates before actual wallet activity |
| C2 — Execution integration | Only after reviewed preview, gateway, semantic policy, persistence and evidence prerequisites | Durable ordering, ambiguity behavior and supported live evidence independently established |
| C3 — Evidence and receipt | Only after stored comparisons, immutable receipt and access contracts | Every rendered claim traceable to persisted evidence; no success artifact for partial/failed runs |

**ASSUMPTION —** Planning phases 1–4 can fit approximately three focused frontend build days after review using the existing controller and no new runtime dependencies. Browser test setup and edge-state review are included; conditional lifecycle work is not. If time is constrained, defer normalization-difference highlighting and visual motion before deferring error, responsive, or authority correctness.

## 18. Validation plan

### Assessment evidence from this task

Read all eight existing foundation/phase documents, current routes/layout/styles/components, domain and run types, actual transitions, API projections/handlers, persistence schemas, wallet approval/intent/provider coordinators, adapter boundaries, and relevant tests. Configuration inspection was limited to documented names/consumers; runtime environment values were not read or printed.

Ran the following offline baseline on 2026-09-08:

```sh
npm run test -- src/components/run-planning.test.ts src/server/execution/transitions.test.ts src/server/execution/execution-v3.test.ts src/server/orchestration/service.test.ts src/server/orchestration/wallet-intent.test.ts src/client/wallet src/server/run-api src/server/persistence/codec.test.ts
```

Result: **15 test files passed, 188 tests passed**. This establishes the selected existing behavior, including static initial rendering; it is not browser accessibility, wallet compatibility, live sandbox, or full application validation. No code was implemented. Lint, typecheck, full suite, production build, and browser checks were not run for this document-only change. A pre-existing modification to `next-env.d.ts` was left untouched.

### Required checks for the future implementation

| Gate | Command / method | Acceptance |
| --- | --- | --- |
| Lint | `npm run lint` | No new warnings/errors or boundary exceptions |
| Typecheck | `npm run typecheck` | Strict compilation passes; no cast-based bypasses of public DTO validation |
| Offline tests | `npm run test` | Existing domain/golden/transition/CAS/provider/security tests and new presentation tests pass |
| Production build | `npm run build` in an isolated credential-free build environment | Root page plus existing five API routes for planning release; no new network/runtime dependency |
| Harness isolation | `npm run check:phase8-harness`, relevant boundary suites | Production still excludes `tools/phase8-harness` |
| Browser suite | Proposed `npm run test:ui` | Actual form, reading-mode, focus, clipboard, refresh, errors, cancellation and layout behavior pass |
| Accessibility | Proposed browser axe checks plus keyboard and VoiceOver/NVDA review | No serious/critical automated violations; manual focus/order/announcement checks complete |
| Responsive | 320, 390, 768, 1024, 1280, 1440, 1920px; short landscape height; zoom/reflow | No obscured authority action, document overflow, lost draft, clipped values or competing scroll areas |
| Client artifact audit | `npm run audit:phase8-client-bundle` plus reviewed coverage of new UI | Synthetic credential and forbidden names absent from browser artifacts; exact route inventory maintained |
| Visual review | Deterministic screenshot comparison with agreed browser/font environment | Hierarchy, alignment, spacing, focus, errors and long-content layouts reviewed—not merely snapshot accepted |

The existing artifact audit copies tracked files only. Newly added UI files must be included in the intended tracked source snapshot before that audit counts as evidence; do not report it as validating untracked components. Build/serve tests should use a temporary credential-free source copy excluding runtime `.env` files, with only loopback browser traffic and controlled route fixtures. Test responses are explicitly synthetic public application states, never presented as verified Brickken outcomes. No production mock API routes are added.

### Required scenario assertions

1. Empty/partial/invalid drafts retain input; Unicode normalization, lowercase symbols, distinct emails, same allowed wallet address, HTTPS credentials refusal, leading-zero quantities, large integer strings, and mint/cap relationships use unchanged domain rules.
2. Submission is single-flight, carries only the manifest, and displays exactly server-returned normalized values/identities. Server issue paths connect to the correct visible field.
3. Create/refresh/cancel network or malformed responses retain last confirmed facts. Cancellation uses displayed revision; conflicts reread once without replaying the mutation; failed reread does not claim cancellation.
4. Terminal `CANCELLED` is not displayed as generic failure; reconciliation blocks actions; nonterminal timeout is not failed; confirmed is not verified; eligibility is not issued receipt.
5. Plan order and seven recorded summaries remain unchanged. Golden manifest and plan hashes pass existing fixtures. Public projection expansion does not expose internal events, signature proof, unsigned transaction, capability or upstream error strings.
6. Mount, hydration, tab switches, form edits, copy, and responsive reflow call no wallet, Brickken, RPC, or database action. Planning release continues to use only its three permitted endpoints.
7. On narrow screens, errors open the relevant section/pane, action rows clear the software keyboard, values survive mode changes, and full signer/recipient/hash can be inspected without hover.
8. Conditional approval tests preserve exact challenge string, freshness/revision binding, explicit provider/account/chain actions, and durable reread. Approval POST/read failures never become a local approved flag.
9. Conditional execution tests cover two tabs, remounts, durable prompt before send, zero-send pre-invocation failures, post-invocation `4001`, timeout, malformed/zero hash, provider change, failed hash handoff, same-pair confirmation, and no replacement send.
10. Conditional evidence tests refuse to infer V3 finality for V1/V2, retain included versus finalized, fail closed on mismatch, and distinguish final verification from immutable receipt issuance.

Authenticated sandbox tests, live database tests, migration application, operator harness actions, real wallet signatures, RPC lookups and broadcasts remain separately authorized work. They are not necessary to validate this planning redesign.

## 19. Open questions

Only unresolved inputs are listed here. Layout, terminology, token scale, navigation, and component ownership are recommendations above, not questions delegated back to the user.

| OPEN QUESTION | Why inspection cannot answer it | Recommendation until resolved |
| --- | --- | --- |
| Who is the first real operator: tokenizer principal or staff preparing a mandate for someone else? | Repository defines a signer and a capability, not organizational roles or delegation | Design one operator with the required tokenizer wallet; no approval delegation or collaboration UI |
| Are there established licensed brand fonts or identity assets outside this repository? | No dedicated font/brand asset system was found | Use proposed system typography and existing wordmark; do not block planning implementation on procurement |
| Is reload/cross-session recovery a launch requirement? | Current page-memory and GET omission are clear; launch expectations are external | Keep the limitation explicit; if required, prioritize a separate manifest/access recovery contract before promising run links |
| What evidence must an issued receipt disclose, and to whom? | No receipt DTO, retention policy, or sharing authorization exists | Private same-capability view only in the future; no public sharing, signature exposure, or email inclusion by default |
| Which exact wallet/version and Brickken account-backed flow will be authorized and shown compatible? | Offline fixtures cannot establish licensing, credits, chain behavior, prepare compatibility or finality | Keep execution disabled; use the existing integration and operator evidence gates |

Known missing capabilities—execution routes, prepared preview, detailed comparison storage/projection, reconciliation resolution, and receipt issuance—are dependency gaps documented above, not unexplained design questions. Approval of this document should authorize a defined planning release; conditional lifecycle activation requires its own concrete review.
