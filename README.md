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

## Available Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the production application |
| `npm run lint` | Run ESLint across the codebase |
| `npm run typecheck` | Run TypeScript strict compiler checks (`tsc --noEmit`) |
| `npm run test` | Run Vitest unit and architectural assertion tests |
| `npm run test:brickken-live-read` | Opt-in authenticated Brickken sandbox network-info read; excluded from default tests |
| `npm run db:generate` | Generate reviewable Drizzle SQL migrations without connecting to a database |
| `npm run db:migrate` | Apply committed migrations using ignored runtime `DATABASE_URL` configuration |
| `npm run test:database-live` | Opt-in Neon create/read/CAS/cleanup verification; excluded from default tests |
| `npm run check` | Run all checks (`lint`, `typecheck`, `test`, `build`) in sequence |

## Phase Status

- **Phase 0: Discovery & Architecture** — Completed and verified.
- **Phase 1: Application Foundation** — Complete. Scaffolding, strict TypeScript App Router, Tailwind CSS, Vitest, pinned `brickken-sdk@0.2.1`, and server-only boundaries established.
- **Phase 2: Deterministic Core Domain** — Complete. The versioned normalized manifest, strict validation, canonical JSON, SHA-256 identities, immutable execution plan, and golden tests are specified in [`docs/CORE_DOMAIN_SPEC.md`](docs/CORE_DOMAIN_SPEC.md).
- **Phase 3: Brickken Wire-Contract Audit** — Complete. The adversarial review, conflict register, retry matrix, and sourced fixtures are in [`docs/BRICKKEN_WIRE_CONTRACT_AUDIT.md`](docs/BRICKKEN_WIRE_CONTRACT_AUDIT.md) and `src/server/brickken/test-vectors/`.
- **Phase 4: Execution Safety and Brickken Adapter** — Complete. The application-owned run state machine and in-memory repository are committed, and the server-only sandbox adapter is covered by injected transport tests. An opt-in authenticated network-info read identified `Sepolia ETH`; no authenticated write has occurred. At Phase 4 completion, live writes were blocked on durable persistence.
- **Phase 5: Durable Execution Persistence** — Complete and verified. Neon Postgres and Drizzle are contained behind the existing server repository interface, with a versioned JSONB run snapshot, strict codec, atomic optimistic concurrency, deterministic SQL migration, and credential-free default tests. On 2026-09-04, the migration and opt-in Neon test passed create, read, compare-and-swap update, stale-revision refusal, and deletion of the unique smoke-test run.
- **Phase 6: Secure Run APIs and Durable Orchestration** — Complete. The deny-by-default, same-origin API exposes only run creation/read, approval challenge/verification and cancellation. Run capabilities use a hardened HttpOnly cookie; plan approval preserves EIP-712 EOA evidence in versioned V2 snapshots; internal orchestration enforces CAS intent ordering, double write gates and ambiguity blocking with injected Brickken behavior. See [`docs/RUN_API_SPEC.md`](docs/RUN_API_SPEC.md).
- **Phase 7: Browser Wallet Authorization and Transaction Boundary** — Complete offline. The vendor-neutral EIP-6963/EIP-1193 boundary provides explicit provider selection, exact server-issued EIP-712 approval requests, strict immutable transaction projection, canonical wallet-intent integrity, and durable prompt-before-send/hash-handoff ordering. No named wallet or live write is verified. See [`docs/WALLET_EXECUTION_SPEC.md`](docs/WALLET_EXECUTION_SPEC.md).
- **Next Task:** Phase 8 should add no write route yet; perform the adversarial execution-boundary review and define the smallest human-authorized sandbox compatibility harness for one explicit wallet/version and the three Brickken prepared operations.

## Durable Database Gate

The deployed repository uses Neon Postgres through Drizzle's Neon HTTP adapter. Local/in-memory storage is for tests and demonstrations only and must never back deployed write execution.

The persistence packages are pinned exactly: [`drizzle-orm@0.45.2`](https://www.npmjs.com/package/drizzle-orm/v/0.45.2), [`@neondatabase/serverless@1.1.0`](https://www.npmjs.com/package/@neondatabase/serverless/v/1.1.0), and [`drizzle-kit@0.31.10`](https://www.npmjs.com/package/drizzle-kit/v/0.31.10).

Server-side EIP-712 approval recovery and the shared browser-compatible primitives use exactly pinned `viem@2.56.3`. Phase 7 remains vendor-neutral, supports EOA approval only, and does not attempt EIP-1271 or make an RPC request to classify a signer.

**VERIFIED — 2026-09-04:** `npm run db:migrate` completed successfully. The explicitly opted-in `npm run test:database-live` then passed against Neon: it created and read a unique run, completed one atomic compare-and-swap update, refused a stale revision, and deleted the run before emitting its sanitized success result.

No Brickken request or blockchain operation occurred. Brickken signer approval, tokenizer licensing, credits, prepared write payloads, browser-wallet compatibility, finality, and write behavior remain unverified; the Phase 7 production semantic policy and Brickken write gate remain disabled.

The run API remains disabled unless an operator first configures deployment-level preview access or rate limiting and explicitly sets `EDICT_RUN_API_ENABLED=1`, an exact `EDICT_TRUSTED_ORIGIN`, durable database configuration, and the server-only run security secret. Local development keeps the capability cookie's `Secure` attribute; use a browser that treats localhost as a secure context or local HTTPS.
