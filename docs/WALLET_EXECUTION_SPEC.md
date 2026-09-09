# Phase 7 browser wallet compatibility contract

## Status and safety posture

**DECISION** — Phase 7 is complete as an offline, vendor-neutral browser boundary. It adds EIP-6963 discovery, explicit provider selection, EIP-1193 approval signing, strict prepared-transaction projection, canonical wallet-intent integrity, and durable prompt/send/hash-handoff coordination. It adds no UI and no callable route.

**DECISION** — The Phase 9C transport checkpoint adds a dormant production same-origin `ApprovalGateway` for the existing three approval reads/writes. It uses the existing strict public run DTO, validates complete challenge and approval envelopes, bounds response bodies, sends same-origin credentials, refuses redirects and caching, and adds no route or wallet/provider/UI activation.

**DECISION** — The Phase 9D product checkpoint composes only provider discovery and wallet readiness into the recorded-plan UI. Mount starts passive EIP-6963 discovery; provider and legacy selection, account access, Sepolia switching, and reinspection are explicit actions. Readiness requires the exact durable-run tokenizer signer at any authorized account index and chain `11155111` (`0xaa36a7`). Provider events, mutation, collision, run/revision change, and disposal invalidate the local session. The product stops at **Ready to approve**: the approval gateway and coordinator remain dormant, and no challenge, signature, proof submission, persistence mutation, transaction, Brickken call, or RPC execution is reachable from this UI.

**DECISION** — Production execution remains disabled. The production semantic policy is deny-all, Brickken writes remain gated off, and the callable route inventory remains exactly:

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

**DECISION** — `WalletIntentV1` is an explicit canonical JSON object, not concatenated text. Its SHA-256 integrity hash binds the domain tag, run ID, manifest hash, plan hash, sandbox environment, operation ID and kind, prepared transaction ID, required signer, Sepolia chain ID, durable prompt revision, wallet-request version, and exact canonical wallet request.

**DECISION** — The server rederives the prompt envelope from the durable `WALLET_PROMPT_RECORDED` run and never treats a client-supplied intent hash as authority. The browser validates the strict envelope, reconstructs the same intent, and recomputes the hash before invoking the provider. Raw Brickken responses, persistence snapshots, emails, API headers, and unvalidated transaction objects are not part of the browser prompt.

## Chain-ID projection rule

**DECISION** — The validated prepared transaction retains and validates Brickken's `chainId`. `WalletIntentV1` binds decimal Sepolia `11155111`, while the prompt records the provider precondition as RPC chain ID `0xaa36a7`. Transaction-level `chainId` is the one prepared field omitted from `WalletTransactionRequestV1`.

**DECISION** — The omission is enforced with persisted Sepolia configuration, `eth_chainId`, explicit post-switch inspection, immediate pre-send inspection, a stable provider-session generation, and `chainChanged` invalidation. This provider precondition is not universally atomic and is not assumed equivalent across wallets.

**DECISION** — Live execution cannot be enabled until a controlled wallet/version test establishes either that the wallet safely accepts transaction-level `chainId`, or that its active-chain behavior preserves Edict's intended signed-chain constraint with the field represented as a provider precondition. A wallet unable to represent the complete Edict projection safely is execution-incompatible; no wallet-specific rewriting is allowed.

## Invocation ambiguity and retry rules

**DECISION** — A durable wallet-prompt transition must succeed before `eth_sendTransaction`. Immediately before the direct provider call, the coordinator marks provider invocation as started without an asynchronous boundary between the marker and the call.

**DECISION** — Account/chain revalidation, provider-generation checks, prompt validation, intent mismatch, semantic refusal, or durable prompt failure before invocation cause zero send calls and are not labeled potentially broadcast. A durable prompt may remain as the replay lock; local validation failure is not falsely recorded as user rejection.

**DECISION** — Once the provider method has been invoked, every rejected, timed-out, malformed, disconnected or otherwise unsuccessful result is potentially broadcast, including provider code `4001`. A `4001` is definite cancellation only when Edict proves invocation never began; an error returned by the provider is not that proof. A valid nonzero transaction hash is handed to durable storage immediately. Every other post-invocation outcome requires reconciliation and cannot authorize another prompt or resend.

**DECISION** — Failed hash handoff triggers a read of durable state only. A matching stored hash is accepted; otherwise the run remains blocked for reconciliation. The coordinator never sends again, prepares a replacement, or creates a replacement transaction automatically.

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

## Evidence still required

Before any wallet or Brickken execution path is enabled, a human-authorized sandbox test must establish all of the following without exposing credentials:

1. the exact tokenizer signer is approved, funded on Sepolia, licensed, and has sufficient Brickken credits;
2. live tokenization, whitelist, and mint preparation each produce exactly one response compatible with the strict projection;
3. a controlled wallet/version displays and sends every retained field correctly and preserves the Sepolia constraint under the documented chain rule;
4. the returned hash is durably recorded, accepted by Brickken for the identical prepared transaction ID, and reaches the expected finality;
5. standalone whitelist followed by `needWhitelist: false` mint behaves as assumed; and
6. post-write Brickken reads support the required requested-versus-observed verification.

No authenticated write, wallet signature, wallet broadcast, Brickken reconciliation, or finality test has occurred yet.
