# Edict agent instructions

## Product and fixed scope

- **DECISION** — Edict is “Tokenization, as code”: a deterministic orchestration and verification layer over Brickken's sandbox Dapp API.
- **DECISION** — The locked MVP flow is: manifest/form → validation → execution plan → approval → tokenization → transaction tracking → investor whitelist → mint → read-back verification → deployment receipt.
- **DECISION** — Phase 0 contains verified integration discovery and architecture only. Do not scaffold the application, install application dependencies, create UI components, or implement feature or mock API code during this phase.
- **DECISION** — Do not expand the MVP into natural-language asset creation, autonomous decision-making, production/mainnet support, multi-agent orchestration, secondary markets, portfolio management, or elaborate compliance automation.
- **DECISION** — Prefer the smallest implementation that can be completed and demonstrated in three core build days.

## Security rules

- **DECISION** — Use Brickken sandbox only. Production and mainnet endpoints are out of scope.
- **DECISION** — `BRICKKEN_API_KEY` is server-only. Never expose it through a `NEXT_PUBLIC_*` variable, client bundle, browser storage, log, error payload, fixture, screenshot, or source control.
- **DECISION** — Edict must never request, receive, read, store, log, or fabricate a private key or seed phrase.
- **DECISION** — The connected browser wallet owns signing and broadcasting. Edict persists only public wallet addresses, prepared transaction metadata, transaction IDs, and blockchain hashes.
- **DECISION** — Require an explicit approval for the immutable execution plan and a separate explicit wallet confirmation for each on-chain operation.
- **DECISION** — Before every wallet prompt, compare the prepared transaction's chain, sender, target, value, and operation against the approved plan. Refuse mismatches.
- **DECISION** — Once a transaction hash exists, poll or reconcile that transaction. Never prepare, sign, or broadcast a replacement automatically.
- **DECISION** — Never print environment values. Secret checks may inspect variable names, tracked-file patterns, and placeholder quality only.

## Source-of-truth policy

- **DECISION** — Brickken-specific claims may be marked `VERIFIED` only when accompanied by a precise URL from `https://docs.brickken.com`, an official `github.com/Brickken/*` repository, or official npm metadata for `brickken-sdk`.
- **DECISION** — Live sandbox observations may be marked `VERIFIED` only when the exact unauthenticated request, sanitized response, and check date are recorded.
- **DECISION** — Label project choices `DECISION`, deductions not directly guaranteed by a source `ASSUMPTION`, and unverified or conflicting behavior `OPEN QUESTION`.
- **DECISION** — If official sources conflict, retain both claims and gate implementation on a sandbox contract test; do not silently choose one.
- **DECISION** — Never treat examples, mocks, generated placeholder addresses, third-party packages, or third-party skills as proof of Brickken behavior.
- **VERIFIED** — The current integration contract and source links are maintained in `docs/BRICKKEN_INTEGRATION_SPEC.md`.

## Ownership rules

- **DECISION** — `docs/BRICKKEN_INTEGRATION_SPEC.md` owns external API facts, source citations, wire shapes, conflicts, and unresolved Brickken questions.
- **DECISION** — `docs/ARCHITECTURE.md` owns Edict trust boundaries, components, persistence, state machine, signing flow, and verification gates.
- **DECISION** — `docs/MVP_IMPLEMENTATION_PLAN.md` owns sequencing, acceptance criteria, traceability, and model/task recommendations.
- **DECISION** — `.env.example` owns the approved configuration-variable names; add a variable only with a documented consumer and never with a secret-looking value.
- **DECISION** — A future code owner may refine an owned area, but any change to the locked flow, trust boundary, or Brickken contract requires updating all affected foundation documents in the same change.

## Testing expectations

- **DECISION** — Unit-test manifest validation, canonicalization, plan hashing, state transitions, retry classification, and requested-versus-observed verification without network access.
- **DECISION** — Contract-test every Brickken request and response against local runtime schemas; SDK TypeScript types alone are not sufficient.
- **DECISION** — Test refresh/resume from every persisted transaction stage, especially after wallet broadcast but before Brickken reconciliation.
- **DECISION** — Test that pending transactions are polled and never resubmitted, that rejected or timed-out runs cannot produce receipts, and that mismatched read-back fails closed.
- **DECISION** — Keep authenticated sandbox tests opt-in and never run them unless a human explicitly authorizes the call and supplies credentials outside logs and source control.
- **DECISION** — Add secret scanning and a client-bundle assertion that `BRICKKEN_API_KEY` and its value cannot appear in public artifacts.

