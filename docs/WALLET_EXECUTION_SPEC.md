# Phase 7 browser wallet compatibility contract

## Status and safety posture

**DECISION — Browser-wallet composition behind production deny-all, 2026-09-12** — The canonical record UI now composes the existing EIP-6963 discovery and `SelectedWalletSession` with a V4-only HTTP gateway and one-shot coordinator. The browser never constructs semantic or transaction authority. `POST /wallet-authorization` accepts only the displayed revision; only a test-injected allow evaluator can release an envelope, and release occurs after durable `INVOKED_OR_UNKNOWN` CAS. Production uses the default `DenyAllSemanticAuthorizationEvaluator`, so no usable envelope or provider send can be reached.

**DECISION — Wallet-boundary hardening, 2026-09-12** — There is one product `eth_sendTransaction` invocation site. After authority release, the selected session asserts its captured provider generation, reads and validates Sepolia chain, reads and validates the exact required signer at any account index, asserts the same generation again, and performs the single send. The last generation assertion is inside the provider-invocation closure immediately before calling the captured provider `request` reference. Chain, account, or generation changes observed at the latest injectable pre-send reads fail closed and are reconciled as post-authority ambiguity; they never cause a replacement send.

**ASSUMPTION — EIP-1193 provider atomicity limit** — EIP-1193 does not provide an atomic “read chain/accounts and send” primitive. A provider could silently change internal chain/account state after returning the final reads without emitting `chainChanged`/`accountsChanged`, or reinterpret state inside its own `request` implementation. Browser code cannot eliminate that provider-internal interval. Edict minimizes it, pins the selected provider method identity and event generation, binds `from` and the complete transaction request, and treats any observable change or uncertain result as non-retryable reconciliation. Named wallet/version compatibility still requires a separately authorized sandbox test.

**DECISION — Authorization transport taxonomy** — The browser gateway distinguishes production deny-all, revision conflict, authorization-response unknown, malformed response, sanitized server rejection, and malformed local request. It never retries authorization. Revision conflict, malformed/unknown authorization response, and other authorization refusal lock the UI behind a durable run refresh. Any post-authority ambiguity also triggers durable refresh and leaves stale `PREPARED` props unable to select another provider or start another send.

**DECISION — TOKENIZE-only server policy checkpoint, 2026-09-12** — The server has a production-capable TOKENIZE evaluator behind exact private gate `EDICT_TOKENIZE_EXECUTION_ENABLED=1`. Gate absence, `0`, arbitrary values, missing/malformed policy, or any public-prefixed TOKENIZE policy variable fail closed. Valid policy additionally requires an exact nonzero destination, canonical human-readable function signature, and exact SHA-256 calldata commitment; the selector is derived from the signature, never copied from a transaction fixture. The evaluator recomputes every durable binding and emits only bounded Edict-owned denial codes. Browser requests remain exactly `{expectedRevision}` and cannot select or toggle policy.

**OPEN QUESTION — activation trust roots** — `brickken-sdk@0.2.1` authoritatively maps the SDK operation to Dapp method `newTokenization`, and official Brickken documentation identifies `POST /prepare-transactions` plus `client-broadcast`. The inspected package does not ship the deployment-contract ABI or authoritative Sepolia destination. Therefore destination and selector signature remain operator-reviewed private inputs and live activation is blocked until their provenance is independently verified. The sourced response fixture's `0x4444…` destination and `0xd362e8a7` prefix are test placeholders only and are not configured.

**DECISION — final activation boundary, corrected 2026-09-13** — The minimum product composition is explicitly ordered: promote V2 PREPARED, check V4 readiness, select/check the wallet, authorize/send once, then invoke tracking. No step triggers the next automatically. Production V4 tracking calls the existing exact-pair correlation adapter and hardened status adapter; it never uses the legacy confirmation alias. Transaction-status text is opaque evidence and cannot advance lifecycle. TOKENIZE identity is derived only from the exact finalized receipt's unique reviewed-factory `NewTokenization` event after implementation-at-block verification; server token/tokenizer reads may only confirm that address. Callers cannot submit an identity.

**DECISION** — `SendAuthorizedEnvelopeV1` contains only `domain`, post-release `expectedRevision`, server-generated `invocationAttemptId`, canonical `walletIntentHash`, `requiredSigner`, the fixed Sepolia chain requirement, and the exact frozen `WalletTransactionRequestV1` reprojected from the durable active preparation after the final CAS. The client strictly parses and freezes it, rechecks provider generation/account/chain, preserves the explicit nonce and fees, and makes exactly one `eth_sendTransaction` request. It never signs raw transactions or calls `eth_sendRawTransaction`.

**DECISION** — Every failure after an envelope may be ambiguous. The client attempts one bounded `broadcast-unknown` report; report failure does not unlock the durable invocation. A valid canonical hash is submitted alone with revision/invocation/hash bindings to `broadcast-hash`. Neither browser result route calls Brickken or RPC, and neither permits an operation, signer, chain, destination, calldata, nonce, gas, fee, or internal state supplied by the browser.

**HISTORICAL DECISION** — Phase 7 completed the offline, vendor-neutral browser primitives. Later checkpoints composed their strict routes and UI while retaining production deny-all.

**DECISION** — The Phase 9C transport checkpoint adds a dormant production same-origin `ApprovalGateway` for the existing three approval reads/writes. It uses the existing strict public run DTO, validates complete challenge and approval envelopes, bounds response bodies, sends same-origin credentials, refuses redirects and caching, and adds no route or wallet/provider/UI activation.

**DECISION** — The Phase 9D product checkpoint composes only provider discovery and wallet readiness into the recorded-plan UI. Mount starts passive EIP-6963 discovery; provider and legacy selection, account access, Sepolia switching, and reinspection are explicit actions. Readiness requires the exact durable-run tokenizer signer at any authorized account index and chain `11155111` (`0xaa36a7`). Provider events, mutation, collision, run/revision change, and disposal invalidate the local session. The product stops at **Ready to approve**: the approval gateway and coordinator remain dormant, and no challenge, signature, proof submission, persistence mutation, transaction, Brickken call, or RPC execution is reachable from this UI.

**DECISION** — Phase 9E activates that previously dormant approval path through one explicit **Approve this plan** action. The approval authority snapshot now binds the displayed run, revision, manifest hash, plan hash, environment, chain, and exact signer to the coordinator's preflight and final durable classification. Rapid clicks are synchronously serialized. A signature or approval POST never establishes success; only the exact same-authority `approved=true`, revision `N+1`, `TOKENIZATION/PREPARING`, nonterminal durable GET does. Submission uncertainty locks further signing until one explicit read-only status refresh. The UI stops at **Approval recorded** and composes no transaction-execution module or external write path.

**HISTORICAL DECISION** — At the approval checkpoint, production execution remained disabled and the callable route inventory was exactly:

- `POST /api/runs`
- `GET /api/runs/[runId]`
- `POST /api/runs/[runId]/approval-challenges`
- `POST /api/runs/[runId]/approval`
- `POST /api/runs/[runId]/cancel`

No public prepare, wallet-prompt, wallet-result, confirmation, polling, read-back, verification, or receipt route exists.

**ASSUMPTION** — Fake-provider and sourced-fixture tests establish Edict behavior only. They are not authenticated Brickken evidence and do not verify any named wallet. Rabby, MetaMask, Coinbase Wallet, and every other wallet/version remain unverified and receive no privileged behavior.

## Discovery and selection

**DECISION** — EIP-6963 announcements are collected passively without provider requests. Metadata is untrusted, copied through descriptor-safe validation, and cannot establish capability. Duplicate identities are collision-marked. Late announcements remain visible, and no provider is selected automatically.

**DECISION** — A user explicitly selects one stable provider reference. The narrowly scoped legacy-provider path is lazy and explicit; code does not assume the first provider or access `window.ethereum` implicitly. Account authorization and chain switching require separate user actions.

**DECISION** — Capability states distinguish unverified, structurally eligible, approval-capable, and execution-capable. Structural checks and fake tests never promote a wallet to verified.

## Approval contract

**DECISION** — The server remains authoritative for EIP-712 approval material. It supplies the structured typed data, its digest, an exact RPC-ready serialized string, the required signer parameter, and an opaque challenge token. One shared constant defines the five-minute challenge lifetime.

**DECISION** — The browser validates the strict challenge shape and checks structured-versus-serialized typed data, digest, run and plan identities, signer, Sepolia chain, approval revision, nonce, issue time, expiry, and lifetime. It passes the exact server-issued string to `eth_signTypedData_v4`; it does not reconstruct the request. It submits only expected revision, challenge token, and public signature, then rereads durable approval state.

**DECISION** — Gateway failures use only application-owned classes: access unavailable, run unavailable, stale/state conflict, request refused, service unavailable, malformed request/response, or transport failure. Raw response, transport, security, challenge-MAC and provider diagnostics never cross the boundary. The gateway performs no automatic retry.

**DECISION** — A signature and a successful approval POST are both non-authoritative. After one approval POST attempt, the coordinator performs exactly one read-only durable GET. Only the same run, manifest hash, plan hash, signer, environment and chain at revision `N+1` with `approved=true`, `TOKENIZATION/PREPARING` and no terminal outcome establishes `APPROVAL_RECORDED`. A valid unapproved reread yields `APPROVAL_NOT_RECORDED`; an inaccessible reread yields `ACCESS_UNAVAILABLE`; and a failed or semantically unsafe reread yields `APPROVAL_UNCONFIRMED`. No challenge, signature or approval POST is automatically repeated.

**DECISION** — There is no `personal_sign` or EIP-1271 fallback. Edict never requests, receives, stores, logs, or fabricates private keys or seed phrases.

## Strict prepared-transaction projection

**DECISION** — `WalletTransactionRequestV1` is the only wallet-send DTO. It is newly allocated, deeply readonly, runtime-frozen, and restricted to `from`, `to`, `gas`, `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `value`, `data`, `nonce`, `type`, and `accessList`. Unknown, accessor-backed, non-enumerable, sparse, unsupported, or malformed fields are refused without inspecting values in error output.

**DECISION** — Projection accepts the sourced Brickken quantity encodings—safe non-negative integers, decimal strings, hexadecimal strings, and exact `{ type: "BigNumber", hex }` wrappers—and normalizes them through `bigint` to minimal lowercase RPC quantities. It preserves absent versus explicit zero. `data`/`input` and `gas`/`gasLimit` aliases must be equivalent when both exist. Legacy, EIP-2930, and EIP-1559 fee fields may not conflict or be incomplete.

**DECISION** — The exact validated and frozen `walletRequest` is passed to `eth_sendTransaction`. No later code enriches it, estimates fields, inserts defaults, rewrites aliases, or permits a wallet abstraction to fill a field that Edict retained.

## Canonical wallet intent

**DECISION — V4 wallet execution intent** — The new canonical `WalletExecutionIntentV1` separates and hash-binds: immutable execution identity (`chainId`, `from`, `to`, `data`, `value`, `nonce`); bounded EIP-1559 fee authorization; Brickken preparation identity (`method`, `executionMode`, attempt ID, `txId`, preparation fingerprint); run/revision, approval digest/revision, manifest/plan hashes, operation, signer and environment; and an independently evaluated semantic-policy decision. The calldata commitment is integrity evidence only and is never described as proof of transaction meaning.

**DECISION** — Exact prepared gas values remain hash-bound defaults. Initial caps equal those defaults, and `maximumNetworkFeeWei = maximumGasLimit × maximumMaxFeePerGas` is computed with exact integer arithmetic. Actual gas fields may decrease, but legacy `gasPrice`, type or fee-model switching, access-list changes, any individual cap increase, or a product above the network-fee cap violates policy. `FeeAuthorizationV1` is an authorization and audit boundary; it cannot physically control an external wallet after provider invocation. Production semantic authorization and wallet submission remain deny-all.

**DECISION** — The server rederives the prompt envelope from the durable `WALLET_PROMPT_RECORDED` run and never treats a client-supplied intent hash as authority. The browser validates the strict envelope, reconstructs the same intent, and recomputes the hash before invoking the provider. Raw Brickken responses, persistence snapshots, emails, API headers, and unvalidated transaction objects are not part of the browser prompt.

## Chain-ID projection rule

**DECISION** — The validated prepared transaction retains and validates Brickken's `chainId`. `WalletIntentV1` binds decimal Sepolia `11155111`, while the prompt records the provider precondition as RPC chain ID `0xaa36a7`. Transaction-level `chainId` is the one prepared field omitted from `WalletTransactionRequestV1`.

**DECISION** — The omission is enforced with persisted Sepolia configuration, `eth_chainId`, explicit post-switch inspection, immediate pre-send inspection, a stable provider-session generation, and `chainChanged` invalidation. This provider precondition is not universally atomic and is not assumed equivalent across wallets.

**DECISION** — Live execution cannot be enabled until a controlled wallet/version test establishes either that the wallet safely accepts transaction-level `chainId`, or that its active-chain behavior preserves Edict's intended signed-chain constraint with the field represented as a provider precondition. A wallet unable to represent the complete Edict projection safely is execution-incompatible; no wallet-specific rewriting is allowed.

## Trusted nonce freshness and stale preparation

**DECISION** — Browser/provider inspection selects the provider, authorizes the account, proves the required signer is selected, and proves Sepolia readiness. It is not authoritative for prepared-nonce freshness. Immediately before prompt authorization, the server must use trusted Sepolia RPC `eth_getTransactionCount(requiredSigner, "pending")` and persist the result with `preparedAt`, `freshnessPolicyVersion`, and `freshnessEvaluatedAt`. Edict does not invent a Brickken expiry.

**DECISION** — A nonce mismatch produces `PREPARED_STALE` and prohibits wallet invocation. Only an explicit user action may enter `REPREPARE_INTENT` and authorize one new preparation for the same operation. The prior attempt remains immutable. No new run or plan approval is required when manifest and plan semantics are unchanged; no nonce is changed locally.

## Invocation ambiguity and retry rules

**DECISION** — A durable wallet-prompt transition must succeed before `eth_sendTransaction`. A second CAS must durably change prompt authority from `PROVEN_NOT_INVOKED` to `INVOKED_OR_UNKNOWN`, bind a unique invocation-attempt ID and record authority release before the execution-authorized envelope is released to the browser. `PROVEN_NOT_INVOKED` is server proof that send authority was never released; it can never be restored or established by an untrusted post-authority client claim. Only the CAS winner may make that one provider call. A crash after authority release but before invocation remains conservatively unknown.

**DECISION** — Account/chain revalidation, provider-generation checks, prompt validation, intent mismatch, semantic refusal, or durable prompt failure before invocation cause zero send calls and are not labeled potentially broadcast. A durable prompt may remain as the replay lock; local validation failure is not falsely recorded as user rejection.

**DECISION** — Once the provider method has been invoked, every rejected, timed-out, malformed, disconnected or otherwise unsuccessful result is potentially broadcast, including provider code `4001`. A `4001` is definite cancellation only when Edict proves invocation never began; an error returned by the provider is not that proof. A valid nonzero transaction hash is handed to durable storage immediately. Every other post-invocation outcome requires reconciliation and cannot authorize another prompt or resend.

**DECISION** — Failed hash handoff triggers a read of durable state only. A matching stored hash is accepted; otherwise the run remains blocked for reconciliation. The coordinator never sends again, prepares a replacement, or creates a replacement transaction automatically.

**DECISION** — A post-authority browser disappearance, browser assertion of non-invocation, provider `4001`, provider timeout, provider error, or unconfirmed hash handoff all persist as `BROADCAST_UNKNOWN/RECONCILIATION_REQUIRED`. None can restore `PROVEN_NOT_INVOKED` or authorize a second send.

## Brickken correlation

**SUPPORT-CONFIRMED — 2026-09-11** — After the wallet returns a hash, Edict persists it by CAS before any Brickken call. `POST /send-transactions {txId,txHash}` correlates the already-broadcast transaction; it does not broadcast. A successful correlation is HTTP 202 with `results[0].result` containing the matching hash, `pending`, and `client-broadcast`. The same pair is idempotent and may receive at most one initial call plus two bounded retries. A changed identifier or any further `eth_sendTransaction` call is forbidden.

**DECISION** — Trusted RPC first compares the six immutable fields and separately evaluates fees. A six-field mismatch persists distinct reconciliation evidence, preserves the hash, continues trusted-RPC observation, forbids correlation and never resubmits. A six-field match with fees outside `FeeAuthorizationV1` persists `POLICY_VIOLATION_ONCHAIN`, preserves the hash, continues transaction/receipt/finality evidence, and may correlate only the same durable `txId + txHash`; that Brickken correlation records an already-broadcast reality and is not a second blockchain submission. Policy-violation evidence is not approval: the run remains `RECONCILIATION_REQUIRED`, never automatically advances to WHITELIST/MINT, and requires an operator decision after chain state is known. Normal correlation progresses `BROADCAST_HASH_PERSISTED → RPC_TRANSACTION_VERIFIED → BRICKKEN_CORRELATION_PENDING → BRICKKEN_CORRELATED`. Temporary mempool not-found or transport uncertainty stays correlation-pending. Recovery may observe `GET /transaction-status`, but its raw text never authorizes lifecycle changes. TOKENIZE advances only after compliant fees, exact correlation, matching successful canonical finalized RPC evidence, exact receipt-block implementation proof, one authoritative reviewed-factory `NewTokenization` event, secondary read confirmation, and durable `TokenIdentityV1`.

**DECISION** — Phase 8 captures the provider object and descriptor-backed `request`, `on`, and `removeListener` methods once; accessor-backed methods, later mutation, partial listener registration, stale generations, duplicate initialization and collision races fail closed. Provider snapshot generation spans the complete account/chain read pair. A hostile `Proxy` can still execute its own reflection traps in the same JavaScript realm; Edict catches and sanitizes failures but does not claim those traps are harmless.

**DECISION** — Provider deadlines are 10 seconds for passive account/chain reads, 120 seconds for account access, chain switching and typed-data signing, and 180 seconds for transaction sending. Timeout never cancels a provider promise and never triggers automatic retry. A timed-out send is potentially broadcast; late settlement cannot revive the invalidated attempt.

**DECISION** — Phase 8 resource ceilings are: provider name 100 code units, RDNS 255, icon data URI 65,536, 64 accounts, chain response 66 code units, challenge 4,096, typed-data serialization 16,384, signature 132, transaction hash 66, transaction object 16 properties, calldata 131,072 bytes, 256 access-list entries, 256 storage keys per entry and 4,096 total, 256-bit unsigned quantities, external depth 16 and 10,000 nodes, Brickken and trusted-RPC responses 1,048,576 code units each, compatibility evidence 262,144 code units, and harness bodies 65,536 bytes. Values are refused, never truncated.

## Phase 9 offline TOKENIZE compatibility

**DECISION** — Phase 9 establishes representational compatibility using existing production code only. The positive case is the unchanged `newTokenization.response.json` encoding A example; its provenance is recorded in `src/server/brickken/test-vectors/index.json` and the [wire-contract audit](BRICKKEN_WIRE_CONTRACT_AUDIT.md#5-prepared-transaction-and-browser-wallet-contract). Its truncated example calldata and placeholder destination are not live Brickken evidence or authorization metadata. No fixture or provenance was changed.

**DECISION** — The focused composition lives in `src/server/orchestration/wallet-intent.test.ts`:

```text
checked-in prepare example
→ parsePreparedOperation (single transaction, required fields, Sepolia)
→ existing ExecutionRunService transitions in an in-memory repository
→ deriveWalletPromptEnvelopeFromRun (exact required signer and chain)
  → projectPreparedTransactionV1
  → explicit test-only semantic policy
  → createWalletPromptEnvelopeV1 / hashWalletIntentV1
→ JSON round-trip
→ validateWalletPromptEnvelopeV1 (the browser's existing recomputation)
```

**DECISION** — No compatibility API, result type, production module, route or persisted report is needed. Test-only policy injection reaches representation hashing; the actual `denyAllWalletSemanticPolicy` still refuses the same transaction before producing a prompt envelope. Compatibility grants no permission to prepare, sign, broadcast or confirm and proves no destination/calldata safety, tokenizer ownership, licensing or credits. No wallet-actionable output is enabled.

| Signing field | Existing behavior exercised or retained |
| --- | --- |
| `from`, `to` | Validate addresses; canonical lowercase preserves address identity. Required signer must match exactly after normalization. |
| `data` / `input` | Preserve bytes, normalize hex case; conflicting aliases fail. This prepared-parser contract still requires `data`. |
| `gasLimit` / `gas` | Preserve integer value as minimal hex `gas`; conflicting aliases fail. The prepared parser still requires `gasLimit`. |
| `value`, `nonce`, `type`, EIP-1559 fees | Preserve values through established quantity normalization, without defaults. Unsupported types, malformed quantities, unsafe numbers and conflicting fees fail. |
| `chainId` | Require Sepolia; bind decimal chain in the intent and RPC chain in the provider precondition. Omit transaction-level chain only under the unchanged Phase 7 rule above. |
| `gasPrice` | Never silently dropped: adding it to the accepted EIP-1559 shape is refused. Legacy-only prepares remain incomplete under the current required-field contract. |
| `accessList` | Optional; retain order and normalized addresses/storage keys, deeply frozen. Synthetic structural coverage reuses existing projection-test values and proves no Brickken access-list behavior. |

**DECISION** — Missing required fields and zero/multiple transactions fail closed; absent optional fields remain absent. Unknown signing properties are refused by strict projection. Tests assert deterministic requests/hashes, unchanged inputs, frozen public envelopes, browser tamper refusal and semantic denial. Stable existing errors are reused: `UNSUPPORTED_TRANSACTION_BATCH`, `UNSUPPORTED_CHAIN`, `PREPARED_TRANSACTION_INCOMPLETE`, `INVALID_EXTERNAL_RESPONSE`, `CONFLICTING_TRANSACTION_FIELDS`, `UNSUPPORTED_SIGNING_FIELD`, `MALFORMED_PREPARED_TRANSACTION`, `UNSAFE_NUMBER`, `EXECUTION_INVARIANT_FAILED` and `WALLET_INTENT_HASH_MISMATCH`. No new error framework is introduced.

**DECISION** — TOKENIZE is the only Phase 9 operation. Whitelist and mint remain outside this phase. No live Brickken response was obtained, and no provider, wallet, RPC, Neon or blockchain operation occurred. Any later account-backed evidence requires separate authorization and handling by the authorized Brickken account holder or administrator. Phase 8 and provider-session/ambiguity rules remain unchanged. Phase 9 is closed after offline verification; do not reopen without a product scope change or concrete in-scope defect, and do not begin Phase 10 as part of this work.

## Phase 10 prepared transaction review boundary

**DECISION** — Phase 10 activates only explicit server preparation of the exact next TOKENIZE operation. The browser submits only the displayed expected revision to `POST /api/runs/[runId]/prepare`; it cannot select WHITELIST/MINT or supply transaction fields. The server rederives the manifest/plan and operation from durable approved state, preserves the existing single-winner CAS and double-gate sequence, and returns a review only after the exact prepared transaction is durable.

**DECISION** — `PreparedTransactionReviewV1` is a non-authorizing review envelope. Its canonical SHA-256 fingerprint binds the run ID and revision, approval revision, hashes, operation, signer, sandbox/Sepolia constraints, Brickken `newTokenization`/`client-broadcast` identity, prepared transaction ID and exact normalized wallet request. The response is strict and bounded; no mutable upstream object, raw response, capability, proof, credential or secret is exposed. Destination, value, fees and exact calldata are displayed, but calldata semantics remain `OPAQUE_SERVER_PREPARED` because production semantic authorization is still deny-all.

**DECISION** — Preparation and wallet authorization remain separate. Preparing ends at durable `TOKENIZE/PREPARED` and `TOKENIZATION/AWAITING_WALLET`; it does not call `recordWalletPrompt`, create a prompt-bound WalletIntent, inspect a provider, sign, or invoke `eth_sendTransaction`. The existing `WalletIntentV1` remains the sole future wallet-action identity and must be freshly rederived against the later prompt revision and semantic policy. No prompt or send control is composed in the product.

**DECISION** — Preparation is single-attempt. Concurrent requests are resolved by repository CAS. A lost browser response causes one read-only durable GET, never another POST. `PREPARE_INTENT` and `PREPARE_UNKNOWN/RECONCILIATION_REQUIRED` disable repeat preparation; refresh/direct recovery only displays the persisted state. No transaction hash or later execution evidence exists at this boundary.

## Evidence still required

Before any wallet or Brickken execution path is enabled, a human-authorized sandbox test must establish all of the following without exposing credentials:

1. the exact tokenizer signer is approved, funded on Sepolia, licensed, and has sufficient Brickken credits;
2. live tokenization, whitelist, and mint preparation each produce exactly one response compatible with the strict projection;
3. a controlled wallet/version displays and sends every retained field correctly and preserves the Sepolia constraint under the documented chain rule;
4. the returned hash is durably recorded, accepted by Brickken for the identical prepared transaction ID, and reaches the expected finality;
5. standalone whitelist followed by `needWhitelist: false` mint behaves as assumed; and
6. post-write Brickken reads support the required requested-versus-observed verification.

**CONTROLLED OBSERVATION — 2026-09-09** — One diagnostic TOKENIZE preparation reached Brickken with the intended `client-broadcast` request but received a definite HTTP 400 JSON license/subscription/entitlement refusal and no transaction. It therefore proves request transport, not prepared-output or wallet compatibility. The run remains blocked, and no wallet provider was invoked.

The controlled preparation-only diagnostics did not produce a prepared transaction. No wallet signature, wallet broadcast, Brickken reconciliation, or finality test has occurred.
