# Phase 8 adversarial evidence and operator playbook

## Status and hard stops

**DECISION** — Phase 8 is complete offline. It provides hardened provider handling, `ExecutionRunV3`, strict trusted-RPC transaction/receipt comparators, a deny-by-default authorization harness, and one concrete `BRICKKEN_READ` executor. The executor implementation did not start the harness, apply migration `0002_gorgeous_squadron_sinister.sql`, access Neon, call Brickken or RPC, request a wallet account/signature/transaction, broadcast, confirm, poll, or read back.

**DECISION** — The harness is an authorization and evidence-validation shell, not a production route and not a general live-action dispatcher. `runPhase8HarnessCli()` accepts only an explicitly injected, action-specific executor factory. The sole concrete composition is `BRICKKEN_READ`: a credential-bearing Brickken sandbox connectivity and Sepolia network-information check. It is not approved for operator execution, is not imported by the production application, and has not been run. Every later action still requires a separately reviewed executor.

**DECISION** — No wallet is selected, privileged or verified. EIP-6963 display metadata is self-asserted. A result applies only to the exact selected provider instance, operator-recorded wallet version, run, operation and wallet-request hash. It does not certify a wallet brand, another version, WalletConnect, another operation or another prepared transaction.

**DECISION** — Production semantic authorization remains deny-all. Phase 10 subsequently expanded the production inventory to exactly six routes by adding preparation only; there is still no prompt, result, broadcast, confirmation, polling, finality, read-back or receipt endpoint. Captured values must not become destination/selector policy without sanitized authenticated evidence, independent ABI/contract identification, human review, a separate commit and dedicated tests.

## First operator step

Run only this offline preflight, review its output, and stop:

```sh
npm run check
npm run check:phase8-harness
npm run test:phase8
npm run audit:phase8-client-bundle
git status --short
```

Expected result: lint, typecheck, default tests, production build, harness compile and Phase 8 offline tests pass; `git status --short` is empty. These commands require no live variables and make no Neon, Brickken, RPC, wallet or blockchain request.

No live action is authorized by the implementation work. Any later use must be separately authorized and performed by the authorized account holder/operator under Brickken's terms. Generic API request or credit accounting for the network-information method is undocumented. License, credits, signer approval, write payload compatibility, wallet compatibility and write behavior remain unverified.

## Harness boundary

The harness is located only at `tools/phase8-harness/`. Root `tsconfig.json` excludes it, while its own `tsconfig.json` provides an offline compile check. It binds only to validated `127.0.0.1` or `::1`, rejects unexpected `Host` and `Origin`, accepts exact `application/json` bodies up to 65,536 bytes, and constructs the injected executor only after every Execute gate passes. The pre-authentication page is generic and contains no action target; target metadata is returned only after bootstrap/session authentication.

The limits are application refusal ceilings, not claims about wallet or Brickken protocol maxima. `BRICKKEN_READ` structurally permits exactly `GET https://api.sandbox.brickken.com/get-network-info?chainId=11155111`, supplies no body, forces `redirect: "manual"`, refuses every redirect/final-URL mismatch, and permits one underlying dispatch. It streams success and error bodies before SDK parsing, rejects a valid oversized `Content-Length`, and counts actual bytes when the header is absent, malformed or dishonest. The ceiling is 1,048,576 bytes. Overflow aborts and cancels the reader where supported.

**ASSUMPTION** — A hostile transport can deliver one individually oversized stream chunk before application code observes and rejects it. The bound constrains accepted/buffered response bytes at the observable stream boundary; it is not a claim of lower-level network or allocator containment.

**ASSUMPTION** — Response ceilings bound accepted payload bytes at explicit parsing boundaries; they do not cap total process/runtime allocation. Accepted alternate input spellings are normalized only for structural validation and always dispatch the same exact constant request. Abort-aware work is cancelled, but Stop or deadline cannot forcibly terminate arbitrary in-process dependency code that ignores its signal; its late result is discarded. The Node runtime, pinned SDK and injected server-side transport remain trusted operating dependencies.

The CLI requires an interactive TTY. It generates a random 256-bit bootstrap secret, shows it once on that TTY, zeroes the source byte buffer, and retains only a SHA-256 verifier. The secret expires after five minutes and is consumed once. A successful exchange issues one opaque 15-minute session cookie whose server retains only a digest. The cookie is `HttpOnly`, `SameSite=Strict`, path `/`; CSRF uses a separate opaque token and constant-time digest checks. Stop consumes the grant, invalidates the execution generation, aborts the active signal and is terminal. The injected 30-second harness deadline is also terminal; late factory, executor, evidence or cleanup settlement cannot produce success or retry.

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

There is no environment spread, environment dump, root environment-file loading or browser delivery. The `BRICKKEN_READ` runner copies only the listed non-secret harness settings and `BRICKKEN_API_KEY`, hard-codes its action and sandbox mode, and accepts no command arguments. It constructs neither the adapter nor its transport until the single-use Execute grant has passed and the executor has revalidated its narrowed configuration. API keys must be non-empty bounded visible ASCII without controls, CR/LF or surrounding whitespace. The static-output inventory is derived from the same CLI templates, HTML, response-body builders, header definitions and evidence builder used for emission. It includes raw values and serialized fixed fragments (including punctuation and adjacent fields); target-dependent fragments are checked again after configuration validation. Adding a response builder requires a preflight sample through a typed registry. The narrowed credential is checked against that inventory before bootstrap generation, runtime/page/server construction or server startup. A preflight collision is an internal terminal condition: stdout and stderr remain empty and startup exits nonzero with no fallback. The centralized writer rechecks every actual terminal write. Every application HTTP response, including unauthenticated HTML, merged default headers, cookies and server-level error fallbacks, uses the same final body/header collision guard. A late dynamic response collision stops the runtime and closes the connection without a fallback. Random tokens and observation timestamps cannot be preflighted before generation; they are checked before emission. Node/loader diagnostics and protocol framing are outside this application-output boundary.

**DEPENDENCY** — `tsx@4.23.13` was promoted to a direct development dependency for the isolated TypeScript CLI. The identical version was already present transitively through `drizzle-kit`; promotion changed no locked package version, integrity hash, resolved URL or transitive graph. This correction adds no dependency.

## Fresh client-artifact audit

`npm run audit:phase8-client-bundle` never accepts an existing or caller-selected `.next` directory. It enumerates the Git index, copies only those tracked paths from the current working tree into a newly scoped temporary workspace, refuses tracked runtime environment files, copies the already-installed dependency tree separately from source, and starts with no build output. Dirty tracked trees are supported: the audit reports both `HEAD` and a deterministic SHA-256 digest over the exact sorted path/content pairs copied, then verifies the copied source digest again after the build. Untracked files are deliberately outside the audited source snapshot.

The child build inherits no ambient environment. Its explicit allowlist contains only production/build controls and a synthetic `BRICKKEN_API_KEY`; an audit-owned operating-system sandbox profile denies all network activity without modifying Node or framework globals. A fresh Turbopack build is attempted first; only the known sandbox process/port restriction permits deletion of that attempt's isolated output and reconstruction of a clean webpack fallback workspace. The audit requires a nonempty build ID, build manifests, parseable route and App Router manifests, the exact root page plus six approved API routes (including preparation only), and at least one nonempty client JavaScript artifact. It separately scans browser-delivered `.next/static` files, prerendered response artifacts and tracked `public/` files; every symlink or unsupported filesystem entry in a browser-artifact root fails closed. Root inspection treats only `ENOENT` as absence; permission, I/O and malformed-path errors fail the audit. Server-only JavaScript output is not misclassified as a client bundle.

The audit also constructs the real harness runtime with deterministic synthetic configuration and a verifier-only bootstrap value, invokes its real unauthenticated page-rendering path without starting a server, and scans the exact emitted HTML and response headers. Capture refuses any preexisting destination before runtime construction, creates a new directory exclusively, and opens new files with `O_EXCL | O_NOFOLLOW`; existing symlinks and special entries cannot redirect capture writes. The generic pre-bootstrap page must contain no protected action target. Captured build stdout and stderr are withheld from ordinary output and scanned for the synthetic credential, prohibited credential names and harness/server identifiers; a match fails without echoing it.

Success reports `HEAD`, the authoritative copied-source digest, the emitted-artifact digest, the builder and the six routes only after validation and cleanup. Missing, empty, stale, malformed, incomplete, mismatched or leaking output fails closed. Source revision/digest binding is deterministic; emitted artifact digests are evidence identifiers and are not expected to be reproducible because Next build metadata may vary. The repository's existing `.next` directory is neither copied nor accepted as evidence.

## Independent stopping points

Each row is a separate process and fresh human decision. A successful action consumes its grant and closes the server. Failure also consumes the grant, stops, prints no `ok: true`, and requires investigation. No command prepares and broadcasts, and no stage grants the next.

| Stop | Exact action | Preconditions and successful sanitized evidence | Mandatory stop |
| --- | --- | --- | --- |
| 1 | `BRICKKEN_READ` | A credential-bearing sandbox network-information request succeeded and produced the expected normalized Sepolia projection; no write | Stop. This does not prove that the credential was required, accepted as authority or independently authenticated, nor signer approval, license, credits or prepare readiness. |
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

The action harness accepts only successful, strictly action-specific `Phase8ActionEvidenceV1`, bounded to 262,144 code units. Outer `ok: true` requires executor success, exact `PASSED` status, strict validation, sanitization and successful awaited cleanup. `FAILED`, `BLOCKED`, `INCONCLUSIVE`, malformed, accessor-backed, cyclic, oversized or unexpected evidence fails with an Edict-owned error and no upstream content.

`BRICKKEN_READ` evidence is projected only from the normalized `currencyName` and block-explorer host plus fixed action metadata. It records the fixed Sepolia chain request, observation time, public adapter/SDK versions, explicit limitations and redaction categories. The trusted validator—not the executor—recomputes the canonical SHA-256 fingerprint from exactly this allowlisted projection. Mutable evidence, supplied alternative fingerprints, timestamps/raw bodies folded into a fingerprint, accessors and unknown projected fields fail closed. Raw Brickken bodies, request/response headers, credentials, database/RPC URLs, run capabilities, challenge tokens, signatures, private signing material, tokenizer email, claimed signer identity, complete prepared transactions and calldata cannot enter this schema.

## Current evidence and unresolved prerequisites

**HISTORICAL OBSERVATION — 2026-09-04** — A credential-bearing adapter observation recorded the sanitized projection `Sepolia ETH` and `sepolia.etherscan.io`; anonymous access had previously returned `401`. This correction task did not repeat either request, so current service behavior remains unverified. The sanitized historical projection does not prove that the raw response contained no additional properties. The corrected strict schema will refuse a changed or additional current response pending review. The observation does not prove that the credential was required, accepted as authority or independently authenticated. The Neon migration/create/read/CAS/stale-conflict/cleanup verification previously passed.

**OPEN QUESTION** — No authenticated Brickken write has occurred. Signer approval, tokenizer licensing, credits, prepared write payloads, selected-wallet compatibility, provider chain behavior, durable V3 data on Neon, RPC transaction equivalence, receipts, finality, Brickken confirmation/status and post-write behavior remain unverified. Migration `0002_gorgeous_squadron_sinister.sql` must receive separate authorization before application.

The first possible later live activity is the separately authorized command below. It has not been authorized or executed by this implementation task:

```sh
npm run phase8:brickken-read
```

The command accepts no arguments or credential on its command line, retains the interactive TTY bootstrap plus separate Arm and Execute decisions, makes at most one fixed `GET /get-network-info?chainId=11155111` request, emits only strict `Phase8ActionEvidenceV1`, and stops. If a later independent audit and explicit authorization permit execution, success would prove only that a credential-bearing Brickken sandbox network-information request succeeded and the normalized response matched the expected Sepolia contract. It would not prove that the credential was required, accepted as authority or independently authenticated. It also would not prove tokenizer signer approval, license status, remaining credits, prepare eligibility, wallet compatibility, ability to tokenize/whitelist/mint, or blockchain execution readiness.
