# Phase 6 run API and orchestration contract

## Status and public surface

**DECISION** — Phase 6 is complete. Its only callable routes are:

- `POST /api/runs`
- `GET /api/runs/[runId]`
- `POST /api/runs/[runId]/approval-challenges`
- `POST /api/runs/[runId]/approval`
- `POST /api/runs/[runId]/cancel`

**DECISION** — Prepare, wallet prompt/result, confirmation, polling, read-back and final-verification methods exist only on the injected internal orchestration boundary. They are deliberately not public routes in Phase 6.

**DECISION** — Phase 7 does not expand this surface. Its browser coordinator uses an injected gateway contract for offline verification only; no public external-effect route or production gateway composition exists. Brickken writes and transaction semantic authorization remain disabled. See [`WALLET_EXECUTION_SPEC.md`](WALLET_EXECUTION_SPEC.md).

**DECISION** — Phase 8 also leaves this surface unchanged at exactly five routes. `ExecutionRunV3` evidence is persisted only through internal validated transitions; the existing run projection omits raw unsigned transactions and detailed evidence. The compatibility harness lives under `tools/phase8-harness/`, is excluded from the production build, and is not a Next.js route. Production semantic authorization and Brickken writes remain disabled.

## Deployment and request gates

**DECISION** — The public run API is deny-by-default. An operator must configure deployment-level preview access or rate limiting, set `EDICT_RUN_API_ENABLED=1`, configure an exact `EDICT_TRUSTED_ORIGIN`, supply durable `DATABASE_URL` persistence, and provide a base64url server secret decoding to at least 32 random bytes as `EDICT_RUN_SECURITY_SECRET`. Missing, malformed or partial configuration keeps the API disabled. The creation gate is checked before reading or validating a manifest and before constructing database, security or Brickken dependencies.

**DECISION** — Mutating requests require an exact trusted `Origin`, `application/json`, strict request shapes, a bounded body read, and an expected positive revision. Run-scoped routes require the opaque run capability before repository lookup. Responses are `no-store`, errors use application-owned codes without inspected values, and ordinary run projections omit persistence snapshots, internal events and approval proof material.

**DECISION** — The API never trusts forwarded host headers or client-supplied hashes, signer identities, Brickken identifiers, methods, chain configuration or server configuration.

## Run capability

**DECISION** — The read-only `GET /api/runs/[runId]` accepts an absent `Origin` for ordinary browser reads. A present `Origin` must exactly match the trusted origin; present `Sec-Fetch-Site: cross-site` is refused, and absent Fetch Metadata is allowed. Capability verification still precedes repository lookup. Reads perform no mutation, remain `no-store`, and grant no CORS permissions. Host, forwarded headers and referrer are not origin authority. Every mutation retains the exact trusted-origin requirement.

**DECISION** — Creation issues one 24-hour bearer capability in `__Host-edict_run_access` with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and no `Domain`. It is never returned in JSON, placed in a URL, logged or persisted. Creating another run replaces the browser's active capability, which is an accepted MVP limitation.

**DECISION** — Local development retains `Secure`; use localhost as a secure context in a supporting browser or local HTTPS. Do not weaken cookie attributes for development.

**DECISION** — Capability and approval-challenge MACs are Web Crypto HMAC-SHA-256 values using purpose-specific keys derived from one server secret. A token from one purpose cannot authenticate the other.

## Wallet approval

**DECISION** — Approval is an EIP-712 EOA signature over fixed fields binding run ID, manifest and plan SHA-256 values represented as `bytes32`, sandbox environment, Sepolia chain, approval revision, required signer, nonce, timestamps and approval version. The server recovers the exact tokenizer signer with pinned `viem@2.56.3`; it does not accept a claimed address or personal-sign fallback and makes no RPC request. EIP-1271 contract-wallet approval is unsupported.

**DECISION** — New V2 run snapshots persist bounded public proof sufficient to reconstruct signature recovery. V1 remains backward-decodable. Capabilities, challenge tokens and server secrets are not persisted, and the proof/signature is omitted from ordinary API projections.

## Durable orchestration

**DECISION** — Every mutation supplies an expected revision and commits through repository compare-and-swap. Prepare and confirmation check the write gate before any mutation, validate revision/approval/order, persist intent, check the gate immediately before the injected adapter, and call it at most once. Production composition for the callable Phase 6 routes constructs no write-capable Brickken adapter.

**DECISION** — One prepare-intent CAS wins. A stranded intent is not retried automatically. A prepared response is returned only after its complete unsigned transaction is durable. Indeterminate prepare/broadcast outcomes require manual reconciliation. Once a transaction hash exists, no replacement prepare, wallet prompt or broadcast is permitted. Confirmation retries use only the persisted `{txId, txHash}` pair; pending operations are poll-only.

**OPEN QUESTION** — No authenticated Brickken write has occurred. Signer approval, tokenizer licensing, credits, prepared write payloads, wallet compatibility, finality and write behavior remain unverified. The write gate must remain disabled until the corresponding human-authorized validation is complete.
