# Durable run recovery and approval activation plan

> Historical scope note: Phase 9 correctly ended with five API routes and no execution. Phase 10 subsequently adds only `POST /api/runs/[runId]/prepare`; the canonical product route remains `/records/[runId]`. All Phase 9 route-count statements below describe that earlier approved checkpoint.

**Status: architecture approved with amendments. Public recovery, `/records/[runId]` durable routing, Phase C approval transport/uncertainty semantics, Phase D provider readiness, and Phase E explicit approval signing plus durable recording are implemented. The product stops at Approval recorded; transaction execution remains unauthorized.**

Repository assessment: 2026-09-08 at commit `95ac92d` on branch `feat/run-recovery-approval`. The working tree was clean before this document was created. This plan is based on the committed code and documentation; it does not authorize application code, dependency, migration, live-wallet, Brickken, RPC, or transaction-execution changes.

Reading convention:

- **CODE OBSERVATION** describes behavior present in the inspected repository.
- **DECISION** describes the recommended implementation contract, pending review.
- **NEW WORK** identifies behavior or composition that does not exist yet.
- **STOP BOUNDARY** identifies behavior that this phase must not activate.

## 1. Executive assessment

### Current implementation state

**CODE OBSERVATION —** Edict's planning flow is complete. `POST /api/runs` validates and normalizes a mandate, derives and hashes the deterministic seven-operation plan, creates a durable V2 run at revision 1 in the injected repository, issues a run-bound capability cookie, and returns a public planning record. The approved planning workspace renders the normalized manifest, plan, identifiers, timestamps, status, revision, manual refresh, and legal pre-broadcast cancellation.

**CODE OBSERVATION —** Durable storage already exists behind `ExecutionRunRepository`. The deployed composition uses Neon/Drizzle, validates the V1/V2/V3 JSONB snapshot with the strict persistence codec, and uses atomic compare-and-swap updates. Recovery does not need a new table, migration, login system, or browser persistence mechanism.

**CODE OBSERVATION —** Approval is also largely implemented. The server exposes capability- and origin-protected challenge and approval endpoints. `WalletApprovalService` binds an HMAC-authenticated five-minute challenge to the run, manifest hash, plan hash, environment, Sepolia chain, current revision, required signer, nonce, and timestamps. It recovers the EIP-712 EOA signer with pinned `viem`, and `ExecutionRunService.approvePlan()` persists the public proof through CAS. The browser modules already implement passive EIP-6963 discovery, explicit provider selection, explicit account access, explicit chain switching, signer-anywhere account matching, exact `eth_signTypedData_v4`, provider deadlines, and session invalidation.

### Exact gaps

1. **Recovery contract gap.** `POST /api/runs` returns `{ run, manifest, plan }`, but `GET /api/runs/[runId]` returns `{ run, plan }`. The client parser therefore recovers the manifest only from a prior in-memory `PlanningView`. A fresh page cannot reconstruct the record.
2. **Routing gap.** `/` is the only user page. The active run ID exists only in component state, so refresh, direct navigation, and a new tab cannot tell the client which authorized run to read.
3. **Public DTO gap.** `projectRun()` constructs a safe-looking object, but there is no named strict public DTO schema at the server boundary. The browser schemas use non-strict `z.object`, narrow away operation state, snapshot version, and receipt eligibility, and permit recovery only when prior manifest memory exists.
4. **Approval HTTP gap.** `ApprovalGateway` is an injected TypeScript interface used only by offline tests. There is no production same-origin HTTP implementation that strictly validates run, challenge, approval, and error envelopes.
5. **Approval composition gap.** The approved workspace imports no wallet code and renders no provider, account, network, challenge, signing, submission, or durable approval state.
6. **Uncertainty/staleness gap.** The approval coordinator requires a final durable reread on the success path, but it has no application-owned HTTP error taxonomy or explicit recovery result for a lost submission response, failed final reread, or revision conflict. The UI must never infer approval from a returned signature or the approval POST alone.
7. **Lifecycle integration gap.** Provider discovery/session objects have no React/controller owner that starts passive discovery, handles late/colliding announcements, disposes replaced sessions, invalidates readiness after provider events, or serializes explicit approval actions.
8. **Audit gap.** The Phase 8 client-artifact audit currently allowlists only the root page plus five API routes. A new `/records/[runId]` page must be added to its expected application path inventory without changing the five-route API inventory.

### Recommended scope

**DECISION —** Add one canonical durable user route, `/records/[runId]`; make the existing GET response a complete, strictly validated public planning record; navigate to the canonical route only after a successfully parsed create response; and recover that record with one read-only GET on route mount.

**DECISION —** Activate only plan approval by composing the existing wallet and approval modules through a strict same-origin gateway and a small in-page authority section. Preserve the current server transition: a successful approval moves the persisted run from `PLAN/AWAITING_APPROVAL` to `TOKENIZATION/PREPARING`, increments revision once, and records approval. In this phase `PREPARING` is only the existing post-approval state name: no prepare service or external effect is invoked or exposed.

**DECISION —** Do not add API routes, persistence fields, database migrations, authentication accounts, capability transport, execution controls, or wallet-transaction code. The callable API remains the existing five routes.

## 2. Current architecture map

### User and API routes

| Path | Current owner and behavior | Gap for this phase |
| --- | --- | --- |
| `/` | `src/app/page.tsx` renders `RunPlanningWorkspace` | No durable run locator after refresh |
| `POST /api/runs` | `createRunHandler()` creates the run, issues the selected capability cookie, returns run/manifest/plan | Response is not passed through a named strict public envelope projector |
| `GET /api/runs/[runId]` | `getRunHandler()` authorizes capability before lookup, reads durable run, rederives plan | Omits manifest; cannot hydrate a fresh page |
| `POST /api/runs/[runId]/approval-challenges` | Checks deployment/origin/capability, parses `{ expectedRevision }`, rereads run, checks revision, issues challenge | No production browser gateway/UI |
| `POST /api/runs/[runId]/approval` | Checks deployment/origin/capability, parses revision/token/signature, rereads, verifies proof, CAS-persists approval | No production browser gateway/UI; POST success is not sufficient UI evidence |
| `POST /api/runs/[runId]/cancel` | Capability/origin protected CAS cancellation | Existing UI only; retain unchanged behavior |

Every route module uses the Node runtime and `force-dynamic`. There is no prepare, prompt, broadcast, confirmation, poll, read-back, verification, or deployment-receipt route.

### Public DTOs

`projectRun()` currently emits:

- run `id`, persistence `schemaVersion`, `manifestHash`, `planHash`;
- `environment`, `chainId`, and `requiredSigner`;
- `phase`, `status`, `terminalOutcome`, and boolean `approved`;
- three operation projections with `id`, `kind`, `stage`, `preparedTxId`, `blockchainTxHash`, `brickkenStatus`, and `timeout`;
- `receiptEligible`, `createdAt`, `updatedAt`, and `revision`.

It deliberately omits the persisted manifest/plan snapshots as snapshots, approval proof and signature, challenge nonce/token, unsigned transaction, Brickken error text, events, observations, evidence objects, and operation timestamps. `publicPlan()` separately validates the persisted manifest, rebuilds the full deterministic plan, and checks its manifest and plan hashes.

The current browser `runSchema` and `planSchema` are presentation schemas, not a complete public contract: they are not strict, discard most operation state, and use `previous.manifest` as the refresh source.

### Capability and persistence path

```text
Browser URL contains public run ID only
  -> same-origin API request carries selected HttpOnly cookie automatically
  -> deployment and origin/fetch-metadata gate
  -> run ID syntax check
  -> RunAccessService.verify(cookie, requestedRunId)
  -> ExecutionRunService.getRun(runId)
  -> NeonExecutionRunRepository.getById
  -> Drizzle store select
  -> strict persistence row/snapshot decode and invariant checks
  -> server revalidates manifest and rederives plan/hash
  -> strict public projection
```

The capability is never stored in Neon. The selected cookie contains an HMAC-authenticated payload with purpose, run ID, nonce, issue time, and exact 24-hour expiry. Capability MACs and approval-challenge MACs use distinct purpose-derived keys.

### Approval path

```text
approval-challenges route
  -> RunAccessService + origin gate
  -> durable run/revision read
  -> WalletApprovalService.issueChallenge
  -> exact EIP-712 typed data + digest + RPC-ready serialized string + opaque token

approval route
  -> RunAccessService + origin gate
  -> strict body and durable revision read
  -> WalletApprovalService.verify
  -> EIP-712 EOA recovery and exact required-signer comparison
  -> ExecutionRunService.approvePlan
  -> applyRunEvent(APPROVE_PLAN)
  -> repository CAS, revision N -> N+1
```

Approval evidence is persisted in V2 as public signature-recovery evidence, but the ordinary public DTO exposes only `approved: boolean`. That is sufficient for the minimum approval-recorded presentation and keeps raw proof private.

### Browser wallet modules

| Module | Existing responsibility |
| --- | --- |
| `src/client/wallet/discovery.ts` | Passive EIP-6963 collection; descriptor-safe metadata checks; duplicate/collision quarantine; late announcements; explicit selection; lazy explicit legacy fallback |
| `src/client/wallet/session.ts` | Captures stable provider methods; listeners; passive `eth_accounts`/`eth_chainId`; explicit `eth_requestAccounts`; explicit `wallet_switchEthereumChain`; required signer anywhere in accounts; Sepolia readiness; generation invalidation; deadlines; cleanup |
| `src/client/wallet/approval.ts` | Durable run read; challenge request/validation; readiness recheck; exact typed-data call; signature shape check; proof submission; final durable reread |
| `src/shared/wallet/approval.ts` | Strict challenge/typed-data schemas, exact serialization consistency, digest/run/revision/plan/signer/chain/time validation |
| `src/client/wallet/errors.ts` | Sanitized wallet error codes/messages; no provider error text propagation |

`src/client/wallet/execution.ts` and wallet-intent/transaction modules are later-phase transaction machinery and must not be composed by this work.

### Frontend composition

`RunPlanningWorkspace` is one client workspace with local draft, recorded `PlanningView`, pending/error/notice state, view tabs, cancellation confirmation, and focus management. `createPlanningWorkspace()` serializes create/refresh/cancel and refuses older, unrelated, or malformed responses. `PlanDocument`, `RecordedManifest`, and `RecordDetails` are the approved presentation components to retain. The footer currently states that a run is retained in page memory; that copy becomes false once durable routing lands.

## 3. Durable recovery design

### Route strategy

**DECISION —** Use `/records/[runId]` as the canonical durable run surface. Keep `/` as the new-mandate surface. Internal APIs and domain terminology remain `/api/runs`, `runId`, and `ExecutionRun`.

This is an architectural choice, not a visual one:

- A stable route carries only the public locator needed to request the correct aggregate; the HttpOnly cookie remains the separate authority.
- Refresh and direct navigation naturally preserve the locator without local/session storage.
- Future lifecycle stages can remain attached to one run route instead of overloading root component memory.
- A dynamic App Router page can validate/bound the public parameter and render the existing client workspace without importing server persistence or secrets into the client graph.
- One-active-run capability semantics remain explicit: an old run URL can remain in history, but a newly issued cookie for another run cannot authorize it.

Do not put a capability, challenge, signature, email, wallet session, or approval result in route params, query params, fragments, navigation state, or browser storage.

After `POST /api/runs` returns 201 and the complete response passes strict validation, navigate with `router.replace('/records/' + encodeURIComponent(run.id))`. Replacement makes the durable record—not an already-submitted form—the current history entry. The destination performs a normal authorized GET. Do not navigate on a network error, malformed response, or non-201 response, and do not repeat POST automatically if navigation/recovery fails.

### Run reconstruction

`src/app/records/[runId]/page.tsx` should remain a server component whose only responsibility is to pass a syntactically validated, bounded public run ID to the client workspace. It must not query Neon directly, duplicate capability verification, or serialize the capability. A malformed parameter renders the same safe unavailable surface without an API request.

The client workspace receives `initialRunId` and performs exactly one recovery action after mount for that ID. That action:

1. issues only `GET /api/runs/[runId]` with `credentials: 'same-origin'`, `cache: 'no-store'`, and `redirect: 'error'`;
2. strictly parses the complete success/error envelope;
3. accepts the normalized manifest and deterministic plan only from that response;
4. publishes the recovered view and local retrieval time; and
5. performs no POST, wallet discovery selection, account request, challenge request, signature request, state transition, hash calculation, or execution action.

React Strict Mode and remounts must not turn recovery into a mutation. Duplicate GETs are harmless but the controller should key/deduplicate the initial read to avoid confusing presentation and tests. Abort or ignore stale settlements when `initialRunId` changes or the component unmounts.

### Manifest and plan authority

**DECISION —** Change GET to return the same complete planning artifact shape as create: `{ ok: true, run, manifest, plan }`.

The manifest source is `run.manifest` after persistence decoding, `validateAssetManifestV1()`, and exact normalized-form verification. The plan source is `buildExecutionPlanV1(validatedManifest)`, followed by manifest-hash and plan-hash equality against the durable run. The browser validates the DTO but does not rebuild either hash or treat browser reconstruction as authority.

`readProjection()` must stop falling back to `previous.manifest` for an ordinary GET. Each create/read response must stand on its own. Previous state is used only to enforce monotonic identity/revision rules and to preserve the last confirmed view when a request fails. Mutation responses that intentionally contain only `run` may continue to be combined with the already-confirmed manifest/plan, provided identity/hash/revision invariants pass and the mutation-specific result is verified.

### Capability behavior

Preserve the current policy exactly:

| Situation | Server behavior | Safe UI behavior |
| --- | --- | --- |
| Valid selected cookie bound to requested run | Verify before lookup; return 200 complete record | Render recovered record |
| Cookie absent | 403 `FORBIDDEN`; no repository lookup | “This browser cannot access this run. Access may have expired or been replaced.” |
| Cookie expired | 403 `FORBIDDEN`; no repository lookup | Same generic access message; do not claim exact cause |
| Cookie belongs to another run | 403 `FORBIDDEN`; no repository lookup | Same generic access message |
| A new run replaced active access | Old URL receives 403; new run URL succeeds | Explain one-active-run limitation; do not offer bypass/recovery token entry |
| Capability MAC secret rotated | Existing token receives 403 | Same generic access message; a new run is required under current product scope |
| Run ID malformed | Current API returns 403 before lookup; page may reject syntax before fetch | Generic unavailable/invalid run link; expose no repository fact |
| Valid capability but run absent | Repository lookup returns 404 `NOT_FOUND` | “This run is unavailable.” |
| Stored data or public projection invalid | 503 `SERVICE_UNAVAILABLE` after fail-closed decode/projection | “Edict could not safely reconstruct this run.” No partial record |
| API disabled/config invalid | 404 `API_DISABLED` before runtime | Honest environment-unavailable state |

The HTTPS/production cookie remains `__Host-edict_run_access`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, `Max-Age=86400`. Explicit HTTP loopback origins in development/test continue to use only `edict_run_access_dev`, with identical settings except `Secure=false`. There is no alternate-name fallback. Selection remains based only on trusted server configuration.

### Reload, new tab, and reopening behavior

- Refreshing `/records/<id>` within the capability lifetime reconstructs from the server and does not change revision.
- Closing and reopening the same URL in the same browser/profile works while the persistent cookie remains valid, has not been replaced, and the server secret/origin policy is unchanged.
- Pasting the URL into another tab in the same browser/profile works under the same conditions because the capability cookie is shared. Each tab has independent local wallet readiness; neither tab auto-selects or auto-prompts a wallet.
- A new browser/profile/incognito context has no capability and receives the generic 403 access state even though it knows the run ID.
- An expired or replaced capability cannot be recovered under the MVP. Do not invent accounts, email lookup, wallet-sign-in recovery, share links, or capability refresh endpoints.

### Revision and stale-state semantics

Recovery is a read of the latest durable revision. It never increments or rewrites revision. A manual refresh may accept only the same run ID, manifest hash, and plan hash with a revision greater than or equal to the displayed revision. An older revision, changed identity/hash, malformed DTO, or corrupt reconstruction is rejected while retaining the last confirmed view and labeling the update unconfirmed.

Approval and cancellation continue to submit the displayed positive `expectedRevision`. A 409 never causes mutation retry. Perform at most one read-only reread, publish the new durable view if it passes identity checks, and require fresh human review/action. Initial navigation has no local authoritative revision and simply accepts the strictly validated current durable record.

## 4. Required API and DTO changes

### One shared public contract

**NEW WORK —** Introduce a client-safe shared public-run DTO module with strict Zod schemas and inferred readonly types. It must not import server persistence, security, environment, or Brickken modules.

The success contract should be:

```ts
type PublicRunRecordV1 = {
  run: {
    id: string;
    schemaVersion: "1.0" | "2.0" | "3.0";
    manifestHash: `sha256:${string}`;
    planHash: `sha256:${string}`;
    environment: "sandbox";
    chainId: "11155111";
    requiredSigner: { role: "tokenizer"; walletAddress: string };
    phase: RunPhase;
    status: RunStatus;
    terminalOutcome: TerminalOutcome | null;
    approved: boolean;
    operations: readonly [
      PublicWriteOperation,
      PublicWriteOperation,
      PublicWriteOperation,
    ];
    receiptEligible: boolean;
    createdAt: string;
    updatedAt: string;
    revision: number;
  };
  manifest: AssetManifestV1Public;
  plan: ExecutionPlanV1Public;
};
```

`PublicWriteOperation` retains the existing fields exactly: `id`, `kind`, `stage`, `preparedTxId`, `blockchainTxHash`, `brickkenStatus`, and `timeout`. The tuple order must be `TOKENIZE`, `WHITELIST`, `MINT`. The plan schema must validate all seven exact ordered operation variants, not merely “an array of seven,” and must include all already-public plan fields. All nested objects are strict; identifiers, strings, arrays, timestamps, hashes, addresses, and quantities are bounded and format-validated.

`AssetManifestV1Public` is exactly the normalized manifest already owned by `CORE_DOMAIN_SPEC.md`: `schemaVersion`, `environment`, `chainId`; tokenizer `email` and `walletAddress`; asset `name`, `symbol`, `tokenType`, `supplyCap`, and `documentationUrl`; investor `email`, `walletAddress`, and `mintAmount`. No draft-only or raw-input field is added.

`ExecutionPlanV1Public` mirrors the existing `ExecutionPlanV1` exactly: `planVersion`, `manifestHash`, `environment`, `chainId`, `requiredSigner`, `operations`, and `planHash`. Every operation retains `sequence`, semantic `id`, `kind`, `mode`, exact `dependsOn` tuple, `signer`, `walletConfirmationRequired`, its operation-specific `intent`, and hashed `summary`. The seven discriminated variants and their intent fields come directly from `src/core/execution-plan.ts`; do not create a looser generic operation map or change summary text while extracting/reusing the DTO schema.

Cross-field validation must require:

- run ID, environment, chain, signer, manifest hash, and plan hash to agree across run/manifest/plan;
- normalized manifest validation to succeed without changing the public value;
- operation tuple kinds and plan operation sequence/IDs to be exact;
- `approved === true` only when the durable aggregate had a non-null approval; and
- no revision decrease when a previous confirmed view exists.

The server projection should be the only constructor for public records. It accepts a decoded `ExecutionRun`, revalidates/rederives artifacts, builds a new allowlisted object, parses that object with the strict public schema, and freezes/returns the parsed result. Projection or hash invariant failure is an internal data failure and maps to 503 `SERVICE_UNAVAILABLE`, not 400 `BAD_REQUEST`.

### Endpoint changes

| Endpoint | Change | Justification |
| --- | --- | --- |
| `POST /api/runs` | Build its `{ run, manifest, plan }` through the shared strict projector | Create and recovery must speak one contract |
| `GET /api/runs/[runId]` | Add `manifest`; return the same complete projected record | Enables fresh-page recovery from server authority |
| `POST /api/runs/[runId]/approval-challenges` | No wire change; browser gateway strictly validates the existing envelope | Preserve exact server-issued signing bytes |
| `POST /api/runs/[runId]/approval` | No request or server transition change; strictly validate its public run response in the gateway, then still reread GET | POST response/signature alone cannot establish recorded approval |
| `POST /api/runs/[runId]/cancel` | No wire change | Existing behavior is sufficient |

Error bodies remain `{ ok: false, error: { code } }`, except the existing bounded create-validation issues. Never return inspected error messages, provider errors, upstream bodies, configuration values, or proof details.

### Public/private boundary

Remain public: normalized manifest fields already shown to the authorized browser; full deterministic plan already returned on create; run/operation identifiers and sanitized states; public wallet addresses; hashes; timestamps; receipt eligibility.

Remain private: run capability; cookie/token payload; approval challenge token outside the immediate challenge response; challenge MAC payload as an independent API; raw approval proof and signature after submission; nonce; typed-data proof persisted record; unsigned transaction; prepared transaction body; events; observations; V3 evidence detail; Brickken errors/raw bodies; headers; API/database/RPC/security secrets.

No secret or capability enters a React prop, URL, log, analytics event, browser storage, error detail, copied-value control, screenshot fixture, or source fixture.

## 5. Approval activation design

### Exact user action sequence

1. Recover or display the server-recorded plan at `/records/[runId]`.
2. Keep asset, plan hash, revision, required signer, Sepolia/sandbox, recipient, mint allocation, and the three future wallet operations visible.
3. The user explicitly opens/selects the authority section; mounting alone may start only passive EIP-6963 announcement collection.
4. The user explicitly selects one available, non-collision provider. No first/default provider is chosen.
5. A passive inspection may show already-authorized accounts and chain. If unauthorized, the user explicitly selects **Allow account access**, causing one `eth_requestAccounts` call.
6. Require the exact tokenizer signer anywhere in the normalized authorized account array. Never substitute account zero.
7. If the chain is not `0xaa36a7`, the user explicitly selects **Switch to Ethereum Sepolia**, causing one `wallet_switchEthereumChain` call followed by reinspection. If generation invalidates during switching, require **Check wallet again**.
8. When readiness is `READY`, expose **Approve this plan**. This action starts one serialized approval attempt.
9. The existing approval coordinator rereads the durable run and verifies the displayed revision is still current and unapproved before issuing a challenge.
10. It requests one fresh challenge, validates the exact structured data, serialized string, digest, run/revision/plan/signer/chain binding, and lifetime, then reinspects provider readiness.
11. It calls exactly `eth_signTypedData_v4` with the server-issued required signer and serialized string. No fallback method is attempted.
12. It submits only `{ expectedRevision, challengeToken, signature }` to the existing approval endpoint.
13. It performs a separate durable GET. Only a valid same-run projection with `approved: true`, revision `N+1`, unchanged manifest/plan hashes, and the existing post-approval state establishes **Approval recorded**.
14. Stop. Display that execution remains unavailable and each of the three future on-chain operations will require a separate wallet confirmation in a later phase.

Readiness work should happen before the user presses **Approve this plan** so challenge lifetime is not wasted, while the existing coordinator's post-challenge `inspect()` remains as the mandatory security recheck.

### Server sequence and invariant

The challenge endpoint rechecks capability, trusted origin, body, durable revision, and `PLAN/AWAITING_APPROVAL` with no approval. Challenge issuance does not mutate the run. The approval endpoint repeats capability/origin/body/run/revision checks, verifies the HMAC challenge and all fields, checks freshness, recovers the EOA, compares the exact required signer, and applies one CAS event.

Current successful persisted result:

```text
before: phase=PLAN, status=AWAITING_APPROVAL, approved=false, revision=N
after:  phase=TOKENIZATION, status=PREPARING, approved=true, revision=N+1
```

No prepare intent, prepared transaction, wallet transaction prompt, Brickken call, or RPC call is part of that transition.

### Approval client state machine

| Client state | Entry | Permitted next action | Existing or new |
| --- | --- | --- | --- |
| `RECOVERING` | Route GET pending | Wait/cancel stale settlement | New UI state; read only |
| `AWAITING_PROVIDER` | Durable unapproved plan loaded | Passive discovery; explicit selection | New composition over existing discovery |
| `NO_PROVIDER` | Discovery list empty after initial announcement window | Install/enable an injected wallet, then recheck discovery; optional explicit legacy fallback | New presentation; existing discovery behavior |
| `PROVIDER_AVAILABLE` | Available entries announced | Explicitly select one | Existing discovery state |
| `PROVIDER_COLLISION` | UUID/provider identity collision | Entry disabled; dispose selected session if it became collided; require reselection | Existing discovery mark; new composition cleanup |
| `SELECTED_UNCHECKED` | Explicit selection created a session | Explicit/passive readiness check without account prompt | New presentation over existing session |
| `ACCOUNT_ACCESS_REQUIRED` | `inspect()` returns `UNAUTHORIZED` | Explicit account authorization | Existing readiness |
| `REQUIRED_SIGNER_MISSING` | Accounts exist without required signer | Change account in wallet, then explicit recheck | Existing readiness |
| `WRONG_CHAIN` | Required signer present, chain not Sepolia | Explicit switch or manual switch then recheck | Existing readiness |
| `CHAIN_SWITCH_PENDING` | Explicit switch request is in flight | Wait; suppress other wallet actions | New UI pending state over existing method |
| `CHAIN_SWITCH_REJECTED_OR_UNSUPPORTED` | Provider returns the existing safe switch error | Manual switch/recheck or provider reselection | Existing errors; new presentation |
| `READY` | Required signer and Sepolia verified for current generation | Explicit Approve action | Existing readiness |
| `READINESS_INVALIDATED` | account/chain/connect/disconnect event, provider mutation/disposal/deadline | Clear readiness; recheck/reselect | Existing generation/errors; new presentation |
| `APPROVAL_IN_PROGRESS` | Explicit Approve action | No other wallet or approval action | New UI mutex around existing coordinator |
| `CHALLENGE_REQUEST_PENDING` / `SIGNING_PENDING` / `PROOF_SUBMISSION_PENDING` / `DURABLE_REREAD_PENDING` | Internal coordinator/gateway boundaries | Wait; never auto-advance from an effect | Existing sequence; optional new observer-only presentation |
| `SIGNATURE_REJECTED` | Provider code 4001 from typed-data signing | Reread; later explicit fresh attempt | Existing error |
| `SIGNING_UNSUPPORTED` | Provider code 4200 | Select another provider; no fallback | Existing error |
| `CHALLENGE_INVALID_OR_EXPIRED` | Client validation fails or server refuses stale proof | Reread; later explicit fresh attempt | Existing validation/errors; new HTTP mapping |
| `APPROVAL_UNCONFIRMED` | Submission/final reread cannot establish durable result | Read-only reread only; no automatic new signature | New safe outcome needed |
| `STALE_RUN` | Preflight/endpoint reports revision or state conflict | One GET; replace view; require review | New composition over existing 409 |
| `APPROVAL_RECORDED` | Durable GET proves approved state | No approval control; execution unavailable | Existing durable fact; new presentation |

Challenge requested/issued, signing pending, proof submission pending, and durable reread are genuine internal steps. The current coordinator exposes them as one promise. The minimum UI may present a single `APPROVAL_IN_PROGRESS` live region (“Approval request in progress; check your wallet if prompted”) rather than changing the security coordinator solely for animation. If finer copy is required, add a typed observer callback that reports state only; it must not expose the challenge token, serialized typed data, signature, provider object, or allow effects to drive transitions.

## 6. Provider and session behavior

### Discovery and explicit selection

Instantiate `InjectedWalletDiscovery` only in the client approval boundary. `start()` may run in an effect because it registers for EIP-6963 announcements and dispatches `eip6963:requestProvider`; it makes no EIP-1193 provider request. Subscribe before/start together, publish `list()`, accept late announcements, and dispose on unmount.

Render available providers as explicit radio/button choices using self-reported text metadata. Treat names and RDNS as untrusted. Do not render untrusted SVG data with `dangerouslySetInnerHTML`, fetch remote icons, label a wallet verified/recommended, or select by wallet brand. Initially omit icons if safe image handling would enlarge the phase.

Collision entries are disabled. If discovery updates mark the selected entry as collision, immediately dispose its session, clear local readiness, and require explicit reselection. Malformed announcements remain ignored as the existing module specifies.

The legacy `window.ethereum` path remains lazy: only an explicit **Use legacy injected provider** action invokes the supplied reader and `selectLegacyProviderFromUserAction()`. No mount-time read of `window.ethereum`.

### Account and signer readiness

After explicit provider selection, `inspect(requiredSigner)` may perform passive `eth_accounts` and `eth_chainId`. It must not call `eth_requestAccounts`. `UNAUTHORIZED` exposes a separate account-access action. `requestAccountsFromUserAction()` is called only inside that click handler.

Normalize and compare every returned address. The required signer may be at any index. Display the full required address and only safe normalized public authorized addresses if mismatch detail is needed. Never silently switch to the first account, write a selected account into the manifest, or treat wallet identity as run capability.

### Chain readiness

Sepolia is decimal `11155111` in run/approval data and RPC `0xaa36a7` in the provider session. A wrong chain exposes a separate switch action. Rejection (`CHAIN_SWITCH_REJECTED`) and unsupported switching (`CHAIN_SWITCH_UNSUPPORTED`) remain distinct safe messages; the latter can instruct the user to switch manually and then choose **Check wallet again**.

The existing session generation rule remains authoritative even if a wallet emits `chainChanged` during a successful switch. Do not suppress or special-case the event. Treat the attempt as invalidated and re-read readiness.

### Invalidation and cleanup

Subscribe to the selected session. Any `connect`, `disconnect`, `accountsChanged`, or `chainChanged` event increments generation and clears UI readiness. `WALLET_DISCONNECTED`, `ATTEMPT_INVALIDATED`, `SELECTED_PROVIDER_DISAPPEARED`, provider method mutation, or deadline likewise clears readiness. No event handler, focus handler, visibility handler, route hydration, or tab change may request accounts, switch chain, issue a challenge, sign, submit proof, or retry.

On provider reselection, run change, approval completion, or component unmount: unsubscribe, dispose the prior `SelectedWalletSession`, clear account/chain data and attempt state, and ignore its late promises. Disposal is local cleanup, not a wallet disconnect or transaction cancellation.

## 7. Approval challenge and proof behavior

### Binding and exact typed data

Preserve these existing fields and values:

- EIP-712 domain: name `Edict`, version `1`, chain ID `11155111`;
- primary type `ApproveExecutionPlan`;
- run ID;
- manifest and plan SHA-256 values converted exactly to `bytes32`;
- environment `sandbox` and chain ID `11155111`;
- approval version `1.0` and current approval revision;
- required tokenizer signer;
- 32-byte nonce; and
- issued/expiry epoch seconds with exact five-minute lifetime.

The browser validates that `typedData`, parsed `signingRequest.params[1]`, `typedDataDigest`, and current durable run agree. It then sends the exact server-issued serialization. Do not rebuild, normalize, reorder, or substitute signing material, and do not add `personal_sign`, `eth_sign`, raw-transaction, EIP-1271, or RPC contract-wallet fallback.

### Freshness, stale state, and mismatch

The server rejects a challenge at `expiresAt <= now`, a future issue time beyond the existing 30-second allowance, a non-exact five-minute lifetime, wrong token purpose/MAC, or any run/hash/environment/chain/revision/signer mismatch. Client validation provides an earlier fail-closed check but never replaces server verification.

A stale revision can be detected by the coordinator's initial durable read, the challenge endpoint, or the approval endpoint/CAS. In every case: stop the attempt; do not sign again; perform at most one GET; publish the new durable projection if valid; require explicit review and a new Approve action.

The server intentionally maps invalid capability and invalid challenge/proof to the same public `403 FORBIDDEN`. Do not weaken this to reveal which security check failed. To present safely:

1. after a mutation 403 or uncertain submission, attempt one authorized GET;
2. if GET is also 403, render capability access unavailable;
3. if GET succeeds approved, render approval recorded;
4. if GET succeeds unapproved, render approval not recorded/request refused without diagnosing signature, challenge, or MAC internals; and
5. if GET is unavailable or malformed, render approval result unconfirmed.

### Uncertainty handling

The current coordinator already ignores the approval POST body as authority and requires a GET after a successful POST. Strengthen composition so a submission transport failure, non-JSON response, server error, or failed final GET enters `APPROVAL_UNCONFIRMED` and immediately attempts at most one read-only reconciliation GET. Never automatically issue another challenge or repeat a signature prompt.

If the reread proves the same plan approved at revision `N+1`, accept it. If it proves unapproved or changed, show the durable state and require a new explicit action. If no durable state can be obtained, retain the last confirmed plan, disable another approval attempt behind an explicit **Refresh approval status** read, and state that the result is unconfirmed. No local signature flag survives as approval authority.

## 8. UI integration

### Minimum surface

Retain the approved shell, tabs, plan document, manifest card, details card, status toolbar, and cancellation treatment. Add one in-page `ApprovalSection` below the deterministic plan (or immediately after its identity/hash block) and one small provider-selection subcomponent. Do not add a dashboard, modal wizard, portfolio chrome, transaction feed, or crypto market styling.

The authority section keeps visible:

- asset name and symbol;
- plan hash and revision;
- full required signer;
- Sandbox / Ethereum Sepolia (`11155111`);
- investor recipient and mint amount; and
- “Approving this plan does not submit a transaction. Tokenization, whitelist, and mint will each require a separate wallet confirmation in a later phase.”

The current “Execution controls offline” and “Offline in sandbox” copy should become state-accurate: approval may be available/recorded, while transaction execution remains unavailable. Remove the false “Retained in page session” and session-memory warning only after route recovery tests pass; replace them with a concise durable/access-lifetime statement that does not promise recovery after capability expiry/replacement.

### Existing components to reuse

- `PlanDocument` for the exact seven-step review and plan hash;
- `RecordedManifest` for asset, signer, recipient, allocation, and manifest hash;
- `RecordDetails` for run ID, state, revision, and timestamps;
- existing `Card`, `Badge`, `Button`, `Separator`, and copy-value patterns;
- `createPlanningWorkspace` serialization and prior-view retention, expanded for route recovery and approval projection updates; and
- the existing client wallet modules without copying their provider/signature logic into React.

### Presentation and accessibility

Provider choice must be a labeled radio group/list with collision entries disabled and self-reported metadata identified as such. Each action has a distinct accessible name: **Select wallet**, **Allow account access**, **Check wallet again**, **Switch to Ethereum Sepolia**, **Approve this plan**, and **Refresh approval status**. Do not collapse these into one “Connect/Approve” action.

Use `aria-live="polite"` for discovery/readiness/status transitions and `role="alert"` for actionable failures. Move focus to the authority heading after an explicit action failure, not on passive late announcements. Pending buttons expose `aria-busy`, retain stable dimensions, and are disabled by a synchronous single-flight guard. Full addresses/hashes must be inspectable and copyable without hover.

On narrow screens, stack the authority facts, provider list, readiness state, and one current action. Keep the plan review accessible above it; no nested horizontal scroller may hide the required signer or approval warning. Responsive changes must never remount a selected session or trigger provider methods.

## 9. File-level implementation plan

Every path below is expected future work after explicit approval. Paths marked “add” do not currently exist.

| Path | Change | Reason | Security significance |
| --- | --- | --- | --- |
| `docs/RUN_API_SPEC.md` | Document complete GET projection, route recovery, exact errors, and unchanged five-route inventory | Keep HTTP owner current | Prevent run ID from becoming implied authority |
| `docs/WALLET_EXECUTION_SPEC.md` | Document production approval-only composition and uncertainty behavior | Keep wallet owner current | Preserve exact signing and durable reread rules |
| `docs/ARCHITECTURE.md` | Add canonical run route/recovery and clarify post-approval `PREPARING` has no active execution in this phase | Keep trust/state owner current | Avoid accidental auto-resume/execution claims |
| `docs/MVP_IMPLEMENTATION_PLAN.md` | Record reviewed sequence and acceptance gates | Keep sequencing owner current | Makes stop boundary auditable |
| `README.md` | Replace page-memory limitation with truthful URL/capability behavior; describe approval-only availability | Operator/product setup truth | Prevents unsafe sharing/recovery assumptions |
| `src/shared/run/public.ts` (add) | Strict schemas/types for run, manifest, full seven-operation plan, complete record, mutation envelopes, and safe errors | One runtime DTO contract for server/client | Reject unknown/corrupt fields; no persistence/proof leakage |
| `src/shared/run/index.ts` (add) | Narrow exports for public run contract | Stable import boundary | Keeps server internals out of client graph |
| `src/server/run-api/projection.ts` (add) | Move `projectRun`/`publicPlan` into one strict allowlist projector; classify invariant failure | Reuse create/read projection | Fail closed and map corrupt server data to 503 |
| `src/server/run-api/handlers.ts` | Use projector; add manifest to GET; retain auth-before-lookup and all request gates | Complete recovery response | No capability or raw proof expansion |
| `src/server/run-api/handlers.test.ts` | Assert exact strict GET/create shapes, manifest recovery, projection corruption, approval response, and omissions | Contract evidence | Guards public/private boundary |
| `src/server/run-api/cookies.test.ts` | Add direct/reload/new-tab-equivalent reads, malformed ID, valid nonexistent run, expiry/replacement coverage | Recovery authority evidence | Proves lookup never precedes capability |
| `src/app/records/[runId]/page.tsx` (add) | Dynamic user page passing only bounded run ID to workspace | Durable locator | URL remains non-authoritative and capability-free |
| `src/app/page.tsx` | Continue rendering new-mandate workspace with no run ID | Preserve approved entry flow | No automatic access/cookie inspection |
| `src/components/run-planning.ts` | Consume shared strict DTO; add idempotent `recover(runId)` and accept complete GET artifacts; retain monotonic prior-view checks | Controller supports route hydration | No local manifest/hash authority; no mutation on reload |
| `src/components/run-planning-workspace.tsx` | Accept optional initial run ID; show recovery/access states; navigate after confirmed creation; host approval section; update truthful copy | Minimal composition in approved UI | Mount performs GET only; no wallet prompt/effect |
| `src/components/planning-artifacts.tsx` | Place/reuse authority facts and remove page-memory warning after recovery lands | Accurate presentation | Does not expose proof/challenge data |
| `src/client/run-api/approval-gateway.ts` (add) | Implement same-origin GET/challenge/approval calls with strict envelopes, bounded JSON, `no-store`, `redirect:error`, safe error codes | Production implementation of existing interface | Exact challenge bytes; no raw server/provider errors |
| `src/client/run-api/approval-gateway.test.ts` (add) | Verify methods, paths, bodies, credentials, envelopes, stale/error mapping, and no retries | HTTP/coordinator binding | Prevents extra fields, implicit replay, optimistic approval |
| `src/components/approval/approval-section.tsx` (add) | Render authority review and explicit action/state sequence | Minimum approval UI | Separates capability, readiness, signing, and execution |
| `src/components/approval/wallet-selection.tsx` (add) | Render explicit available/collision choices and legacy fallback action | Keep provider UI isolated | No default provider or unsafe metadata execution |
| `src/components/approval/approval-controller.ts` (add) | Own discovery/session lifecycle, synchronous mutex, readiness actions, coordinator call, uncertainty reread, and sanitized view state | Testable non-visual composition | No effect-driven accounts/switch/sign; disposes stale sessions |
| `src/components/approval/approval-controller.test.ts` (add) | Exhaustive state/order/invalidation/duplicate-action tests with fake providers/transports | Adversarial UI evidence | Proves one explicit signature prompt and durable authority |
| `src/components/run-planning.test.ts` | Add recovery, navigation, strict DTO, stale view, approval projection, and no-auto-wallet tests; update route allowlist assertion | Regression coverage | Browser never stores capabilities or computes authority |
| `src/client/wallet/approval.ts` | Minimally add typed uncertainty/reconciliation behavior or a narrow callback/result only if gateway/controller cannot provide it externally | Preserve coordinator as approval owner | Never infer approval from POST/signature; no duplicate prompt |
| `src/client/wallet/approval.test.ts` | Add stale read, expiry, malformed signature, submission loss, durable reread, wrong post-state, and one-signature assertions | Coordinator evidence | Binds exact plan and durable result |
| `src/client/wallet/discovery.test.ts` | Add selected-entry collision handoff expectations at composition boundary if needed | Cover lifecycle race | Prevents collided provider continuation |
| `src/client/wallet/session.test.ts` | Retain/add account-order, disconnect, chain-change, rejected switch, and cleanup cases used by UI | Readiness evidence | Prevents first-account and stale-generation shortcuts |
| `src/client/wallet/boundary.test.ts` | Recursively cover new approval gateway/controller modules for no storage, secrets, logging, fallback signing, or execution calls | Existing static guard must follow moved/new code | Prevents review gaps from file placement |
| `src/server/run-api/boundary.test.ts` | Keep exactly five API routes; include new client/page directories in import-boundary checks where applicable | Preserve public surface | Proves approval activation adds no execution route |
| `tools/phase8-harness/phase8-client-bundle-audit.ts` | Add `/records/[runId]/page` to allowed/required app paths, leave API route result exactly five | Audit new page artifacts | Ensures new client bundle is scanned for secrets |
| `tools/phase8-harness/phase8-client-bundle-audit.test.ts` | Update valid manifest fixture and assert missing/extra dynamic page failure | Audit regression | Prevents new page escaping artifact inventory |

No expected change: package dependencies/lockfile, `.env.example`, database schema/migrations, core manifest/plan derivation, persistence aggregate/codec, server security token semantics, Brickken adapter, orchestration write gate, wallet execution/transaction modules, or Phase 8 action harness runtime.

## 10. Tests

### Recovery contract and UI

1. Create response and GET response independently parse to the same complete planning record.
2. Fresh `/records/<id>` direct navigation issues one GET and renders manifest/plan/run state with no prior component memory.
3. Refresh reconstructs the same record without repository `create/update`, revision change, POST, hash recomputation as authority, wallet call, or execution call.
4. A valid capability succeeds and is never returned in body/props/storage/logs.
5. Missing, malformed, expired, rotated, and wrong-run/replaced capabilities return the same 403 before repository lookup.
6. A malformed run ID is rejected before lookup and rendered as a safe unavailable state.
7. A valid capability for a now-missing run returns 404 only after authorization.
8. Stored DTO/persistence corruption, rederived plan/hash mismatch, extra public keys, wrong tuple order, invalid timestamps, and invalid nested values fail closed as 503/invalid response with no partial record.
9. A newer same-identity revision replaces the view; an older revision or changed run/manifest/plan identity is rejected and the last confirmed record remains visible.
10. A new tab with the same browser cookie can GET the same route; a no-cookie transport cannot. This can be modeled offline with independent controllers sharing only the simulated cookie jar.
11. Create navigation happens only after a strict 201 projection and uses the run ID only. Lost create response does not navigate or retry.
12. Recovery request cancellation/late settlement after route change cannot overwrite the new route's state.

### Provider and readiness

1. Import, render, hydration, discovery start, focus, tab changes, and responsive changes cause zero EIP-1193 requests that access accounts, switch chain, sign, or send.
2. EIP-6963 discovery requests announcements only; no provider is selected automatically.
3. Late announcements render without focus theft; exact repeats deduplicate; malformed metadata is ignored.
4. UUID/provider collisions disable entries; collision of the selected entry disposes it and clears readiness.
5. Provider selection occurs only from an explicit user action; legacy provider reading is also explicit.
6. `eth_accounts` returning `[]` yields account-access-required; only the explicit action calls `eth_requestAccounts` once.
7. The required signer at index 1 or later reaches readiness; account zero is never substituted.
8. Authorized accounts without the signer yield required-signer-missing.
9. Wrong network yields wrong-chain; switch is explicit; rejected and unsupported switch paths are distinct.
10. `accountsChanged`, `chainChanged`, `connect`, `disconnect`, provider mutation, timeout, and disposal invalidate readiness and require reinspection.
11. Reselection and unmount remove listeners and ignore late provider settlements.

### Challenge, signature, and approval

1. Approve is unavailable until the current session is `READY` and the durable run is `PLAN/AWAITING_APPROVAL`, unapproved, and nonterminal.
2. Two rapid clicks invoke one serialized coordinator attempt and at most one `eth_signTypedData_v4` call.
3. Coordinator rereads before challenge; stale/approved/changed state makes zero challenge/sign calls and updates from durable state.
4. Challenge request uses the displayed expected revision and exact route/body.
5. Structured typed data, serialized typed data, digest, run ID, manifest hash, plan hash, required signer, chain, revision, nonce, issue time, expiry, and exact five-minute lifetime are validated.
6. Expired challenge fails before signing. Expiry after signing is rejected by the server and never shown as recorded.
7. Exact server serialization and exact signer are passed to `eth_signTypedData_v4`; no alternative signing method is called.
8. Wallet signature rejection yields not-recorded and no submission/retry.
9. Unsupported signing yields no fallback.
10. Malformed signature yields no submission; server independently rejects malformed or non-recovering signatures.
11. Wrong recovered signer, challenge MAC/purpose mismatch, run/revision/plan/signer/digest mismatch, and stale CAS all fail closed.
12. Account/chain/provider generation change before or during the attempt prevents submission or produces invalidated state; no automatic repeat prompt.
13. Approval POST receives only revision, opaque challenge token, and public signature.
14. Approval POST success followed by durable GET approved at `N+1` yields Approval recorded.
15. Approval POST success followed by unapproved/wrong-identity/malformed GET never yields recorded.
16. Lost/failed approval POST response triggers at most one read-only reread and no second signature. Durable approved state is accepted; otherwise result remains unconfirmed/not recorded.
17. Mutation 403 plus GET 403 presents capability unavailable; mutation 403 plus successful unapproved GET presents generic approval refusal without security diagnosis.
18. Server approval transition increments revision exactly once, stores proof privately, and makes zero Brickken/RPC/prepare calls.
19. An approved recovered run renders Approval recorded, hides all signing controls, and keeps execution unavailable.

### Boundary and regression

- Existing manifest normalization, golden hashes, seven operations/summaries, persistence codec, CAS, capability cookie, origin/fetch metadata, security proof, wallet discovery/session, and route-inventory tests must continue to pass.
- Static source assertions must scan new directories recursively for `localStorage`, `sessionStorage`, `document.cookie`, secret names, logging, fallback signing, `eth_sendTransaction`, execution-gateway imports, and direct server persistence imports.
- Production artifact audit must require and scan both page routes while continuing to report exactly five API routes.

## 11. Security review

| Boundary | Accidental weakening to prevent | Required guard |
| --- | --- | --- |
| Capability access | Treating run ID as auth; sending capability in URL/JSON/props/storage; querying before verification; alternate cookie fallback | Preserve auth-before-lookup and selected HttpOnly cookie policy; route holds locator only |
| Recovery authority | Trusting prior page state, form data, URL metadata, or client-rebuilt hashes | Complete server GET; strict DTO; server revalidation/rederivation; monotonic identity checks |
| Public projection | Spreading `ExecutionRun`, approval, operation, or error objects into JSON | Explicit allowlist projector plus strict response schema and omission tests |
| Approval binding | Rebuilding typed data in UI; signing a challenge for another revision/run/plan; weakening expiry | Use exact serialized server material; client and server binding validation; fresh explicit attempt |
| Wallet readiness | Selecting first provider/account; account request on mount; considering signer presence without chain; caching readiness across events | Explicit selection/actions; signer-anywhere exact match; Sepolia check; generation invalidation |
| CAS | Retrying approval mutation on 409 or using a revision from an unvalidated response | Submit displayed validated revision once; reread only; fresh review/action |
| Provider lifecycle | Continuing with collided/replaced/mutated provider; ignoring event during signing; leaking listeners | Stable captured session, collision disposal, generation assertion, cleanup, stale-promise suppression |
| Typed-data integrity | Parsing then reserializing, omitting domain/types fields, adding fallback signing, accepting malformed signatures | Preserve server string byte-for-byte; strict digest/equality checks; exact method; regex plus server recovery |
| Approval result | Treating signature or POST response as approval; auto-signing again after uncertainty | Final GET only; `APPROVAL_UNCONFIRMED`; explicit read before any later attempt |
| Phase boundary | Interpreting post-approval `TOKENIZATION/PREPARING` as permission to prepare or prompt a transaction | No execution gateway/routes/imports/UI; explicit “execution unavailable” copy and boundary tests |

Capability authorization and wallet identity must remain orthogonal. A browser can possess run capability without the signer account, and a wallet can expose the required signer without possessing run capability. Both are required for approval; neither substitutes for the other.

## 12. Implementation phases

### A. Public recovery contract

Add the strict public DTO/projector, make create/read use it, include manifest in GET, correct internal projection failure mapping, and add handler/capability/corruption tests. Update `RUN_API_SPEC.md` in the same review. Stop with no UI behavior change beyond compatible parsing.

Acceptance: complete GET is independently sufficient, authorization precedes lookup, no private field appears, no mutation occurs, and existing five-route inventory remains.

### B. Durable route and rehydration

Add `/records/[runId]`, initial read-only controller state, post-create canonical navigation, monotonic reread behavior, and truthful reload/access copy. Update the artifact audit path allowlist and route tests.

Acceptance: refresh/direct navigation/same-browser new tab work with a valid capability; absent/expired/replaced access fails closed; mount performs only GET.

### C. Approval HTTP gateway and uncertainty contract

Implement the strict production `ApprovalGateway`, application-owned safe HTTP errors, and final-reread/uncertainty behavior around the existing coordinator. Do not add routes or change approval cryptography/state transition.

Acceptance: exact challenge string survives untouched, stale and 403 cases are safe, submission ambiguity causes read-only reconciliation, and no signature/POST result alone sets approved.

### D. Provider/readiness controller and UI

Compose passive discovery, explicit selection, account access, signer matching, chain switching, invalidation, cleanup, and the minimum authority section. Keep all wallet methods behind click handlers except passive `eth_accounts`/`eth_chainId` inspection after explicit selection/recheck.

Acceptance: no implicit selection/account/switch/sign; collision/provider events clear readiness; required signer works at any account index; approved planning UI remains visually intact.

**IMPLEMENTED —** `src/components/approval/approval-controller.ts` owns discovery/session lifecycle, synchronous single-flight guards, stale-settlement suppression, collision handling, target invalidation, and sanitized readiness state. `src/components/approval/approval-section.tsx` renders the minimum authority surface in the existing planning workspace. Phase D established only the exact recorded signer plus Ethereum Sepolia and stopped at **Ready to approve**; Phase E extends this same controller through the approved approval-only coordinator while keeping execution uncomposed.

### E. Approval coordinator composition

Wire the explicit Approve action to the existing coordinator/gateway, serialize attempts, feed the final durable projection into the planning view, and render recorded/unconfirmed/stale states. Do not compose `execution.ts`.

Acceptance: one explicit signature prompt, exact EIP-712 material, one proof submission, final durable GET, revision N+1, and a hard stop at Approval recorded.

**IMPLEMENTED —** Only the enabled **Approve this plan** action enters `WalletApprovalCoordinator` behavior through the production `ApprovalGateway`. The coordinator first rereads and compares the displayed authority snapshot, requests and strictly validates one fresh challenge, reinspects readiness, invokes exact server-issued `eth_signTypedData_v4`, submits only revision/token/signature, and classifies one durable reread. Uncertain state locks signing and exposes only read-only approval-status refresh. The planning view accepts only a strict monotonic same-authority durable projection.

### F. Adversarial tests and full verification

Add all state, boundary, artifact, responsive, keyboard/focus, and failure tests; update owning documentation; run credential-free gates. Run the live database smoke test only with explicit human authorization and separately supplied ignored credentials. No real wallet signature or external request is required by the default suite.

This ordering establishes the durable source and strict transport before exposing wallet actions, then proves the stop boundary after composition.

## 13. Validation commands

Focused offline checks during implementation:

```sh
npm run test -- src/server/run-api/handlers.test.ts src/server/run-api/cookies.test.ts
npm run test -- src/components/run-planning.test.ts src/components/approval/approval-controller.test.ts
npm run test -- src/client/run-api/approval-gateway.test.ts src/client/wallet/approval.test.ts
npm run test -- src/client/wallet/discovery.test.ts src/client/wallet/session.test.ts src/client/wallet/boundary.test.ts
npm run test -- tools/phase8-harness/phase8-client-bundle-audit.test.ts
npm run test -- src/server/security/security.test.ts src/server/execution/transitions.test.ts src/server/persistence/codec.test.ts
```

Full offline gates:

```sh
npm run lint
npm run typecheck
npm run test
npm run check:phase8-harness
npm run test:phase8
npm run build
npm run audit:phase8-client-bundle
git status --short
```

The artifact audit copies only tracked files. It is valid evidence for new files only after those files are included in the intended Git index/source snapshot; do not mistake an audit of the prior tracked tree for coverage of untracked implementation.

Required opt-in durable-store gate, run only after explicit human authorization with credentials supplied outside source/logs:

```sh
npm run test:database-live
```

Do not run `npm run phase8:brickken-read`, `npm run test:brickken-live-read`, a real wallet signature, RPC request, database migration, prepare, broadcast, or any other live action as part of the default implementation verification.

Manual browser checks use only controlled local/synthetic API responses or an explicitly configured durable run API:

- refresh and reopen `/records/[runId]`;
- second tab in same browser versus clean profile;
- expired/replaced capability messaging;
- keyboard-only provider selection/account/switch/approve flow with fake provider;
- 320, 390, 768, 1024, 1280, and 1440px widths plus 200% zoom;
- long asset name, full addresses/hashes, error focus, and live announcements; and
- React Strict Mode verification that no account, switch, challenge, sign, or submit action occurs on mount/remount.

## 14. Explicit stop boundary

After this phase Edict may recover an authorized durable planning record and record an exact EIP-712 plan approval. It must stop at **Approval recorded**.

**CURRENT PHASE E STOP —** The implemented product now stops at **Approval recorded**. Signing can begin only from the explicit approval action after current readiness, and durable success requires the exact approved revision `N+1` post-state. No UI path prepares or sends a transaction, invokes Brickken/RPC execution, reconciles a transaction, performs read-back verification, or issues a receipt.

The following remain unimplemented and inactive:

- prepared-transaction execution or preview gateway;
- tokenization prepare/submission;
- whitelist prepare/submission;
- mint prepare/submission;
- `eth_sendTransaction` UI composition;
- durable wallet transaction prompt/result routes;
- Brickken write adapter activation;
- transaction-hash handoff, trusted-RPC comparison, or reconciliation;
- confirmation, polling, timeout resume, or finality actions;
- requested-versus-observed evidence projection/read-back;
- deployment receipt type, persistence, issuance, read, or download;
- production/mainnet, wallet accounts/login, capability recovery/refresh/share, multi-user access, or multi-agent orchestration.

Production semantic transaction authorization remains deny-all, and the Brickken write gate remains disabled. The existing transaction modules and internal orchestrator are not imported into the approval UI or made callable through new routes.

## 15. Open questions

1. **OPEN QUESTION — Release wallet evidence.** Which exact injected wallet/version, browser, and platform will receive the controlled approval-only compatibility check before public release? The implementation is vendor-neutral and offline fake-provider tests establish Edict behavior, but the repository contains no named-wallet verification. Until selected by the authorized operator, no wallet may be labeled verified or recommended. This does not block the architecture or offline implementation.

No repository ambiguity remains about recovery authority, capability lifetime, one-active-run replacement, public route shape, signer/chain requirements, approval cryptography, durable success criteria, or the execution stop boundary; those are fixed above by existing code and this recommendation.
