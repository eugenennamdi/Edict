# Edict MVP architecture

## Architecture decision

**DECISION** — Build one Next.js TypeScript application with a server-only Brickken boundary, a browser-wallet boundary, and an application-owned repository interface for persistence. SQLite is rejected as the production/deployed persistence implementation because local disk is not durable on Vercel-style hosting; the final managed database choice is deferred, with an in-memory repository implementation used for automated tests. Avoid queues, microservices, custodial signers, and multi-agent runtime components.

**DECISION** — Recommended stack after Phase 0 approval: Next.js App Router on Node 24+, TypeScript strict mode, Zod for manifest and wire schemas, pinned `brickken-sdk@0.2.1` server-only behind an Edict-owned server adapter, wagmi/viem for wallet connection and browser broadcasting, an application-owned repository interface for persistence, and Vitest for domain/contract tests.

**DECISION** — The implemented manifest, canonicalization, hashing, immutability, and execution-plan contracts are owned by [`CORE_DOMAIN_SPEC.md`](CORE_DOMAIN_SPEC.md).

**DECISION** — Persistence sits behind an application-owned repository interface. Automated tests will use an in-memory repository implementation. SQLite is rejected for production/deployed persistence because local disk is not durable on Vercel-style hosting, and the final managed database choice is deferred.

**DECISION** — The in-memory repository is test and local-demo infrastructure only. It is not durable across process restarts. Live write execution cannot ship until an application-owned durable managed repository implementation exists.

## Trust boundaries and responsibilities

| Boundary | Responsibilities | Forbidden data/actions |
| --- | --- | --- |
| DECISION — Browser | Render manifest/form and plan; connect wallet; request explicit plan approval; display the prepared transaction; ask the wallet to sign and broadcast; return public address and transaction hash; display progress and receipt. | API key, private key, seed phrase, direct authenticated Brickken requests, hidden auto-approval. |
| DECISION — Next.js server | Validate/canonicalize; create immutable plan; enforce approvals; call the pinned SDK with sandbox API key through an Edict-owned server adapter; validate SDK payloads; persist run/operation/events; reconcile tx hashes; poll; verify read-back; issue receipt. | Private keys, seed phrases, production endpoint, signing, silently changing an approved plan. |
| DECISION — Browser wallet | Hold keys; show wallet confirmation; sign and broadcast the prepared Sepolia transaction; return `txHash`. | Revealing key material to Edict. |
| VERIFIED — Brickken sandbox | Prepare Dapp operations, reconcile client-broadcast hashes, report status, and expose token/whitelist/balance reads. Note: unauthenticated `GET /get-network-info` returned 401; implementation must not depend on it being public. [Dapp API](https://docs.brickken.com/api-reference/introduction) [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send) | DECISION — No production or relayed execution in MVP. |
| DECISION — Repository interface | Persist normalized run state, immutable request/plan snapshots, approvals, prepared IDs/payloads, hashes, poll results, observations, and receipts behind an application-owned repository interface. In-memory implementation for tests; production managed database choice deferred. | API keys, wallet secrets, seed phrases, full environment dumps. |

## Minimal component layout

```text
Browser UI
  ├─ manifest/form + plan viewer
  ├─ wallet connector and client-broadcast adapter
  └─ run status / verification / receipt viewer
          │ public run commands and txHash only
          ▼
Next.js route handlers (same origin)
  ├─ domain: validate, canonicalize, plan, hashes
  ├─ orchestrator: approval guards + state transitions
  ├─ brickken.server: Edict-owned server adapter wrapping pinned SDK + Zod wire validation
  ├─ verifier: requested state vs observed state
  └─ repository: application-owned repository interface + event log
          │ x-api-key only here
          ▼
Brickken sandbox API ──► Ethereum Sepolia
          ▲                    ▲
          └── status/reads     └── browser wallet broadcasts
```

**DECISION** — The client never chooses an arbitrary Brickken method or payload. It sends a run/action identifier; the server reconstructs the next allowed request from the immutable approved plan.

**DECISION** — The server returns only the exact prepared transaction selected for the next operation, a sanitized display projection, and an opaque operation identifier. It never returns headers or server configuration.

## Core data model

### `deployment_run`

- **DECISION** — Persist `id` (UUID), `schemaVersion`, canonical `manifestJson`, `manifestHash`, immutable `planJson`, `planHash`, `chainId`, `tokenizerEmail`, `tokenizerWallet`, investor email/address, requested mint amount, `phase`, `status`, `terminalOutcome`, timestamps, and optimistic `version`.
- **DECISION** — Persist approval evidence as `approvedPlanHash`, `approvedByWallet`, `approvedAt`, and per-operation `approvedAt`; reject approvals when wallet, chain, manifest hash, or plan hash differs.
- **DECISION** — Persist `verificationJson`, `verificationHash`, and `receiptId` only after all comparisons succeed.

### `deployment_operation`

- **DECISION** — Persist `id`, `runId`, sequence number, kind (`TOKENIZE`, `WHITELIST`, `MINT`), request snapshot and hash, expected signer, `executionMode`, status, attempt counters, `preparedTxId`, sanitized unsigned transaction JSON and hash, `blockchainTxHash`, Brickken confirmation status/error, first/last poll timestamps, timeout marker, and timestamps.
- **DECISION** — Add uniqueness constraints on `(runId, sequence)`, non-null `preparedTxId`, and non-null `blockchainTxHash` where supported; application guards additionally enforce one prepared operation and one chain hash per sequence.
- **DECISION** — Never overwrite identifiers. Any contradictory `txId` or `txHash` moves the run to terminal `FAILED` with an audit event.

### `deployment_event`

- **DECISION** — Append `id`, `runId`, optional `operationId`, monotonic sequence, event type, sanitized payload, actor (`USER`, `SERVER`, `WALLET`, `BRICKKEN`), and timestamp for every transition.

### `deployment_receipt`

- **DECISION** — Persist an immutable artifact containing run/manifest/plan/verification hashes, chain, tokenizer and investor public identities, token symbol/address, ordered operation `txId`/`txHash` pairs, requested state, observed state, source endpoints, confirmation timestamps, issued timestamp, and receipt schema version.
- **DECISION** — A receipt is evidence, not a cryptographic attestation in the MVP. Do not imply legal or compliance guarantees.

## Compositional persisted state machine

**DECISION** — Store a `phase`, a `status`, and an optional terminal outcome instead of one large enum. This keeps the state machine small while retaining exact recovery points.

### Values

- **DECISION** — `phase`: `DRAFT | VALIDATION | PLAN | TOKENIZATION | WHITELIST | MINT | VERIFICATION | RECEIPT`.
- **DECISION** — `status`: `READY | INVALID | AWAITING_APPROVAL | PREPARING | AWAITING_WALLET | BROADCAST_RECORDED | CONFIRMING | SUCCEEDED | RETRYABLE_FAILURE | TIMED_OUT | RECONCILIATION_REQUIRED`.
- **DECISION** — Each write operation also stores a fine-grained `stage`. Ambiguous prepare or wallet/broadcast outcomes set operation stage `PREPARE_UNKNOWN` or `BROADCAST_UNKNOWN` and run status `RECONCILIATION_REQUIRED`. That status blocks prepare, wallet prompts, broadcast, automatic retry, and advancement. It is not `AWAITING_WALLET`.
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
| DECISION — any write `*/BROADCAST_RECORDED` | Brickken accepts identical `{txId, txHash}` | same phase `CONFIRMING` |
| DECISION — any write `*/CONFIRMING` | Brickken reports `pending` | same phase `CONFIRMING` |
| DECISION — `TOKENIZATION/CONFIRMING` | Brickken reports `success`; token read-back identifies expected asset/address | `WHITELIST/PREPARING` |
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

1. **DECISION** — Server checks the run version, phase, approval record, expected signer, selected Sepolia chain, and absence of an existing `preparedTxId` before prepare.
2. **DECISION** — Server calls the SDK with `executionMode: "client-broadcast"`, `execute: false`, and the approved `signerAddress`, validates the response, persists `txId` and the exact unsigned transaction, then returns a sanitized transaction view.
3. **DECISION** — Browser independently compares `from`, chain, `to`, value, and operation summary with the approved plan; mismatch blocks the wallet request.
4. **DECISION** — The injected wallet confirms, signs, and broadcasts via its native EIP-1193/viem path. Edict never asks for key material or a raw private key.
5. **DECISION** — Browser posts `txHash` and operation ID to the server. Server verifies shape and expected phase and persists the hash atomically before external reconciliation.
6. **VERIFIED** — Server sends the identical `{txId, txHash}` to Brickken; resubmission of that same pair is idempotent. [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)
7. **DECISION** — Server polls by persisted identifiers. Refresh loads the run and resumes from `AWAITING_WALLET`, `BROADCAST_RECORDED`, `CONFIRMING`, or `TIMED_OUT` without repeating completed steps.

**OPEN QUESTION** — Injected wallets may normalize or reject some prepared EIP-1559 fields. Phase 1 must contract-test the exact Brickken payload on the selected wallet before the demo path is accepted.

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
