# Edict MVP implementation plan

## Planning constraints

- **DECISION** — Start implementation only after Phase 0 review approves the open-question gates.
- **DECISION** — Fit the demonstrable core into three build days; treat visual polish as routine work after the verified integration path passes.
- **DECISION** — Every task must preserve the locked flow and the server-only credential/browser-wallet boundary.
- **DECISION** — “Done” means tested evidence, not a mocked green path that resembles Brickken behavior.

## Core integration tasks, ordered by dependency

| Order | Owner recommendation | Task | Acceptance evidence |
| --- | --- | --- | --- |
| DECISION — 1 | Codex | Scaffold the minimal Next.js/TypeScript project after review; configure strict TypeScript, Vitest, linting, server-only boundaries, and the pinned SDK version. | Build/test commands pass; no UI feature code; lockfile pins `brickken-sdk@0.2.1`. |
| DECISION — 2 | Codex | **Complete** — Implement versioned manifest schema, canonical JSON, manifest hash, deterministic execution-plan builder, plan hash, and validation errors. See [`CORE_DOMAIN_SPEC.md`](CORE_DOMAIN_SPEC.md). | Golden tests prove identical inputs yield identical plans/hashes and invalid manifests make no network calls; the full production build passed outside the restricted agent sandbox. |
| DECISION — 3 | Grok | **Complete** — Adversarially reviewed the Brickken wire contract and produced sourced test vectors. See [`BRICKKEN_WIRE_CONTRACT_AUDIT.md`](BRICKKEN_WIRE_CONTRACT_AUDIT.md) and `src/server/brickken/test-vectors/`. | Review cites only official documentation, pinned `brickken-sdk@0.2.1`, official Postman, official npm metadata, and recorded unauthenticated checks; disputed claims are fixtures or omitted gaps, not guessed adapter code. |
| DECISION — 4 | Codex | **Complete** — Implement the application-owned repository interface, in-memory test implementation, pure state-transition function, and optimistic concurrency. Phase 5 adds the bounded durable Neon/Drizzle implementation behind the same interface. | Transition tests reject illegal skips and replayed broadcasts; offline persistence tests prove strict snapshot validation and atomic compare-and-swap behavior. The Neon migration and opt-in create/read/CAS/stale-conflict/cleanup test passed on 2026-09-04. |
| DECISION — 5 | Codex | **Complete** — Build `brickken.server` around pinned SDK prepare/read/status/send methods with sandbox URL allowlist, runtime response schemas, safe errors, and single-attempt prepare policy. | Injected-fetch contract tests cover exact request behavior without exposing the key. An opt-in authenticated network-info read passed; no write was attempted. |
| DECISION — 6 | Gemini | **Complete** — The Phase 3 wire-contract audit and Phase 4 adapter review compare runtime schemas/examples to official sources and preserve remaining write-contract uncertainty as open questions. | Every retained discrepancy links to an official source or remains explicitly unverified; no live-write shape is guessed. |
| DECISION — 7 | Codex | **Complete for the Phase 6 public surface** — Implement deny-by-default same-origin create/read/approval/cancel APIs and internal durable orchestration guards. External-effect methods remain internal and use injected behavior while writes are disabled. | Offline tests prove capability/approval integrity, revision CAS, double write gates, one prepare winner, durable prepared data, ambiguity blocking, and absence of public external-effect routes. |
| DECISION — 8 | Codex | **Complete offline in Phase 7** — Implement the vendor-neutral browser wallet boundary for Sepolia `client-broadcast`, prepared-transaction normalization, canonical intent comparison, explicit chain switching, and durable hash handoff. | Injected fake-provider tests prove API-key absence, explicit provider choice, exact signer/chain checks, strict retained fields, pre-invocation zero-send behavior, and post-invocation reconciliation. No named wallet or live write is verified. |
| DECISION — 9 | Codex | **Complete offline in Phase 8** — Harden adversarial wallet/provider behavior, add exact trusted-RPC transaction and receipt evidence in `ExecutionRunV3`, and isolate a deny-by-default one-action compatibility harness from production. | Offline tests cover post-invocation ambiguity, provider mutation/races/deadlines, exact transaction/receipt comparison, V1/V2/V3 persistence and harness authentication/isolation. No live action ran. |
| DECISION — 10 | Codex | Implement ordered tokenization → read-back → whitelist → whitelist read-back → mint → final read-back, then immutable receipt issuance. | End-to-end fake-transport tests prove receipt requires all confirmations and exact observed-state matches. |
| OPEN QUESTION — 11 | Codex with human approval | Run the smallest authenticated sandbox contract suite using an approved signer: field conflicts first, then one complete demo run. | Sanitized evidence resolves gates; tx IDs/hashes are recorded; no credentials appear in output or git. |
| DECISION — 12 | Gemini | Review the final receipt and demo narrative for factual overclaiming, clear partial-failure disclosure, and source traceability. | Review confirms the receipt is evidence, not legal/compliance certification. |

## Three-day core schedule

- **DECISION — Day 1** — Tasks 1–5: project/domain foundation, persistence, state machine, and server-only adapter.
- **DECISION — Day 2** — Tasks 6–9: orchestration, browser wallet path, resume behavior, and adversarial failure review.
- **DECISION — Day 3** — Tasks 10–12: verification/receipt, authorized sandbox contract test, fixes, and submission review.

**ASSUMPTION** — A sandbox key, approved signer, funded Sepolia wallet, tokenizer account/license, investor identity, and valid token documentation URL are available before the authorized Day 3 test.

## Routine UI tasks, after core path

- **DECISION — Gemini** — Implement an accessible manifest form/editor using the domain schema; no free-form natural-language creation.
- **DECISION — Gemini** — Implement a plain execution-plan review with chain, signer, method, recipients, and amounts visible before approval.
- **DECISION — Gemini** — Implement run timeline, retry/resume affordances, and explicit distinctions among pending, timed out, rejected, and verification failed.
- **DECISION — Gemini** — Implement a readable receipt view/download from the immutable server artifact.
- **DECISION — Codex** — Wire UI actions to server endpoints and enforce that client input cannot select arbitrary Brickken methods or mutate approved payloads.
- **DECISION — Grok** — Review copy for security ambiguity, especially “cancel,” “retry,” “confirmed,” and “verified.”

## Traceability matrix

**DECISION —** Each row defines the minimum evidence chain for the locked MVP. Brickken mappings are verified in the linked integration specification; local behaviors are Edict decisions.

| MVP step | Local Edict responsibility | Brickken operation or read | Required signer | Data persisted | Success evidence | Primary failure modes |
| --- | --- | --- | --- | --- | --- | --- |
| Manifest/form | Parse versioned structured input; canonicalize; never infer missing business choices. | None | None | Manifest JSON, schema version, hash, revision | Schema-valid canonical manifest | Invalid format, unsupported chain/type, identity collision, amount overflow |
| Validation | Enforce Sepolia, 3–5-character uppercase alphanumeric symbol pending contract resolution, distinct tokenizer/investor email, valid addresses/URLs, and positive integer amount. | None | None | Validation result/errors | No errors; deterministic normalized values | Unsupported/ambiguous field, invalid checksum, reused identity |
| Execution plan | Produce immutable ordered tokenization, whitelist, mint, and verification plan with signer/chain/reads. | None | None | Plan JSON/hash, expected signer/recipients | Recomputed plan hash matches | Nondeterminism, hidden operation, mutable payload |
| Approval | Bind plan hash, manifest hash, chain, revision and required tokenizer wallet with fixed EIP-712 typed data. | None | Tokenizer EOA signs the bounded approval challenge | Public signature proof, recovered wallet, timestamps, nonce and typed-data digest | Recovered signer matches the exact immutable plan and required wallet | Wrong account, stale/expired/forged challenge, unsupported contract wallet |
| Tokenization prepare | Guard state; call server-only SDK in `client-broadcast`; validate/persist result before wallet action. | `newTokenization` through `POST /prepare-transactions` | Tokenizer wallet will sign | Request/hash, `preparedTxId`, unsigned tx/hash | Valid prepare response bound to plan | Missing key/credit/license, unapproved signer, duplicate symbol, ambiguous timeout |
| Tokenization broadcast/tracking | Compare prepared fields; wallet broadcasts; persist hash; reconcile identical pair; poll. | `POST /send-transactions {txId,txHash}`; `GET /get-transaction-status` | Tokenizer wallet | `txId`, `txHash`, status/error, poll timestamps | Brickken `success` and stable hash | User rejection, wallet/RPC rejection, nonce issue, pending/timeout, Brickken rejection |
| Tokenization read-back | Verify requested asset identity/chain and deployed address before advancing. | `GET /get-token-info`; `GET /get-tokenizer-info` | None; server API key authenticates | Sanitized observations/hashes, token address | Requested/observed fields match; nonzero token address | Eventual consistency, unauthorized symbol, missing/mismatched fields |
| Investor whitelist prepare | Prepare standalone whitelist only after tokenization verification and explicit approval. | `whitelist` through `POST /prepare-transactions` | Tokenizer wallet will sign | Request/hash, `preparedTxId`, unsigned tx/hash | Valid prepare response bound to investor and token | Boolean/string contract conflict, unknown investor, credit exhaustion |
| Whitelist broadcast/tracking | Wallet broadcasts; persist; reconcile; poll without resubmission. | `POST /send-transactions {txId,txHash}`; `GET /get-transaction-status` | Tokenizer wallet | `txId`, `txHash`, status/error, polls | Brickken `success` | Wrong signer, already/incorrectly listed, pending/timeout, rejected tx |
| Whitelist read-back | Query address-based contract state and block mint until true. | `GET /get-whitelist-status` | None; server API key authenticates | Observation/hash | Expected address and `isWhitelisted: true`, source blockchain | False/stale flag, address mismatch, unauthorized symbol |
| Mint prepare | Set `needWhitelist: false`; validate investor identity and amount; require explicit approval. | `mintToken` through `POST /prepare-transactions` | Tokenizer wallet will sign | Request/hash, `preparedTxId`, unsigned tx/hash | Valid prepare response matches plan | Same tokenizer/investor email, wrong chain/symbol, cap/credit error |
| Mint broadcast/tracking | Wallet broadcasts; persist; reconcile; poll same identifiers. | `POST /send-transactions {txId,txHash}`; `GET /get-transaction-status` | Tokenizer wallet | `txId`, `txHash`, status/error, polls | Brickken `success` | Gas/RPC/nonce failure, pending/timeout, contract revert |
| Final read-back verification | Compare investor wallet, token address, decimals, raw balance, whitelist, and requested token metadata. | `GET /get-balance-whitelist`; repeat token and tokenizer reads as needed | None; server API key authenticates | All sanitized observations, comparison result/hash | Every assertion passes exactly | Prior balance ambiguity, decimal conversion, stale read, partial mismatch |
| Deployment receipt | Create immutable artifact once, only after verification; serve same artifact on retry. | None | None | Receipt ID/body/hash/timestamp linked to run | Terminal `COMPLETE` and unique receipt | Premature issuance, duplicate receipt, missing evidence, verification failure |

## Phase 1 go/no-go checklist

- **OPEN QUESTION** — Brickken confirms or fixes unauthenticated network-info behavior.
- **OPEN QUESTION** — Authenticated contract test confirms live `whitelistStatus` is the documented boolean (current docs no longer show the string schema).
- **OPEN QUESTION** — Authenticated contract test proves separate whitelist then `needWhitelist: false` mint as a single `client-broadcast` transaction.
- **OPEN QUESTION** — Selected browser wallet successfully broadcasts a payload normalised per official browser-wallet guidance, and Brickken reconciles the hash.
- **OPEN QUESTION** — Sandbox account/license, signer approval, native gas, and per-method credits are confirmed without exposing credentials.
- **OPEN QUESTION** — Live prepare returns a `client-broadcast` encoding Phase 4 schemas accept (string fees and/or BigNumber objects) and `transactions.length === 1` for each Edict write.
- **DECISION** — If any gate fails, update the integration spec and architecture before changing feature code.

## Exact next task

**DECISION** — The first post-Phase-8 operator step is the offline preflight in [`PHASE_8_OPERATOR_PLAYBOOK.md`](PHASE_8_OPERATOR_PLAYBOOK.md): run `npm run check` and `npm run check:phase8-harness`, review the exact target and prerequisites, and stop. Any read or write action requires separate human authorization and an independently reviewed action-specific executor; production semantic authorization, Brickken writes and external-effect routes remain disabled.
