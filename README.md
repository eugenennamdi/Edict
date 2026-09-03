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
| `npm run check` | Run all checks (`lint`, `typecheck`, `test`, `build`) in sequence |

## Phase Status

- **Phase 0: Discovery & Architecture** — Completed and verified.
- **Phase 1: Application Foundation** — Complete. Scaffolding, strict TypeScript App Router, Tailwind CSS, Vitest, pinned `brickken-sdk@0.2.1`, and server-only boundaries established.
- **Phase 2: Deterministic Core Domain** — Complete. The versioned normalized manifest, strict validation, canonical JSON, SHA-256 identities, immutable execution plan, and golden tests are specified in [`docs/CORE_DOMAIN_SPEC.md`](docs/CORE_DOMAIN_SPEC.md).
- **Next Task:** Task 3 (adversarial review and test vectors for the Brickken wire-contract conflicts; no integration implementation yet).
