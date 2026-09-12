# Edict MVP architecture

## Architecture decision

**DECISION** — Build one Next.js TypeScript application with a server-only Brickken boundary, a browser-wallet boundary, and an application-owned repository interface for persistence. The deployment target is Vercel and the durable store is Neon Postgres through Drizzle's official Neon HTTP integration. SQLite and local disk are rejected for deployed persistence because they are not durable on Vercel-style hosting. Avoid queues, microservices, custodial signers, and multi-agent runtime components. [Drizzle Neon integration](https://orm.drizzle.team/docs/connect-neon) [Neon Vercel integration](https://neon.com/docs/guides/vercel-manual)

**DECISION** — Implemented stack: Next.js App Router on Node 24+, TypeScript strict mode, Zod for manifest and wire schemas, pinned `brickken-sdk@0.2.1` server-only behind an Edict-owned server adapter, injected EIP-1193 providers with pinned `viem@2.56.3` primitives for vendor-neutral browser authorization, Neon Postgres with exactly pinned Drizzle/Neon packages behind an application-owned repository interface, and Vitest for domain/contract tests.

**DECISION** — The implemented manifest, canonicalization, hashing, immutability, and execution-plan contracts are owned by [`CORE_DOMAIN_SPEC.md`](CORE_DOMAIN_SPEC.md).

**DECISION** — Persistence sits behind the application-owned `ExecutionRunRepository`; domain and service code do not depend on Neon, Drizzle, SQL, or database types. The deployed implementation is the server-only Neon/Drizzle adapter. Automated tests use an injected offline query boundary, and the in-memory repository remains available for unit tests and local demonstrations.

**DECISION** — The in-memory repository is test and local-demo infrastructure only. It is not durable across process restarts and is forbidden for deployed write execution. The Neon migration and opt-in live database verification must pass before any Brickken live-write path is enabled.

**DECISION** — Phase 4 is complete: Part A provides the application-owned run repository contract and fail-closed state machine; Part B provides the server-only Brickken sandbox adapter, runtime wire schemas, prepared-transaction preservation, safe error mapping, and opt-in read-only smoke test.

**DECISION** — Phase 5 implements durable run persistence as one versioned `execution_runs` JSONB snapshot table. This is an MVP decision: it preserves the complete state-machine aggregate atomically without prematurely creating analytics, user, portfolio, asset, or compliance tables.

**DECISION** — Run access uses a 24-hour, one-active-run, server-authenticated bearer capability. HTTPS and production use only `__Host-edict_run_access` (HttpOnly, Secure, SameSite=Strict, Path=/, no Domain). Explicitly configured HTTP loopback origins in development/test use only `edict_run_access_dev`, with the same scope and attributes except Secure=false. There is no alternate-name fallback; the [run API contract](RUN_API_SPEC.md#run-capability) owns selection and clearing rules. Knowledge of a run ID, same-origin checks, email or a claimed wallet address is not authorization. Capability and approval-challenge MACs use purpose-specific keys derived from one server-only secret.

**DECISION** — Plan approval requires an EIP-712 EOA signature over fixed fields binding the run, manifest hash, plan hash, sandbox chain and environment, approval revision, required signer, challenge nonce and bounded timestamps. The server recovers the signer with exactly pinned `viem@2.56.3`; EIP-1271 contract wallets, personal-sign fallback and RPC contract detection are not supported in Phase 6.

**DECISION** — Phase 6 is complete. The public surface is limited to run creation/read, approval challenge/verification and pre-broadcast cancellation. It is deny-by-default and constructs no write-capable Brickken adapter. The injected internal orchestrator implements durable CAS intent ordering, gate rechecks, single adapter attempts and manual-reconciliation outcomes for later phases. [`RUN_API_SPEC.md`](RUN_API_SPEC.md) owns the detailed HTTP, capability, approval and orchestration contract.

**DECISION** — The vendor-neutral browser boundary performs passive EIP-6963 discovery, explicit EIP-1193 provider selection, server-issued EIP-712 approval, strict transaction projection, and V4 release-before-send/hash-handoff ordering. The browser-wallet composition adds three narrowly scoped V4 routes and minimum UI while production transaction authorization remains deny-all. [`WALLET_EXECUTION_SPEC.md`](WALLET_EXECUTION_SPEC.md) owns the detailed wallet contract.

**DECISION** — Phase 8 is complete offline. It hardens hostile provider handling, persists bounded trusted-RPC transaction and receipt evidence in `ExecutionRunV3`, and supplies an isolated loopback operator harness under `tools/phase8-harness/`. Its sole concrete executor is a fixed, read-only `BRICKKEN_READ` sandbox connectivity and Sepolia network-information check; it has not been run. The harness is excluded from the production build and route tree. No live action, authenticated write, RPC lookup, migration application or named-wallet verification occurred. [`PHASE_8_OPERATOR_PLAYBOOK.md`](PHASE_8_OPERATOR_PLAYBOOK.md) owns its operating contract.

**DECISION** — Phase 8 preflight derives fixed public output from the same response, header and evidence builders used by the runtime. A final guard checks every application-controlled HTTP body and normalized header before emission, including HTML and server errors. Dynamic collisions terminate the runtime without an error fallback. Its offline artifact audit uses exclusive capture paths and fails on filesystem inspection errors other than missing optional roots; the operator playbook defines the remaining platform and build-environment limits.

**DECISION** — Durable planning recovery uses `/records/[runId]` as the canonical recorded-run page while `/` remains the new-mandate page. The URL contains only the public run locator. The existing selected HttpOnly capability authorizes an independently complete `GET /api/runs/[runId]` response containing a strict public run projection, server-normalized manifest and server-rederived seven-operation plan. Reload is read-only, preserves revision, and performs no wallet, Brickken, RPC or execution action. Creating a later run continues to replace browser access to the earlier run.

**DECISION** — Phase 9C adds a client-only, same-origin approval HTTP gateway behind the existing coordinator interface. It performs bounded strict parsing and no retries. Only an independent durable GET proving the same authority tuple at the exact post-approval revision and `TOKENIZATION/PREPARING` state can establish recorded approval. Submission uncertainty permits at most one read-only reconciliation GET; it cannot trigger another challenge, signature or approval mutation. The gateway remains uncomposed from React and provider discovery.

**DECISION — Phase 10 preparation/review boundary:** The canonical `/records/[runId]` page may explicitly invoke `POST /api/runs/[runId]/prepare` only when the server projection identifies TOKENIZE as ready. Preparation is not read-only: it performs the existing two-CAS `PREPARE_INTENT → PREPARED` sequence around one server-only Brickken `newTokenization` preparation request. The production gate is independently opt-in through server-only `EDICT_TRANSACTION_PREPARATION_ENABLED=1` and authorizes `PREPARE` only; it always refuses `CONFIRM_BROADCAST`.

**DECISION** — The returned `PreparedTransactionReviewV1` is an immutable, strict display contract over the exact persisted transaction. Its fingerprint binds the run, current revision, approval revision, manifest/plan hashes, TOKENIZE operation, signer, sandbox/Sepolia, Brickken action and normalized wallet request. Calldata is deliberately labeled opaque because no production destination/selector allowlist has been authorized. This review fingerprint does not compete with or authorize `WalletIntentV1`: the latter remains rederived only after a future separate durable wallet-prompt revision.

**HISTORICAL DECISION** — Phase 10 stopped at `TOKENIZATION/AWAITING_WALLET` with `TOKENIZE/PREPARED` and `walletConfirmation: NOT_REQUESTED`. The next checkpoint composes V4 authorization, exact one-shot provider invocation, hash persistence, and ambiguity recording, but keeps them unreachable from production send authority through default deny-all. Confirmation, polling, Brickken correlation, read-back, WHITELIST, MINT, and receipt remain unexposed.

**SUPPORT-CONFIRMED CONTRACT — Phase 10 offline execution foundation, 2026-09-11** — In `client-broadcast`, Brickken prepares an unsigned transaction and `txId`; the user's wallet is the only component that submits the transaction through `eth_sendTransaction`; Edict durably records the returned hash; `POST /send-transactions {txId,txHash}` correlates that already-broadcast transaction and never rebroadcasts it; progress uses `GET /transaction-status`; trusted Sepolia RPC independently proves transaction identity, successful canonical inclusion and finality before read-back. Brickken compares exactly `chainId`, `from`, `to`, `data`, `value`, and `nonce`. `gasLimit`, `maxFeePerGas`, and `maxPriorityFeePerGas` may vary within an explicit Edict fee authorization. Same-pair correlation is idempotent; no retry may change either identifier or invoke the wallet again.

**DECISION — ExecutionRunV4 offline foundation** — V4 adds immutable preparation-attempt history, trusted-server-RPC nonce freshness, explicit stale/reprepare authority, immutable execution identity, bounded EIP-1559 fee authorization, prompt/invocation authority, independent RPC and Brickken evidence, correlation lifecycle and `TokenIdentityV1`. `PROVEN_NOT_INVOKED` means the server has not released execution authority; an untrusted browser claim after release can never establish it. V2/V3 enter V4 only through an explicit V4 operation; reads never upgrade snapshots. Production creation remains V2, and every live execution gate remains denied.


**VERIFIED** — On 2026-09-04, the Neon migration completed without error and the explicitly opted-in live database test passed create, read, atomic compare-and-swap update, stale-revision refusal, and cleanup of its uniquely created run. Durable persistence is verified. The test made no Brickken request or blockchain operation and emitted no credential.

**HISTORICAL OBSERVATION** — On 2026-09-04, the opt-in adapter smoke test completed one credential-bearing `get-network-info` read and recorded `Sepolia ETH` and `sepolia.etherscan.io`; the earlier anonymous request returned `401`. This does not prove that the credential was required, accepted as authority or independently authenticated.

**CONTROLLED OBSERVATION — 2026-09-09** — Two independently approved preparation-only requests reached the Brickken sandbox and were not retried. The diagnostic request received a definite HTTP 400 license/subscription/entitlement refusal and no prepared transaction. Both runs remain blocked; no wallet prompt, signing, broadcast, confirmation, polling, read-back, or blockchain action occurred. Successful prepared output, signer/license/credit readiness, browser-wallet compatibility, finality, and write completion remain unverified.

## Trust boundaries and responsibilities

| Boundary | Responsibilities | Forbidden data/actions |
| --- | --- | --- |
| DECISION — Browser | Render manifest/form and plan; connect wallet; request explicit plan approval; display the prepared transaction; ask the wallet to sign and broadcast; return public address and transaction hash; display progress and receipt. | API key, private key, seed phrase, direct authenticated Brickken requests, hidden auto-approval. |
| DECISION — Next.js server | Validate/canonicalize; create immutable plan; enforce approvals; call the pinned SDK with sandbox API key through an Edict-owned server adapter; validate SDK payloads; persist run/operation/events; reconcile tx hashes; poll; verify read-back; issue receipt. | Private keys, seed phrases, production endpoint, signing, silently changing an approved plan. |
| DECISION — Browser wallet | Hold keys; show wallet confirmation; sign and broadcast the prepared Sepolia transaction; return `txHash`. | Revealing key material to Edict. |
| VERIFIED — Brickken sandbox | Prepare Dapp operations, reconcile client-broadcast hashes, report status, and expose token/whitelist/balance reads. A historical credential-bearing adapter `GET /get-network-info` recorded `Sepolia ETH` and `sepolia.etherscan.io`; an earlier anonymous request returned `401`, so implementation must not depend on it being public or infer authentication semantics. [Dapp API](https://docs.brickken.com/api-reference/introduction) [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send) | DECISION — No production or relayed execution in MVP. Controlled preparation-only diagnostics produced no transaction and enabled no later action. |
| DECISION — Repository interface | Persist complete versioned run snapshots behind an application-owned repository interface. Neon/Drizzle is contained in the server adapter; injected and in-memory implementations support offline tests. Optimistic revision comparison prevents lost updates. | API keys, database URLs, wallet secrets, seed phrases, signed raw transactions, full environment dumps. |

## Minimal component layout

```text
Browser UI
  ├─ `/` manifest/form and `/records/[runId]` durable plan viewer
  ├─ wallet connector and client-broadcast adapter
  └─ run status / verification / receipt viewer
          │ public run commands and txHash only
          ▼
Next.js route handlers (same origin; preparation plus three V4 wallet-boundary mutations)
  ├─ domain: validate, canonicalize, plan, hashes
  ├─ orchestrator: internal-only effect methods + approval/CAS/write gates
  ├─ brickken.server: Edict-owned server adapter wrapping pinned SDK + Zod wire validation
  ├─ verifier: requested state vs observed state
  └─ repository: application-owned interface
       ├─ Neon Postgres + Drizzle adapter (deployed)
       └─ in-memory adapter (tests/local demos only)
          │ x-api-key only here
          ▼
Brickken sandbox API ──► Ethereum Sepolia
          ▲                    ▲
          └── status/reads     └── browser wallet broadcasts
```

**DECISION** — The client never chooses an arbitrary Brickken method or payload. It sends a run/action identifier; the server reconstructs the next allowed request from the immutable approved plan.

**DECISION** — The server returns only the exact prepared transaction selected for the next operation, a sanitized display projection, and an opaque operation identifier. It never returns headers or server configuration.

## Durable persistence model

### `execution_runs`

- **DECISION** — Store one complete, explicitly versioned execution-run snapshot in JSONB with duplicated indexed metadata: `run_id` primary key, `schema_version`, non-negative `revision`, `manifest_hash`, `plan_hash`, `status`, `created_at`, and `updated_at`. V1, V2, V3 and V4 decode strictly; ordinary run creation remains V2, validated legacy onchain-transaction evidence enters V3, and an explicit execution-authority transition enters V4. Reads never upgrade a snapshot.
- **DECISION** — The primary key is the only current access index. No speculative relational tables or analytics indexes are introduced.
- **DECISION** — Every persisted value crosses an explicit runtime codec. The codec rejects unsupported properties, unsafe JSON values, accessors, sparse arrays, cycles, class instances, secret-bearing fields, invalid timestamps, unknown versions, and inconsistent duplicated values. Decoded values are newly allocated and deeply frozen.
- **DECISION** — `create` is insert-only. `update` is a single compare-and-swap statement constrained by `run_id` and expected `revision`; it increments the row revision exactly once and atomically replaces the snapshot and duplicated metadata. A zero-row update is classified as not found or stale revision without performing a read-modify-write overwrite.
- **DECISION** — Application-boundary timestamps are canonical ISO-8601 UTC strings. The adapter alone maps them to and from Postgres timestamp-with-time-zone values.
- **DECISION** — The snapshot may contain deployment-required emails, public wallet addresses, prepared transaction identifiers, and public transaction hashes. Routine persistence errors and logs must not print them.
- **VERIFIED — 2026-09-11 read-only Neon audit** — Migration `0002_gorgeous_squadron_sinister.sql` is recorded in the live Drizzle ledger, and the live constraint permits `1.0 | 2.0 | 3.0`. All 14 rows observed were V2; there were no V1 or V3 rows and no durable wallet-prompt or broadcast operation. The earlier statement that `0002` was unapplied was inaccurate.
- **DECISION** — V1, V2 and V3 remain backward-decodable without silent mutation or upgrade. V4 strictly adds the execution-authority records described above. Migration `0003_mushy_sugar_man.sql` only extends the check constraint to include `4.0`; it is generated for offline review and must not be applied without separate authorization.

## Compositional persisted state machine

**DECISION** — Store a `phase`, a `status`, and an optional terminal outcome instead of one large enum. This keeps the state machine small while retaining exact recovery points.

### Values

- **DECISION** — `phase`: `DRAFT | VALIDATION | PLAN | TOKENIZATION | WHITELIST | MINT | VERIFICATION | RECEIPT`.
- **DECISION** — `status`: `READY | INVALID | AWAITING_APPROVAL | PREPARING | AWAITING_WALLET | BROADCAST_RECORDED | CONFIRMING | SUCCEEDED | RETRYABLE_FAILURE | TIMED_OUT | RECONCILIATION_REQUIRED`.
- **DECISION** — Each write operation also stores a fine-grained `stage`. Ambiguous prepare or wallet/broadcast outcomes set operation stage `PREPARE_UNKNOWN` or `BROADCAST_UNKNOWN` and run status `RECONCILIATION_REQUIRED`. That status blocks prepare, wallet prompts, broadcast, automatic retry, and advancement. It is not `AWAITING_WALLET`.
- **DECISION** — `FeeAuthorizationV1` is an authorization/audit boundary, not physical control over an external wallet. After a known broadcast, immutable-identity mismatch and `POLICY_VIOLATION_ONCHAIN` remain distinct durable facts. Both preserve the hash and continue trusted-RPC evidence collection; a fee violation also permits same-pair Brickken correlation because correlation records an existing broadcast rather than submitting another transaction. Evidence collection never implies approval, never permits resubmission, and a fee-violating operation cannot automatically advance to WHITELIST/MINT.
- **DECISION** — terminal outcome: `COMPLETE | CANCELLED | FAILED | VERIFICATION_FAILED`.

### Allowed happy-path transitions

| From | Event and guard | To |
| --- | --- | --- |
| DECISION — `DRAFT/READY` | Submit manifest | `VALIDATION/READY` |
| DECISION — `VALIDATION/READY` | Valid | `PLAN/READY` |
| DECISION — `VALIDATION/READY` | Invalid | `VALIDATION/INVALID` |
| DECISION — `PLAN/READY` | Persist canonical immutable plan/hash | `PLAN/AWAITING_APPROVAL` |
| DECISION — `PLAN/AWAITING_APPROVAL` | User approves exact plan/hash and connected wallet matches | `TOKENIZATION/PREPARING` |
| DECISION — any write `*/PREPARING` | Brickken prepare response validated and persisted | same phase `AWAITING_WALLET` |
| DECISION — any write `*/AWAITING_WALLET` | User approves wallet prompt; wallet returns hash; hash persisted | same phase `BROADCAST_RECORDED` |
| DECISION — any write `*/BROADCAST_RECORDED` | Trusted Sepolia RPC returns the identical hash and matching signed transaction fields; evidence enters V3 | same phase `BROADCAST_RECORDED` |
| DECISION — matching V3 broadcast | Brickken accepts identical `{txId, txHash}` | same phase `CONFIRMING` |
| DECISION — any write `*/CONFIRMING` | Brickken reports `pending` | same phase `CONFIRMING` |
| DECISION — `TOKENIZATION/CONFIRMING` | Brickken reports `success`; a matching successful receipt reaches recorded finality; token read-back identifies expected asset/address | `WHITELIST/PREPARING` |
| DECISION — `WHITELIST/CONFIRMING` | Brickken reports `success`; whitelist read-back is true | `MINT/PREPARING` |
| DECISION — `MINT/CONFIRMING` | Brickken reports `success` | `VERIFICATION/READY` |
| DECISION — `VERIFICATION/READY` | All requested/observed assertions pass and evidence persists | `VERIFICATION/SUCCEEDED` |
| DECISION — `VERIFICATION/SUCCEEDED` | Immutable receipt persists in same database transaction | `RECEIPT/SUCCEEDED` + `COMPLETE` |

### Failure, cancellation, and timeout transitions

- **DECISION** — Invalid input remains `VALIDATION/INVALID` and may return to `DRAFT/READY` only by creating a new manifest revision; no Brickken call is allowed.
- **DECISION** — User rejection before broadcast returns the same operation to `AWAITING_APPROVAL` without discarding an already persisted `txId`; do not prepare again automatically.
- **DECISION** — User cancellation is terminal `CANCELLED` only before any wallet broadcast. After a hash exists, “stop” disables active polling but records `TIMED_OUT`; it cannot cancel the blockchain transaction.
- **DECISION** — Transport/5xx/rate-limit failures before a durable hash become `RETRYABLE_FAILURE`; retries must obey the integration spec and cannot create a second prepare implicitly.
- **VERIFIED** — Brickken `rejected` is terminal for that transaction and includes an error when available. [Get Transaction Status](https://docs.brickken.com/api-reference/endpoint/get-transaction-status)
- **DECISION** — A rejected write, invalid signature, wallet/address mismatch, contradictory identifier, or exhausted non-recoverable credit ends the run as `FAILED`; preserve all prior on-chain evidence.
- **DECISION** — Poll budget exhaustion becomes `TIMED_OUT`, which is nonterminal and resumable. Refresh resumes from persisted identifiers, not by repeating prepare/broadcast.
- **DECISION** — Any requested-versus-observed mismatch ends the run as terminal `VERIFICATION_FAILED`; no receipt can be issued.
- **DECISION** — `COMPLETE`, `CANCELLED`, `FAILED`, and `VERIFICATION_FAILED` are terminal. On-chain success cannot be rolled back by editing local status.

## Wallet signing and broadcast flow

**DECISION — Current Phase 9D/E composition:** The recorded-plan surface at `/records/[runId]` owns a client-only controller over the existing EIP-6963 discovery, selected-session, approval coordinator, and same-origin approval gateway primitives. Provider selection, legacy fallback, account authorization, Sepolia switching, reinspection, and plan approval remain explicit. The approval action binds the displayed run/revision/hashes/signer/environment/chain to a preflight durable read, fresh server challenge, exact EIP-712 request, proof submission, and one final durable read. Signature/POST/local state are non-authoritative; only the exact approved `N+1` post-state is recorded. Uncertainty locks signing behind read-only status refresh. The UI stops at **Approval recorded** and does not compose transaction execution, Brickken, or RPC paths.

1. **DECISION** — Server checks the run version, phase, approval record, expected signer, selected Sepolia chain, and absence of an existing `preparedTxId` before prepare.
2. **DECISION** — Server calls the SDK with `executionMode: "client-broadcast"`, `execute: false`, and the approved `signerAddress`, validates the response, persists `txId` and the exact unsigned transaction, then returns a sanitized transaction view.
3. **DECISION** — Server projects the persisted transaction through the strict Edict-owned DTO and canonical wallet intent. Browser recomputes its integrity, verifies operation identity, signer, chain and prompt revision, and applies the injected semantic policy; production policy remains deny-all.
4. **DECISION** — The selected injected wallet confirms, signs, and broadcasts the exact frozen DTO through the sole product `eth_sendTransaction` invocation site. Immediately before that one invocation, Edict revalidates provider generation, Sepolia chain and the exact signer, with the last generation assertion adjacent to the captured provider call. Edict never asks for key material or a raw private key.
5. **DECISION** — Browser posts `txHash` and operation ID to the server. Server verifies shape and expected phase and persists the hash atomically before external reconciliation.
6. **VERIFIED** — Server sends the identical `{txId, txHash}` to Brickken; resubmission of that same pair is idempotent. [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)
7. **DECISION** — Server polls by persisted identifiers. Refresh loads the run and resumes from `AWAITING_WALLET`, `BROADCAST_RECORDED`, `CONFIRMING`, or `TIMED_OUT` without repeating completed steps.

**OPEN QUESTION** — Injected wallets may normalize or reject some prepared EIP-1559 fields. Phase 7 retains nonce/type/fee fields and omits transaction-level chain ID in favor of a revalidated provider precondition, which is not universally atomic. Contract-test the exact Brickken payload and chain behavior on an explicit wallet/version before any live-write path is enabled.

**ASSUMPTION** — EIP-1193 exposes no atomic chain/account snapshot plus send operation. A provider that silently changes internal state after the final reads and emits no event cannot be detected by browser code before its own request implementation runs. The single-send boundary minimizes this interval and fails closed on every observable generation/read mismatch; a returned or uncertain send is never replaced automatically.

## Verification strategy

1. **DECISION** — After tokenization success, read `/get-token-info` and `/get-tokenizer-info`; verify symbol/name/type, tokenizer identity, chain, and nonzero contract address.
2. **DECISION** — After standalone whitelist success, read `/get-whitelist-status` by investor address and require its blockchain-sourced flag to be true before mint.
3. **DECISION** — After mint success, read `/get-balance-whitelist` by investor email; require the resolved investor address, token address, whitelist flag, balance source, and raw amount/decimals to match the approved request.
4. **DECISION** — Normalize addresses case-insensitively for comparison but retain checksummed observed values. Compare token quantities as integers in smallest units; never use floating point.
5. **DECISION** — Store every sanitized observed response and its hash. Receipt generation consumes only persisted requested and observed snapshots, never fresh unrecorded reads.
6. **DECISION** — Issue the receipt in the same database transaction that marks `COMPLETE`, protected by a unique `runId`, so retries return the same receipt.

## API-key handling

- **DECISION** — Read `BRICKKEN_API_KEY` only in a module guarded by `server-only`; instantiate the SDK there and never serialize its configuration.
- **DECISION** — Reject any base URL other than the exact sandbox allowlist at startup. Ignore client-supplied base URLs, headers, chain IDs, method names, and RPC URLs.
- **DECISION** — Redact `x-api-key`, cookies, authorization-like headers, emails where unnecessary, and raw upstream bodies before structured logging. Store only fields required for audit and verification.
- **DECISION** — Deployment configuration uses a secret manager. Local development uses an ignored `.env.local`; `.env.example` contains empty or visibly non-secret placeholders only.
- **DECISION** — Add a build test that searches browser output and tracked files for the configured key value without printing that value.

## Explicit non-goals

- **DECISION** — No mainnet, production configuration, agentic/x402 payments, server-held signer, KYC automation, STO, transfers, dividends, secondary trading, portfolio screens, AI plan decisions, or generalized workflow engine.
- **DECISION** — No receipt is generated for partial success, timed-out confirmation, or verification mismatch.
