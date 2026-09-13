# Phase 6 run API and orchestration contract

## Status and public surface

**DECISION** — The browser-wallet composition checkpoint adds three narrowly scoped V4 routes. The current callable routes are:

- `POST /api/runs`
- `GET /api/runs/[runId]`
- `POST /api/runs/[runId]/approval-challenges`
- `POST /api/runs/[runId]/approval`
- `POST /api/runs/[runId]/cancel`
- `POST /api/runs/[runId]/prepare`
- `POST /api/runs/[runId]/wallet-authorization`
- `POST /api/runs/[runId]/broadcast-hash`
- `POST /api/runs/[runId]/broadcast-unknown`

**DECISION** — Wallet authorization accepts exactly `{ "expectedRevision": positiveInteger }`; browser-supplied activation, policy, destination, selector, calldata, signer, operation, or fee fields are rejected. Production composes `DenyAllSemanticAuthorizationEvaluator` unless private `EDICT_TOKENIZE_EXECUTION_ENABLED` is exactly `1` and complete validated policy is present. A gated TOKENIZE authorization still releases an envelope only after the existing durable prompt CAS and `INVOKED_OR_UNKNOWN` CAS. The response is exactly `{ "ok": true, "envelope": SendAuthorizedEnvelopeV1 }`; it omits the durable wallet intent, semantic policy record, policy configuration, reason detail, Brickken evidence, secrets, and capability material. WHITELIST and MINT remain unauthorized even with the gate enabled.

**DECISION — explicit V4 sequence** — `POST /promote`, `POST /readiness`, wallet authorization/hash ingestion, and `POST /track` remain separate same-origin capability-authorized actions accepting only the displayed expected revision (plus the existing exact hash authority binding where applicable). `/readiness` rejects V2 rather than upgrading it. `/track` uses only durable identifiers, can collect RPC/correlation/status/read-back evidence, never resubmits, and must be explicitly invoked again when observation is still pending. GET/recovery performs no promotion, readiness evaluation, correlation, polling, or read-back.

**DECISION — transaction-bound read-back, 2026-09-13** — `/track` may retain bounded `/transaction-status` text, but no raw string authorizes failure, success, or phase advancement. TOKENIZE can create identity only from one reviewed-factory `NewTokenization` log in the exact re-read successful canonical finalized receipt, with the reviewed implementation proven at that receipt block. Server-owned Brickken reads can only confirm the already-derived address. Every absent, duplicate, malformed, wrong-emitter, wrong-implementation or secondary mismatch remains fail-closed.

**DECISION** — Broadcast-hash ingestion accepts exactly `{ expectedRevision, invocationAttemptId, walletIntentHash, txHash }`. Broadcast-unknown accepts the first three binding fields plus one of `PROVIDER_4001`, `PROVIDER_TIMEOUT`, `PROVIDER_ERROR`, or `HASH_PERSISTENCE_UNCONFIRMED`. Both rederive the active operation from durable state. Hash persistence is one CAS and performs no RPC or Brickken call. Unknown recording uses the V4 `BROADCAST_UNKNOWN` plus `RECONCILIATION_REQUIRED` transition and never restores resend authority.

**DECISION** — `POST /api/runs/[runId]/prepare` is the only public execution-effect route. It exists because preparation is a durable mutation plus one server-only Brickken sandbox request and therefore cannot be exposed through GET or folded into approval/cancellation without mixing authorities. Its strict body is exactly `{ "expectedRevision": positiveInteger }`; the browser cannot supply an operation, method, signer, chain, hashes, transaction fields, or Brickken payload. Exact trusted-origin and run-capability checks precede body parsing and repository lookup.

**DECISION** — The server re-reads the durable run and permits only an approved, nonterminal `TOKENIZATION/PREPARING` run whose first operation is `TOKENIZE/NOT_STARTED`. One `BEGIN_PREPARE` CAS winner advances revision `N→N+1`, the write gate is checked again, one `newTokenization` prepare-only request is made with `execute:false` and `client-broadcast`, and a valid result is persisted by a second CAS at `N+2`. A stale or concurrent request is `409 REVISION_CONFLICT`; an ineligible state is `409 STATE_CONFLICT`; disabled preparation is `404 PREPARATION_DISABLED`; an indeterminate or malformed preparation is `503 PREPARATION_UNCONFIRMED` and leaves durable reconciliation state. Raw upstream errors are never returned.

**DECISION** — The public `execution` projection is strict and server-derived. It reports the exact next TOKENIZE operation and one of `READY_FOR_PREPARATION`, `PREPARATION_PENDING`, `PREPARED_FOR_REVIEW`, or `PREPARATION_UNCONFIRMED`. Only a durably prepared operation includes `PreparedTransactionReviewV1`, binding run/revision, manifest and plan hashes, approval revision, operation, signer, sandbox/Sepolia, Brickken action/mode, prepared ID, normalized exact wallet request, chain precondition, and a canonical SHA-256 fingerprint. It omits the persisted raw unsigned object, raw Brickken response, proof/events/observations, credentials and capabilities.

**DECISION** — GET remains read-only. Page mount, refresh, direct `/records/[runId]` recovery, and a second authorized tab only reconstruct the durable projection and never prepare automatically. After a lost POST response, the browser performs at most one GET; it never retries preparation. A stranded `PREPARE_INTENT` or `PREPARE_UNKNOWN` state blocks another prepare pending operator reconciliation.

**HISTORICAL DECISION** — The preparation milestone stopped before the separate durable wallet-prompt transition. The later browser-wallet checkpoint exposes only authorization, hash ingestion, and bounded ambiguity recording; confirmation, polling, Brickken correlation, read-back, whitelist, mint, and receipt routes remain absent, and production semantic authorization remains deny-all.

**HISTORICAL DECISION** — In Phase 6, prepare, wallet prompt/result, confirmation, polling, read-back and final-verification methods existed only on the injected internal orchestration boundary. Phase 10 exposes preparation only; every later method remains internal and uncomposed.

**DECISION** — Phase 7 did not expand this surface. Phase 9C supplies the existing browser coordinator with a dormant production same-origin gateway for GET, approval challenge and approval submission; it adds no route or UI composition. Brickken writes and transaction semantic authorization remain disabled. See [`WALLET_EXECUTION_SPEC.md`](WALLET_EXECUTION_SPEC.md).

**HISTORICAL DECISION** — Phase 8 left this surface unchanged at exactly five routes. `ExecutionRunV3` evidence is persisted only through internal validated transitions; the existing run projection omitted raw unsigned transactions and detailed evidence. The compatibility harness lives under `tools/phase8-harness/`, is excluded from the production build, and is not a Next.js route. At that checkpoint, production semantic authorization and Brickken writes remained disabled.

**HISTORICAL DECISION** — The durable recovery checkpoint left the API surface at exactly five routes and added the user page `/records/[runId]`. `POST /api/runs` and authorized `GET /api/runs/[runId]` return the same independently complete strict planning record: the allowlisted public run projection, server-normalized manifest and complete server-derived seven-operation plan. A run ID remains only a locator; the selected HttpOnly run capability remains the authority.

## Deployment and request gates

**DECISION** — The public run API is deny-by-default. An operator must configure deployment-level preview access or rate limiting, set `EDICT_RUN_API_ENABLED=1`, configure an exact `EDICT_TRUSTED_ORIGIN`, supply durable `DATABASE_URL` persistence, and provide a base64url server secret decoding to at least 32 random bytes as `EDICT_RUN_SECURITY_SECRET`. The deployment gate returns `404 API_DISABLED` only when the enable flag is not exactly `1` or the configured origin is missing or invalid. This gate precedes body reading, manifest validation and runtime construction. With the gate enabled, a request-origin mismatch returns `403 FORBIDDEN`; database and capability configuration are checked during runtime construction. Missing/invalid database configuration rejected by its parser maps to `503 SERVICE_UNAVAILABLE`, and missing/invalid capability secrets map to `403 FORBIDDEN`; neither is reported as `API_DISABLED`.

**DECISION** — `.env.example` documents settings and is not loaded as runtime configuration. Local run planning supports an exact `http://localhost:3000` origin (adjust the port to match the browser), without a trailing slash. Restart the development server after configuring its environment. [Local setup](../README.md#environment-configuration) lists the four required variables and safe formats. Planning requires no Brickken key and does not enable writes, wallet/RPC operations or the isolated Phase 8 actions.

**DECISION** — Mutating requests require an exact trusted `Origin`, `application/json`, strict request shapes, a bounded body read, and an expected positive revision. Run-scoped routes require the opaque run capability before repository lookup. Responses are `no-store`, errors use application-owned codes without inspected values, and ordinary run projections omit persistence snapshots, internal events, observations, unsigned transactions, detailed V3 evidence and approval proof material. Public projection and reconstruction failures return only `SERVICE_UNAVAILABLE`; partial artifacts are never emitted.

**DECISION** — The API never trusts forwarded host headers or client-supplied hashes, signer identities, Brickken identifiers, methods, chain configuration or server configuration.

## Run capability

**DECISION** — The read-only `GET /api/runs/[runId]` accepts an absent `Origin` for ordinary browser reads. A present `Origin` must exactly match the trusted origin; present `Sec-Fetch-Site: cross-site` is refused, and absent Fetch Metadata is allowed. Capability verification still precedes repository lookup. Reads perform no mutation, remain `no-store`, and grant no CORS permissions. Host, forwarded headers and referrer are not origin authority. Every mutation retains the exact trusted-origin requirement.

**DECISION** — HTTPS and production creation issue one 24-hour bearer capability in `__Host-edict_run_access` with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and no `Domain`. It is never returned in JSON, placed in a URL, logged or persisted. Creating another run replaces the browser's active capability, which is an accepted MVP limitation.

**DECISION** — With `NODE_ENV=development` or `test` and an explicitly configured exact HTTP loopback origin (`localhost`, `127.0.0.1`, or `[::1]`), use only `edict_run_access_dev`: HttpOnly, SameSite=Strict, Path=/, no Domain, and Secure=false. This avoids dependence on browser-specific Secure-cookie exceptions for HTTP localhost. Production, HTTPS and unknown runtime modes always retain the secure policy. The policy is selected from server configuration, never Host, forwarded headers or referrer. Mutation origins must still match exactly; the existing originless browser GET rule remains unchanged.

**DECISION** — Creation, all run-scoped authorization and cookie serialization/clearing select the same policy, with no fallback to the other name. Clearing uses Max-Age=0 with the selected name and scope; cancellation preserves access for terminal-state review. Rotating the security secret and restarting invalidates older capabilities, so reload and create a fresh run. This cookie policy does not enable Brickken writes, wallets, RPC or external execution.

**DECISION** — Capability and approval-challenge MACs are Web Crypto HMAC-SHA-256 values using purpose-specific keys derived from one server secret. A token from one purpose cannot authenticate the other.

**DECISION** — `/records/[runId]` passes only a syntactically validated public run ID to the client workspace. On mount it makes one read-only GET and no mutation, wallet, Brickken or RPC action. Refresh and another tab in the same browser/profile can reconstruct while the capability is valid. Missing, expired, replaced, rotated or wrong-run capabilities fail generically before lookup. A different browser/profile cannot recover from the URL alone.

## Wallet approval

**DECISION** — Approval is an EIP-712 EOA signature over fixed fields binding run ID, manifest and plan SHA-256 values represented as `bytes32`, sandbox environment, Sepolia chain, approval revision, required signer, nonce, timestamps and approval version. The server recovers the exact tokenizer signer with pinned `viem@2.56.3`; it does not accept a claimed address or personal-sign fallback and makes no RPC request. EIP-1271 contract-wallet approval is unsupported.

**DECISION** — The production browser gateway calls only `GET /api/runs/[runId]`, `POST /api/runs/[runId]/approval-challenges`, and `POST /api/runs/[runId]/approval`. It sends only the existing exact request fields, strictly validates bounded JSON responses and preserves the server-issued serialized typed-data string byte-for-byte. The approval POST response is parsed but never treated as authority; one independent durable GET is required and mutations are never retried automatically.

**DECISION** — New V2 run snapshots persist bounded public proof sufficient to reconstruct signature recovery. V1 remains backward-decodable. Capabilities, challenge tokens and server secrets are not persisted, and the proof/signature is omitted from ordinary API projections.

## Durable orchestration

**DECISION** — Every mutation supplies an expected revision and commits through repository compare-and-swap. Prepare and confirmation check the write gate before any mutation, validate revision/approval/order, persist intent, check the gate immediately before the injected adapter, and call it at most once. Current production composition constructs the server-only adapter only after the general API deployment gate passes; the independent preparation gate permits only `PREPARE`, while confirmation remains refused.

**DECISION** — One prepare-intent CAS wins. A stranded intent is not retried automatically. A prepared response is returned only after its complete unsigned transaction is durable. Indeterminate prepare/broadcast outcomes require manual reconciliation. Once a transaction hash exists, no replacement prepare, wallet prompt or broadcast is permitted. Confirmation retries use only the persisted `{txId, txHash}` pair; pending operations are poll-only.

**CONTROLLED OBSERVATION — 2026-09-09** — An authorized preparation-only diagnostic proved that the production request shape reaches the sandbox, but Brickken returned a definite HTTP 400 license/subscription/entitlement refusal with no prepared identifier or transaction. The adapter previously collapsed the SDK's generic HTTP 400 `ApiError` into an ambiguous external-response error; it now maps that received status to existing definite refusal codes. The two attempted runs remain `PREPARE_UNKNOWN/RECONCILIATION_REQUIRED` and are never retried. Successful live preparation, signer/license/credit readiness, wallet compatibility, finality, and write completion remain unverified; all post-preparation actions remain structurally unavailable.
