# Edict

## Overview

Edict is “Tokenization, as code”: a deterministic orchestration and verification layer over Brickken's sandbox Dapp API on Ethereum Sepolia. It automates and cryptographically verifies the locked MVP lifecycle: manifest/form → validation → execution plan → approval → tokenization → transaction tracking → investor whitelist → mint → read-back verification → deployment receipt.

## Security Rules

> **WARNING:** `BRICKKEN_API_KEY` is strictly server-only. Never expose it through a `NEXT_PUBLIC_*` variable, client bundle, browser storage, log, error payload, fixture, screenshot, or source control. Edict must never request, receive, read, store, log, or fabricate a private key or seed phrase; signing is performed exclusively by the connected browser wallet.

## Local Setup

### Prerequisites

- Node.js 24 LTS (see `.nvmrc`)
- npm

### Installation

```sh
npm install
```

### Environment Configuration

Inspect `.env.example` for approved environment variables. For local development, server variables may be placed in an uncommitted `.env.local` file (which is gitignored). Never populate secret values in `.env.example` or commit credentials.

`.env.example` is documentation; Next.js does not load it as runtime configuration. For local run planning, configure the four core server-only variables below; the fifth flag is optional and enables only the separately gated preparation/review milestone:

| Variable | Required format |
| --- | --- |
| `EDICT_RUN_API_ENABLED` | Exactly `1`; empty, `0`, `true`, or whitespace-padded values do not enable the gate. |
| `EDICT_TRUSTED_ORIGIN` | The exact browser origin: scheme, hostname and port, with no trailing slash, path, query, fragment or embedded credentials. `http://localhost:3000` is supported; use the actual local port. HTTPS origins are also supported. |
| `EDICT_RUN_SECURITY_SECRET` | **Secret:** unpadded base64url (`A–Z`, `a–z`, `0–9`, `_`, `-`) encoding at least 32 cryptographically random bytes. Never use a sample or predictable string. |
| `DATABASE_URL` | **Secret:** the actual Neon Postgres connection URI, starting with `postgresql://` or `postgres://`, without surrounding whitespace. The existing run tables must be available and the database reachable for real persistence. |
| `EDICT_TRANSACTION_PREPARATION_ENABLED` | Optional server-only exact `1`. Enables only explicit TOKENIZE preparation/review; all wallet prompt, broadcast and later execution actions remain unavailable. Preparation also requires the server-only `BRICKKEN_API_KEY`. |

Stop and restart `npm run dev` after local configuration changes; launch it from the environment containing the settings and use the matching browser origin. Do not paste the secret or database URI into chat, screenshots, logs or commits. Explicit HTTP loopback origins in development/test use the separate `edict_run_access_dev` HttpOnly, SameSite=Strict cookie with `Path=/`, no Domain and no Secure attribute. HTTPS and production retain `__Host-edict_run_access` with Secure. Changing the security secret and restarting invalidates prior capabilities; reload and create a fresh run.

`Run creation is not enabled in this environment.` means the server returned `API_DISABLED`: the flag was not exactly `1`, or the configured origin was missing or invalid. A configured trailing slash disables the gate; a valid origin with a different browser port instead returns `FORBIDDEN`. Missing capability or database configuration is checked later and does not produce `API_DISABLED`. Configure all four variables before creating a run.

Planning can be enabled independently of Brickken preparation. No Brickken API key or live-test flag is required to create or approve a plan. Transaction preparation is separately deny-by-default and makes one server-authorized Brickken sandbox request only after an explicit click. Production wallet semantic authorization remains deny-all; preparation does not activate a wallet prompt, RPC, broadcast, confirmation, polling or Phase 8 actions. Configure preview access or rate limiting before exposing run creation beyond local development.

## Available Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the production application |
| `npm run lint` | Run ESLint across the codebase |
| `npm run typecheck` | Run TypeScript strict compiler checks (`tsc --noEmit`) |
| `npm run test` | Run Vitest unit and architectural assertion tests |
| `npm run test:brickken-live-read` | Opt-in credential-bearing Brickken sandbox network-info read; excluded from default tests |
| `npm run db:generate` | Generate reviewable Drizzle SQL migrations without connecting to a database |
| `npm run db:migrate` | Apply committed migrations using ignored runtime `DATABASE_URL` configuration |
| `npm run test:database-live` | Opt-in Neon create/read/CAS/cleanup verification; excluded from default tests |
| `npm run test:phase8` | Run only the offline Phase 8 adversarial and harness tests |
| `npm run check:phase8-harness` | Compile-check the isolated harness, which is excluded from the production application build |
| `npm run audit:phase8-client-bundle` | Build an isolated tracked-source snapshot with network denied, then scan build logs, browser artifacts and the real pre-bootstrap harness page |
| `npm run phase8:brickken-read` | Separately authorized interactive sandbox network-information action; do not run as an offline check |
| `npm run check` | Run all checks (`lint`, `typecheck`, `test`, `build`) in sequence |

## Phase Status

- **Phase 0: Discovery & Architecture** — Completed and verified.
- **Phase 1: Application Foundation** — Complete. Scaffolding, strict TypeScript App Router, Tailwind CSS, Vitest, pinned `brickken-sdk@0.2.1`, and server-only boundaries established.
- **Phase 2: Deterministic Core Domain** — Complete. The versioned normalized manifest, strict validation, canonical JSON, SHA-256 identities, immutable execution plan, and golden tests are specified in [`docs/CORE_DOMAIN_SPEC.md`](docs/CORE_DOMAIN_SPEC.md).
- **Phase 3: Brickken Wire-Contract Audit** — Complete. The adversarial review, conflict register, retry matrix, and sourced fixtures are in [`docs/BRICKKEN_WIRE_CONTRACT_AUDIT.md`](docs/BRICKKEN_WIRE_CONTRACT_AUDIT.md) and `src/server/brickken/test-vectors/`.
- **Phase 4: Execution Safety and Brickken Adapter** — Complete. The application-owned run state machine and in-memory repository are committed, and the server-only sandbox adapter is covered by injected transport tests. A historical opt-in credential-bearing network-info read recorded `Sepolia ETH`; it did not establish authentication semantics and no authenticated write occurred. At Phase 4 completion, live writes were blocked on durable persistence.
- **Phase 5: Durable Execution Persistence** — Complete and verified. Neon Postgres and Drizzle are contained behind the existing server repository interface, with a versioned JSONB run snapshot, strict codec, atomic optimistic concurrency, deterministic SQL migration, and credential-free default tests. On 2026-09-04, the migration and opt-in Neon test passed create, read, compare-and-swap update, stale-revision refusal, and deletion of the unique smoke-test run.
- **Phase 6: Secure Run APIs and Durable Orchestration** — Complete. The deny-by-default, same-origin API exposes only run creation/read, approval challenge/verification and cancellation. Run capabilities use a hardened HttpOnly cookie; plan approval preserves EIP-712 EOA evidence in versioned V2 snapshots; internal orchestration enforces CAS intent ordering, double write gates and ambiguity blocking with injected Brickken behavior. See [`docs/RUN_API_SPEC.md`](docs/RUN_API_SPEC.md).
- **Phase 7: Browser Wallet Authorization and Transaction Boundary** — Complete offline. The vendor-neutral EIP-6963/EIP-1193 boundary provides explicit provider selection, exact server-issued EIP-712 approval requests, strict immutable transaction projection, canonical wallet-intent integrity, and durable prompt-before-send/hash-handoff ordering. No named wallet or live write is verified. See [`docs/WALLET_EXECUTION_SPEC.md`](docs/WALLET_EXECUTION_SPEC.md).
- **Phase 8: Adversarial Boundary and Compatibility Harness** — Complete offline. Provider hardening, bounded deadlines, exact trusted-RPC transaction/receipt evidence, backward-compatible `ExecutionRunV3`, an isolated one-action operator harness, and the strict `BRICKKEN_READ` sandbox network-information executor are implemented. The executor has not been run, no named wallet is privileged or verified, the V3 migration is generated but unapplied, and production semantic authorization remains deny-all. See [`docs/PHASE_8_OPERATOR_PLAYBOOK.md`](docs/PHASE_8_OPERATOR_PLAYBOOK.md).
- **Phase 9: Offline TOKENIZE Representational Compatibility** — Closed through composition tests of the existing prepared parser, wallet projection, server intent derivation and browser recomputation. No production code or external-effect surface was added; semantic authorization remains deny-all. See [the Phase 9 contract](docs/WALLET_EXECUTION_SPEC.md#phase-9-offline-tokenize-compatibility).
- **Run Planning Workspace checkpoint** — Closed after offline verification. The root page provides a guided mandate form, server-normalized manifest and deterministic plan review, public status/revision and hashes, manual refresh, and legal cancellation with the exact expected revision.
- **Phase 10: Execution Activation, preparation/review milestone** — Implemented offline. An approved run can explicitly prepare the server-selected TOKENIZE operation and recover an immutable exact transaction review. Preparation is a gated Brickken sandbox effect and two durable CAS mutations. Wallet confirmation, `eth_sendTransaction`, transaction hashes and every later execution stage remain unavailable.
- **Durable recovery checkpoint:** The root page remains the new-mandate surface and `/records/[runId]` is the canonical recorded-run surface. Create and authorized GET return the same strict complete planning record. Reload and same-browser tabs reconstruct from durable server state without changing revision. The run ID is only a locator; the existing one-active-run HttpOnly capability remains the authority.
- **Approval readiness checkpoint:** The recorded-plan surface passively discovers injected EIP-6963 providers and supports explicit provider/legacy selection, account access, exact tokenizer-signer inspection, Sepolia switching, recheck, invalidation and cleanup. It stops at **Ready to approve**. No provider is preferred or labeled verified.
- **Approval recording checkpoint:** From **Ready to approve**, one explicit action performs a durable preflight, fresh bounded EIP-712 challenge, readiness recheck, exact typed-data signature, proof submission, and one durable reconciliation read. Only the exact approved revision `N+1` state is presented as recorded; uncertainty blocks another signature until read-only status refresh.
- **Stop:** Wallet transaction prompting, `eth_sendTransaction`, broadcasting, Brickken confirmation, polling, RPC comparison, read-back, receipts, and other live actions remain unauthorized. No live preparation was run during implementation; account-backed evidence remains separate work for the authorized operator.

## Run planning workspace

The product uses six `/api/runs` routes: create, read, cancel, approval challenge, approval submission, and the preparation-only `POST /api/runs/[runId]/prepare`. Preparation accepts only `expectedRevision`; the server selects TOKENIZE from durable state. The canonical user-facing route remains `/records/[runId]`; backend/domain terminology remains `runId`, `ExecutionRun`, and `/api/runs`. No wallet prompt or broadcast route exists.

After a successful create response, the browser replaces the root URL with `/records/[runId]`. That route independently reloads the complete server-normalized manifest, deterministic plan and public run state through authorized GET. The existing HttpOnly capability cookie authorizes reads and mutations; the run ID itself grants nothing. Browser GET reads may omit `Origin`; present origins must match and cross-site Fetch Metadata is refused. Mutations still require the exact trusted origin. No capability or security material is placed in the URL, React props or browser storage. Creating another run replaces access to the earlier run under the unchanged one-active-run policy. See [`docs/RUN_API_SPEC.md`](docs/RUN_API_SPEC.md).

## Durable Database Gate

The deployed repository uses Neon Postgres through Drizzle's Neon HTTP adapter. Local/in-memory storage is for tests and demonstrations only and must never back deployed write execution.

The persistence packages are pinned exactly: [`drizzle-orm@0.45.2`](https://www.npmjs.com/package/drizzle-orm/v/0.45.2), [`@neondatabase/serverless@1.1.0`](https://www.npmjs.com/package/@neondatabase/serverless/v/1.1.0), and [`drizzle-kit@0.31.10`](https://www.npmjs.com/package/drizzle-kit/v/0.31.10).

Server-side EIP-712 approval recovery and the shared browser-compatible primitives use exactly pinned `viem@2.56.3`. Phase 7 remains vendor-neutral, supports EOA approval only, and does not attempt EIP-1271 or make an RPC request to classify a signer.

The isolated Phase 8 TypeScript CLI declares `tsx@4.23.13` directly as a development dependency. That exact package was already locked transitively through `drizzle-kit`; promotion changed no package version, integrity hash, resolved URL or transitive graph and introduced no additional dependency.

**VERIFIED — 2026-09-04:** `npm run db:migrate` completed successfully. The explicitly opted-in `npm run test:database-live` then passed against Neon: it created and read a unique run, completed one atomic compare-and-swap update, refused a stale revision, and deleted the run before emitting its sanitized success result.

No live Brickken write or blockchain operation occurred during this implementation. Brickken signer approval, tokenizer licensing, credits, live prepared payloads, browser-wallet compatibility, finality, and write behavior remain unverified; production wallet semantic authorization and every post-preparation write path remain disabled.

The run API remains disabled unless an operator first configures deployment-level preview access or rate limiting and explicitly sets `EDICT_RUN_API_ENABLED=1`, an exact `EDICT_TRUSTED_ORIGIN`, durable database configuration, and the server-only run security secret. The local HTTP cookie exception is limited to explicitly configured loopback origins in development/test; it does not enable Brickken writes or external execution.
