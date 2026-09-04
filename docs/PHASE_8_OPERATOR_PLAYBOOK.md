# Phase 8 adversarial evidence and operator playbook

## Status and hard stops

**DECISION** — Phase 8 is complete offline. It provides hardened provider handling, `ExecutionRunV3`, strict trusted-RPC transaction/receipt comparators, and a deny-by-default authorization harness. The implementation did not start the harness, apply migration `0002_gorgeous_squadron_sinister.sql`, access Neon, call Brickken or RPC, request a wallet account/signature/transaction, broadcast, confirm, poll, or read back.

**DECISION** — The harness is an authorization and evidence-validation shell, not a production route and not a general live-action dispatcher. `runPhase8HarnessCli()` accepts only an explicitly injected, action-specific executor factory. No live executor or command that can contact an external system is composed in the repository. This is intentional: action wiring must be separately reviewed against the selected run, wallet/version and operator credentials before its one controlled use.

**DECISION** — No wallet is selected, privileged or verified. EIP-6963 display metadata is self-asserted. A result applies only to the exact selected provider instance, operator-recorded wallet version, run, operation and wallet-request hash. It does not certify a wallet brand, another version, WalletConnect, another operation or another prepared transaction.

**DECISION** — Production semantic authorization remains deny-all. The production application still has exactly five routes and no prepare, prompt, result, confirmation, polling, finality, read-back or receipt endpoint. Captured values must not become destination/selector policy without sanitized authenticated evidence, independent ABI/contract identification, human review, a separate commit and dedicated tests.

## First operator step

Run only this offline preflight, review its output, and stop:

```sh
npm run check
npm run check:phase8-harness
npm run test:phase8
git status --short
```

Expected result: lint, typecheck, default tests, production build, harness compile and Phase 8 offline tests pass; `git status --short` is empty. These commands require no live variables and make no Neon, Brickken, RPC, wallet or blockchain request.

Before authorizing even a read-only action, the account holder must independently confirm sandbox ownership, the exact tokenizer signer, Sepolia funding, signer approval, active tokenizer license, sufficient per-method credits, the selected wallet/version, and the intended single run/operation. License, credits, write payload compatibility and write behavior are currently unverified.

## Harness boundary

The harness is located only at `tools/phase8-harness/`. Root `tsconfig.json` excludes it, while its own `tsconfig.json` provides an offline compile check. It binds only to validated `127.0.0.1` or `::1`, rejects unexpected `Host` and `Origin`, accepts exact `application/json` bodies up to 65,536 bytes, and constructs the injected executor only after every Execute gate passes.

The limits are application refusal ceilings, not claims about wallet or Brickken protocol maxima. Transaction and provider bounds cover the checked-in Brickken fixtures and standard Ethereum address/hash/uint256 shapes with substantial bounded headroom; external response and evidence ceilings accommodate diagnostic metadata without permitting unbounded traversal, parsing, hashing or persistence. Any real payload above a ceiling is rejected for review rather than truncated or silently expanding the limit.

The CLI requires an interactive TTY. It generates a random 256-bit bootstrap secret, shows it once on that TTY, zeroes the source byte buffer, and retains only a SHA-256 verifier. The secret expires after five minutes and is consumed once. A successful exchange issues one opaque 15-minute session cookie whose server retains only a digest. The cookie is `HttpOnly`, `SameSite=Strict`, path `/`; CSRF uses a separate opaque token and constant-time digest checks.

**ASSUMPTION** — The current supported operator transport is plain HTTP on an exclusive local loopback host. The cookie deliberately omits `Secure` because secure-cookie behavior over this actual HTTP transport has not been verified. The operator must use a local browser on the same controlled workstation, close unrelated local pages, avoid proxies/port forwarding, and treat the short session as sensitive. Loopback is not authentication; the one-time bootstrap, strict origin/host, session and CSRF layers remain mandatory. HTTPS/Secure-cookie claims remain unverified.

The bootstrap secret, session token, CSRF token, credentials and capabilities must never appear in arguments, URLs, query parameters, files, screenshots, normal logs or evidence. JavaScript strings cannot be reliably zeroed; the CLI drops its last plaintext reference after the TTY write. Edict never generates or handles wallet signing material.

## Explicit configuration allowlist

Every process fixes one action, run and operation. `WALLET_SEND` and `RPC_TRANSACTION_COMPARE` additionally fix one canonical `sha256:` wallet-request hash. Common non-secret configuration is `EDICT_PHASE8_MODE=sandbox`, `EDICT_PHASE8_HOST`, `EDICT_PHASE8_PORT`, `EDICT_PHASE8_ACTION`, `EDICT_PHASE8_RUN_ID`, `EDICT_PHASE8_OPERATION_KIND`, and, only where required, `EDICT_PHASE8_WALLET_REQUEST_HASH`.

The selected action receives only this credential allowlist:

| Action | Allowed server-side variables |
| --- | --- |
| `BRICKKEN_READ` | `BRICKKEN_API_KEY` |
| `BRICKKEN_PREPARE` | `DATABASE_URL`, `BRICKKEN_API_KEY` |
| `WALLET_APPROVAL` | `DATABASE_URL` |
| `WALLET_SEND` | `DATABASE_URL` |
| `RPC_TRANSACTION_COMPARE` | `DATABASE_URL`, `EDICT_SEPOLIA_RPC_URL` |
| `BRICKKEN_CONFIRM` | `DATABASE_URL`, `BRICKKEN_API_KEY` |
| `BRICKKEN_POLL` | `DATABASE_URL`, `BRICKKEN_API_KEY` |
| `RPC_FINALITY` | `DATABASE_URL`, `EDICT_SEPOLIA_RPC_URL` |
| `BRICKKEN_READ_BACK` | `DATABASE_URL`, `BRICKKEN_API_KEY` |

There is no environment spread, environment dump, root environment-file loading or browser delivery. An action-specific runner must receive credentials through an approved secure server-side workflow, directly construct this minimal source object, and pass only it to `runPhase8HarnessCli()`. It must not construct a client until the factory is called after Execute.

## Independent stopping points

Each row is a separate process and fresh human decision. A successful action consumes its grant and closes the server. Failure also consumes the grant, stops, prints no `ok: true`, and requires investigation. No command prepares and broadcasts, and no stage grants the next.

| Stop | Exact action | Preconditions and successful sanitized evidence | Mandatory stop |
| --- | --- | --- | --- |
| 1 | `BRICKKEN_READ` | Authenticated sandbox eligibility/account observations; no write | Review signer, license and credit evidence manually. |
| 2 | `BRICKKEN_PREPARE` | Exact run/revision/operation; one validated prepared transaction; sanitized field names, hashes and selector only | Persist and review; do not open a wallet prompt. Ambiguous prepare blocks. |
| 3 | `WALLET_APPROVAL` | Explicit EIP-6963 selection; exact signer/chain/challenge; operator records wallet version as unverified metadata | Persist approval result; do not send a transaction. |
| 4 | `WALLET_SEND` | Exact prepared wallet-request hash; durable prompt lock; separate visible Execute | Persist returned hash or `BROADCAST_UNKNOWN`; never resend automatically. |
| 5 | `RPC_TRANSACTION_COMPARE` | Trusted server RPC lookup by persisted hash; exact signed-field equivalence enters V3 | Any mismatch, unrelated hash, absent/dropped/replaced ambiguity or reorg blocks Brickken confirmation. Replacement detection is manual/unresolved. |
| 6 | `BRICKKEN_CONFIRM` | V3 transaction evidence is `MATCH/CLEAR`; submit only persisted `{txId, txHash}` once | Ambiguous response blocks; do not poll automatically. |
| 7 | `BRICKKEN_POLL` | Persisted identical IDs; one explicitly bounded poll action | Pending stops pending; rejected is terminal; no automatic loop or resend. |
| 8 | `RPC_FINALITY` | Matching receipt and block identity from trusted RPC; successful execution; separately observed finalized head | Persist included/finalized evidence; reorg or disagreement blocks. |
| 9 | `BRICKKEN_READ_BACK` | Brickken success plus matching successful finalized receipt | Persist requested-versus-observed result; never issue success on mismatch. |

For later tokenization, whitelist and mint testing, repeat the complete stop sequence in order. Standalone whitelist must be durably read-back verified before mint preparation with the documented `needWhitelist: false` assumption. No current live evidence validates that assumption.

## Transaction and receipt comparison contract

The approved wallet request, trusted-RPC transaction and receipt have separate strict schemas. Unknown signed fields fail closed; response-only fields are accepted only where enumerated.

| Field | Classification and rule |
| --- | --- |
| chain ID | Semantic integer equality with Sepolia `11155111`. |
| transaction hash | Exact lowercase hash equality with the provider-returned persisted hash. A valid unrelated hash is a mismatch. |
| sender/destination | Semantic address equality; contract creation (`to: null`) is refused. |
| request `data` / RPC `input` | Exact byte equality; evidence persists length and SHA-256, not complete calldata. |
| native value, nonce, gas limit | Semantic unsigned-integer equality; `gas` means transaction gas limit. |
| type | Exact supported type `0x0`, `0x1` or `0x2`. Other transaction types/unknown signed fields are unsupported. |
| legacy `gasPrice` | Exact semantic integer equality for type 0/1. |
| `maxFeePerGas`, `maxPriorityFeePerGas` | Exact semantic integer equality for type 2. |
| response-side type-2 `gasPrice` | Derived/compatibility field; never treated as a signed legacy price. |
| access list | Exact normalized ordered address/storage-key equality. |
| signature fields; block hash/number/index | Response-only identity metadata, not request fields. |
| receipt `gasUsed` | Receipt-only observation; must not exceed transaction gas limit. |
| receipt `effectiveGasPrice` | Derived receipt-only observation. |
| receipt status/contract address | Status must be success before read-back; contract creation is refused. |
| finalized block | Receipt inclusion block number must not exceed the separately observed finalized head; both identities are persisted. |

The implementation does not claim automatic replacement detection. A missing transaction, a different transaction under the returned hash, a changed inclusion identity or reorganization is manual reconciliation and must never lead to an automatic replacement transaction.

## V3 and evidence handling

`ExecutionRunV3` is entered only by `RECORD_ONCHAIN_TRANSACTION_EVIDENCE` from `BROADCAST_HASH_PERSISTED`. Confirmation requires `MATCH/CLEAR`. Read-back requires a matching, successful, finalized receipt. Mismatch evidence is preserved and moves the run to `RECONCILIATION_REQUIRED`; a reverted receipt is terminal failed. Evidence is strictly parsed, newly copied, deeply frozen and stored per operation. V1 and V2 decode unchanged and are never silently upgraded.

The action harness accepts only `Phase8ActionEvidenceV1`, bounded to 262,144 code units. It binds harness version, timestamp, exact action/run/operation/request hash, status, optional result fingerprint, bounded scalar details, limitations and an explicit redaction list. Secret-like detail names, accessor-backed structures, oversized values and any configured credential value are rejected before an `ok: true` response. Raw RPC/Brickken bodies, complete calldata, complete approval signatures, credentials and run capabilities are not evidence.

## Current evidence and unresolved prerequisites

**VERIFIED** — The authenticated Brickken network-info read previously passed and identified `Sepolia ETH`; anonymous access previously returned `401`. The Neon migration/create/read/CAS/stale-conflict/cleanup verification also previously passed.

**OPEN QUESTION** — No authenticated Brickken write has occurred. Signer approval, tokenizer licensing, credits, prepared write payloads, selected-wallet compatibility, provider chain behavior, durable V3 data on Neon, RPC transaction equivalence, receipts, finality, Brickken confirmation/status and post-write behavior remain unverified. Migration `0002_gorgeous_squadron_sinister.sql` must receive separate authorization before application.

The first later live activity should be one separately authorized `BRICKKEN_READ` eligibility action using a reviewed action-specific executor. It must emit only `Phase8ActionEvidenceV1`, stop after the read, and must not prepare, sign, send, query RPC, confirm, poll or read back.
