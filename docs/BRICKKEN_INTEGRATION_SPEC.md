# Brickken integration specification

Checked: 2026-09-04 (Africa/Lagos; Phase 0 anonymous response timestamp 2026-09-03 17:47:30 GMT)

Phase 3 wire-contract audit: [`BRICKKEN_WIRE_CONTRACT_AUDIT.md`](BRICKKEN_WIRE_CONTRACT_AUDIT.md). Sourced fixtures: `src/server/brickken/test-vectors/`. This file remains the owned integration contract; the audit is the adversarial review of the same official sources plus pinned `brickken-sdk@0.2.1`.

## Claim labels

- **VERIFIED** — Supported directly by the adjacent official Brickken documentation, official Brickken repository, official npm metadata, or a recorded bounded live check.
- **ASSUMPTION** — A bounded inference that must be tested before reliance.
- **DECISION** — Edict's chosen behavior or constraint.
- **OPEN QUESTION** — Unverified or contradictory behavior that must not be invented.

## Environment and authentication

| Status | Contract |
| --- | --- |
| VERIFIED | The Dapp API sandbox base URL is `https://api.sandbox.brickken.com`; sandbox and production have separate databases and keys. [Dapp API](https://docs.brickken.com/api-reference/introduction) |
| VERIFIED | Dapp tokenization writes and the token-scoped reads used by this MVP require `x-api-key`; x402 is not accepted for the Dapp API. The conflicting network-info exception is recorded below. [Authentication](https://docs.brickken.com/get-started/authentication) |
| VERIFIED | A `signerAddress` must be whitelisted by Brickken before prepare calls accept it. The same request thread used to obtain a sandbox API key handles signer whitelisting. [Authentication](https://docs.brickken.com/get-started/authentication) [Request an API key](https://docs.brickken.com/get-started/request-api-key) |
| VERIFIED | Once a wallet performs `newTokenization`, it becomes the token's tokenizer; only that tokenizer can later mint, distribute dividends, or manage the investor whitelist. [Authentication](https://docs.brickken.com/get-started/authentication) |
| VERIFIED | A key can act only on token symbols whose tokenizer email matches a `newTokenization` performed under the same key; unauthorized access returns `Unauthorized token symbol`. [Authentication](https://docs.brickken.com/get-started/authentication) |
| VERIFIED | The supported sandbox targets requested by Brickken's key-request workflow include Sepolia, Polygon Amoy, and Base Sepolia. [Request an API key](https://docs.brickken.com/get-started/request-api-key) |
| DECISION | Use Ethereum Sepolia for the MVP: decimal chain ID `11155111`, accepted/recommended REST hex form `aa36a7`. Tokenization examples and prepared responses explicitly use this network. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization) |
| DECISION | The API key exists only in the Next.js server runtime or deployment secret store and is attached only inside server-only Brickken adapters. |
| DECISION | Edict never uses x402, production endpoints, `brickken-relayed`, private-key adapters, or on-behalf endpoints in the MVP. |

## Safe public connectivity check

**VERIFIED** — The only live Brickken request made during Phase 0 was this unauthenticated, read-only request:

```sh
curl -sS -i --max-time 20 -H 'Accept: application/json' 'https://api.sandbox.brickken.com/get-network-info?chainId=aa36a7'
```

**VERIFIED** — Its HTTP request semantics were:

```text
GET https://api.sandbox.brickken.com/get-network-info?chainId=aa36a7
Accept: application/json
No x-api-key header
No request body
```

**VERIFIED** — The sandbox host completed HTTP/TLS connectivity and returned `HTTP 401` at `Thu, 03 Sep 2026 17:47:30 GMT` with this sanitized body; no credentials were supplied or exposed:

```json
{
  "errors": {
    "messages": "API key is required for this endpoint",
    "status": 401,
    "name": "Unauthorized Error"
  }
}
```

**OPEN QUESTION** — Official pages conflict with live behavior. The authentication and SDK installation pages say `GET /get-network-info` is public and should return `200` without a key, while the endpoint reference marks `x-api-key` required and the live check returned `401`. Do not build an unauthenticated health check until Brickken resolves this. [Authentication](https://docs.brickken.com/get-started/authentication) [SDK installation](https://docs.brickken.com/sdk/installation) [Get Network Information](https://docs.brickken.com/api-reference/endpoint/get-network-info)

**DECISION** — The currently anonymous `/get-network-info` request returned `401`; implementation must not depend on that endpoint being public. Until resolved, Edict's readiness check reports the host as reachable but the public network-info contract as incompatible. No authenticated fallback was attempted in Phase 0.

## Historical credential-bearing adapter connectivity check

**HISTORICAL OBSERVATION — 2026-09-04** — The human operator ran the opt-in `npm run test:brickken-live-read` command in a normal local terminal. A historical credential-bearing Brickken sandbox network-information request succeeded. The request semantics were:

```text
GET https://api.sandbox.brickken.com/get-network-info?chainId=11155111
Sent through the server-only adapter with a credential-bearing header; credential details deliberately not recorded
No request body
```

The sanitized adapter projection was:

```json
{
  "category": "NETWORK_INFO",
  "currencyName": "Sepolia ETH",
  "blockExplorerHost": "sepolia.etherscan.io"
}
```

**HISTORICAL OBSERVATION — 2026-09-04** — A credential-bearing adapter request reached the sandbox and recorded the sanitized projection `Sepolia ETH` and `sepolia.etherscan.io`. This correction task did not repeat the request; current behavior remains unverified. The projection does not prove the raw response had no additional properties, nor that the credential was required, accepted as authority or independently authenticated. It does not change the earlier anonymous `401` observation or prove that the endpoint is public. A changed or additional current response must fail closed pending review.

**CONTROLLED OBSERVATION — 2026-09-09** — Two separately approved `newTokenization` preparation-only checks reached `POST https://api.sandbox.brickken.com/prepare-transactions`; neither was retried. The diagnostic request used `application/json`, `execute:false` in the SDK, and body keys `chainId`, `executionMode`, `method`, `name`, `signerAddress`, `supplyCap`, `tokenSymbol`, `tokenType`, `tokenizerEmail`, and `url`. The second response was HTTP 400 `application/json`, 101 bytes, with a top-level `errors` object, license/subscription/entitlement semantics, and no `txId` or `transactions`. Raw headers, values, credentials, emails, signatures, capabilities, and response prose were not retained. This is a sanitized authenticated observation, not proof of the successful prepare contract.

**DECISION** — The checks performed no signing, wallet prompt, send, broadcast, confirmation, poll, whitelist, mint, or blockchain operation. Both durable runs remain `PREPARE_UNKNOWN/RECONCILIATION_REQUIRED`; neither may be prepared again. Signer approval, an active tokenizer license, sufficient credits, successful prepared output, wallet compatibility, finality, and write completion remain unverified.

## Transaction lifecycle

**SUPPORT-CONFIRMED — 2026-09-11** — Dapp writes in `client-broadcast` follow `POST /prepare-transactions` → wallet `eth_sendTransaction` → durable `txHash` → `POST /send-transactions {txId,txHash}` correlation → `GET /transaction-status` → trusted-RPC finality → read-back. Brickken does not rebroadcast during `/send-transactions`.

**VERIFIED** — The API exposes three execution modes. For `client-broadcast`, the user signs and broadcasts, then the client confirms exactly one `{ txId, txHash }` pair to Brickken; this mode works for Dapp methods. Resubmitting the same pair is idempotent. [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)

**DECISION** — Edict intends to use `client-broadcast` for all three on-chain operations. Phase 10 makes only explicit TOKENIZE preparation/review available behind a separate deny-by-default server gate; production wallet semantic authorization remains deny-all. A preparation request is a semantic Brickken write effect even though it uses `execute:false`, so mount/recovery never invokes it and ambiguous results are never retried automatically. The controlled authenticated preparation checks above were refused or unconfirmed; no browser broadcast or live RPC comparison occurred.

**VERIFIED** — A prepared response contains `transactions` (unsigned transaction objects), `txId` (Brickken's internal prepared-batch identifier, not a blockchain hash), and optional `info`. [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create)

**VERIFIED** — Prepared transaction fields shown by Brickken include `from`, `to`, `value`, `nonce`, numeric `chainId`, `data`, `type`, `maxPriorityFeePerGas`, `maxFeePerGas`, and `gasLimit`. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**CONFLICT** — Prepare-page examples encode `value`/`gasLimit` as hex strings and fees as decimal strings, while the send OpenAPI `UnsignedTransaction` schema serialises those fields as `{ type: "BigNumber", hex }`. Runtime schemas must accept both. [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create) [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)

**VERIFIED** — Prepared transactions are ethers-style unsigned transactions, not EIP-1193 payloads. Official browser-wallet guidance converts numeric fields to hex, renames `gasLimit` to `gas`, and omits `nonce`, `chainId`, `type`, and fee fields before `eth_sendTransaction`. [Browser wallets](https://docs.brickken.com/api-reference/guides/browser-wallets)

**SUPPORT-CONFIRMED — 2026-09-11** — `POST /send-transactions` in `client-broadcast` is correlation only. It accepts exactly one persisted `txId` and its already-broadcast `txHash`, consumes credit on the first valid correlation, and is idempotent only for that identical pair. HTTP 202 returns `results[0].result.transactionHash`, `status: "pending"`, and `executionMode: "client-broadcast"`. A temporarily unseen mempool transaction permits bounded same-pair correlation retry, never another wallet send. [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)

**SUPPORT-CONFIRMED — 2026-09-11** — `GET /transaction-status` accepts `txId` or `hash` and is the recovery/tracking endpoint. The pinned `brickken-sdk@0.2.1` still targets the obsolete `/get-transaction-status`; production integration must use the confirmed route through a strict server-only adapter until an updated SDK is independently verified.

**VERIFIED** — A `pending` status means broadcast but not yet confirmed and must be polled rather than resubmitted. [Get Transaction Status](https://docs.brickken.com/api-reference/endpoint/get-transaction-status)

**DECISION** — Persist the prepare response before exposing the wallet action; persist `txHash` immediately after the wallet returns it and before calling `/send-transactions`; persist every poll result.

**SUPPORT-CONFIRMED — 2026-09-11** — Brickken requires exact equality for `chainId`, `from`, `to`, `data`, `value`, and `nonce`. The prepared nonce must be explicitly supplied to `eth_sendTransaction`. Brickken does not compare `gasLimit`, `maxFeePerGas`, or `maxPriorityFeePerGas`; Edict nevertheless accepts changes only inside a separately user-authorized bounded fee envelope. A consumed prepared nonce requires a new explicit `/prepare-transactions` call for the same operation, never local nonce mutation.

**DECISION** — A local polling timeout changes the operation to `TIMED_OUT`, not failed. Resume polling the same `txId`/`txHash` after refresh or operator action; never create a replacement automatically.

## MVP write contract

### `newTokenization`

**VERIFIED** — Prepare with `POST /prepare-transactions` and `method: "newTokenization"`. Required fields on the current dedicated page are `method`, `chainId`, `signerAddress`, `tokenizerEmail`, `name`, and `tokenSymbol`. `tokenType`, `supplyCap`, `url`, `tokenizerAddress`, `paymentTokenAddress`, `preMints`, and `initialHolders` are optional. `name`, not `tokenName`, is accepted. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**VERIFIED** — The current dedicated page says `tokenSymbol` must be 2–5 uppercase letters or numbers and unused; `tokenType` defaults to `EQUITY`; `tokenizerEmail` must identify an existing account with an active tokenization license. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**VERIFIED** — Current dedicated and unified prepare OpenAPI both say `tokenSymbol` must be 2–5 uppercase letters or numbers. The Hello World walkthrough also generates a 2–5 character symbol. The Phase 0 3–5 sentence is not present in the official pages inspected on 2026-09-03. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization) [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create) [API Hello World](https://docs.brickken.com/get-started/build-programme/api-hello-world)

**DECISION** — Edict core still validates `[A-Z0-9]{3,5}` as the conservative intersection chosen in Phase 2. That core rule is not changed in Phase 3. A 2-character symbol remains an authenticated sandbox question, not an Edict V1 input.

**VERIFIED** — If `preMints` is supplied, `initialHolders` must also be supplied at the same length; each holder may use `walletAddress` or an email resolvable to a DFNS wallet. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**DECISION** — The MVP omits `preMints`, `initialHolders`, `tokenizerAddress`, `paymentTokenAddress`, private RPC overrides, gas overrides, and nonce overrides. It provides an HTTPS documentation `url` even though the current dedicated schema calls it optional.

**VERIFIED** — Current dedicated and unified prepare schemas both call `url` optional and default it to an empty string. The Phase 0 “unified summary required” wording is not present in the official pages inspected on 2026-09-03. [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create) [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**DECISION** — Edict still supplies and validates an HTTPS documentation URL. Omitting `url` is not part of the locked manifest.

**VERIFIED** — Wait for tokenization `success` before using the symbol for whitelist or mint. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**VERIFIED** — The tokenizer wallet (`signerAddress`) signs this deployment. It must be Brickken-approved and funded with Sepolia native gas. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

### `whitelist`

**VERIFIED** — Prepare with `POST /prepare-transactions` and `method: "whitelist"`. Required fields on the current dedicated OpenAPI are `method`, `chainId`, `signerAddress`, `tokenSymbol`, and `userToWhitelist`. Each entry requires `investorAddress`, `investorEmail`, and boolean `whitelistStatus`. The response contains `transactions` and `txId`. [whitelist](https://docs.brickken.com/api-reference/endpoint/prepare-whitelist)

**VERIFIED** — The tokenizer wallet signs whitelist management. [Authentication](https://docs.brickken.com/get-started/authentication)

**VERIFIED** — Current dedicated OpenAPI, unified prepare schema, Postman, and HTTP/SDK guides all type `whitelistStatus` as a JSON boolean (`true` / `false`). A string `"true"` / `"false"` schema was not present in official sources inspected on 2026-09-03. [whitelist](https://docs.brickken.com/api-reference/endpoint/prepare-whitelist) [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create)

**OPEN QUESTION** — Live sandbox may still accept or return a string form. Phase 4 must not coerce; an authenticated contract test remains required. The string success fixture is omitted because no current official example exists.

**CONFLICT** — Whitelist prose and the sandbox guide document `needKyc` on each `userToWhitelist` entry (`false` in sandbox only). The dedicated OpenAPI properties do not declare `needKyc`. [whitelist](https://docs.brickken.com/api-reference/endpoint/prepare-whitelist) [Sandbox](https://docs.brickken.com/get-started/sandbox)

**DECISION** — The approved plan contains a standalone whitelist operation before mint. After it reaches `success`, Edict calls `GET /get-whitelist-status` and requires `isWhitelisted === true` before preparing mint.

**DECISION** — The MVP sends exactly one investor per whitelist operation even though the endpoint accepts an array.

### `mintToken`

**VERIFIED** — Prepare with `POST /prepare-transactions` and `method: "mintToken"`. Required fields are `method`, `chainId`, `signerAddress`, `tokenSymbol`, and a non-empty `userToMint`. Each recipient needs `investorEmail`, `investorAddress`, a positive whole-token string `amount`, and boolean `needWhitelist`. [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken)

**VERIFIED** — `investorEmail` must differ from `tokenizerEmail`, even if sandbox testing uses the same wallet. `needWhitelist` controls whether the mint also whitelists; it does not remove the separate identity requirement. [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken)

**VERIFIED** — The tokenizer wallet signs the mint and any whitelist bundled into it. [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken)

**DECISION** — Because the locked MVP requires an explicit whitelist stage, set `needWhitelist: false` only after standalone whitelist read-back succeeds. This avoids hiding a second state change inside mint and yields distinct approval, transaction, and verification evidence.

**ASSUMPTION** — A previously confirmed standalone whitelist permits `mintToken` with `needWhitelist: false` and yields exactly one prepared transaction. The historical credential-bearing network-info observation did not validate this write assumption.

**VERIFIED** — Current dedicated whitelist schema requires `investorEmail` on each `userToWhitelist` entry. The Phase 0 “email optional” reading is not present in that schema on 2026-09-03. [whitelist](https://docs.brickken.com/api-reference/endpoint/prepare-whitelist)

**OPEN QUESTION** — Confirm in an authenticated sandbox contract test that standalone whitelist followed by `mintToken` with `needWhitelist: false` prepares exactly one transaction and mints to the already-whitelisted address. Official mint examples still show `needWhitelist: true`; the single-tx shape is documented only as “when no recipient needs whitelisting.” [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken)

## Read-back contract

| Status | Read | Required input | Important response fields | MVP evidence |
| --- | --- | --- | --- | --- |
| VERIFIED | `GET /get-token-info` | Optional `tokenSymbol`; omit to list visible symbols | Asset mode: `uuid`, `name`, `tokenName`, `tokenSymbol`, `tokenType`, `tokenizerEmail`, `companyWalletAddress`, supply fields, payment token and blockchain metadata. This endpoint does not return the deployed token contract address. [Get Token Information](https://docs.brickken.com/api-reference/endpoint/get-token-info) | DECISION — Compare requested name, symbol, type, tokenizer identity, chain, and supply fields that the response actually exposes. |
| VERIFIED | `GET /get-tokenizer-info` | `tokenSymbol` | `companyWalletAddress`, `tokenAddress`, `paymentTokenAddress`, `escrowAddress`, `chainId`, `email`. `tokenAddress` is the deployed contract address. [Get Tokenizer Information](https://docs.brickken.com/api-reference/endpoint/get-tokenizer-info) | DECISION — Require nonzero `tokenAddress`, expected chain, tokenizer wallet, and tokenizer email. |
| VERIFIED | `GET /get-whitelist-status` | `tokenSymbol`, canonical `address`; `investorAddress` is a legacy alias | `isWhitelisted`, checksummed `address`, `tokenSymbol`, `source: "blockchain"`. [Get Whitelist Status](https://docs.brickken.com/api-reference/endpoint/get-whitelist-status) | DECISION — Require the planned investor address and `isWhitelisted === true`. |
| VERIFIED | `GET /get-balance-whitelist` | `tokenSymbol`, `investorEmail` | `walletAddress`, `tokenAddress`, `tokenDecimals`, `tokenBalanceRaw`, formatted `tokenBalance`, `isWhitelisted`, `balanceSource: "blockchain"`; legacy `bknFees` and `senderBalance` are always `"0"`. [Get Balance and Whitelist Status](https://docs.brickken.com/api-reference/endpoint/get-balance-whitelist) | DECISION — Match email-resolved wallet and token address, require whitelist true, and compare mint amount using `tokenBalanceRaw` plus decimals. |

**DECISION** — Verification fails closed on missing fields, address mismatch, chain mismatch, whitelist false, unexpected decimals, or balance mismatch. A failure produces no deployment receipt.

**ASSUMPTION** — For a new demo investor with zero initial balance, the post-mint balance equals the requested mint amount after decimal scaling. If reuse of an existing investor is permitted later, capture a pre-mint balance and verify the delta instead.

## Credits, errors, retry, and idempotency

**VERIFIED** — API-key plans have separate credit balances per write method. Starter, Professional, and Enterprise are documented as 10, 100, and 10,000 initial credits per method. `newTokenization`, `whitelist`, and `mintToken` are metered separately; exhausted calls fail as `Out of credits for <method>`. Per-tier request quotas are not published. [Authentication](https://docs.brickken.com/get-started/authentication)

**VERIFIED** — `POST /prepare-transactions` limits with a key are documented as burst 120, 60/minute, concurrent 500; limit failures return `429` with `Retry-After: 60`. [Authentication](https://docs.brickken.com/get-started/authentication)

**VERIFIED** — The SDK maps validation, authentication, credit exhaustion, unauthorized token symbol, rate limit, network/timeout, RPC rejection, broadcast-confirmation, and on-chain revert failures to typed error classes. It automatically retries `429`, `5xx`, and transport/timeouts with jittered exponential backoff, defaulting to three attempts and 500 ms base delay. [SDK errors](https://docs.brickken.com/sdk/errors)

**DECISION** — Set SDK automatic attempts to one for prepare calls until Brickken documents prepare idempotency. Retry read-only polling with bounded exponential backoff and jitter. Honor `Retry-After` without preparing another operation concurrently.

**DECISION** — Never automatically retry an ambiguous prepare timeout because no client idempotency key is documented. Mark it `RETRYABLE_FAILURE` for operator reconciliation; a manual retry may consume another prepared slot or credit.

**VERIFIED** — Repeating the same `client-broadcast` `{txId, txHash}` confirmation is idempotent. [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)

**DECISION** — Retry only the identical `{txId, txHash}` confirmation after a network/5xx failure. Never pair either identifier with a replacement value.

**DECISION** — Poll `pending` at 2, 3, 5, 8, then 10-second intervals with jitter, stop the active request loop after five minutes, persist `TIMED_OUT`, and allow later polling to resume. This is an Edict policy, not a Brickken guarantee.

**VERIFIED** — `rejected` plus the stored `error` is the Brickken terminal failure signal. [Get Transaction Status](https://docs.brickken.com/api-reference/endpoint/get-transaction-status)

**VERIFIED** — `mintToken` API-key credits are consumed once per mint operation at send time (`Out of credits for minting`). License mint-recipient and invitation counters are separate. [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken)

**OPEN QUESTION** — Brickken does not publish finality depth, typical confirmation latency, prepared-transaction expiry, nonce reservation behavior, or a prepare idempotency key for Dapp methods in the reviewed official sources. When `newTokenization` and `whitelist` credits are decremented (prepare vs send) is also unpublished.

**VERIFIED** — The SDK documents a per-wallet outstanding-prepare quota that returns `429` with `Too many outstanding prepared transactions for this wallet`. [`brickken-sdk@0.2.1` README](https://docs.brickken.com/sdk/introduction)

## Official SDK versus direct REST

**VERIFIED** — `brickken-sdk` is Brickken's official TypeScript client for Dapp, Agentic, and RAMS APIs; it supports Node 20+, browsers, and edge runtimes, has one runtime dependency, typed write results/errors, and defaults writes to prepare-only. [SDK](https://docs.brickken.com/sdk/introduction) [SDK installation](https://docs.brickken.com/sdk/installation)

**VERIFIED** — On 2026-09-03, official npm registry metadata reported `brickken-sdk@0.2.1`, Node `>=20`, types, ESM/CJS exports, optional viem/ethers peer adapters, one runtime dependency, and repository metadata pointing to `github.com/Brickken/brickken-sdk`. [Official npm metadata](https://registry.npmjs.org/brickken-sdk/latest)

**OPEN QUESTION** — The npm-declared GitHub repository returned HTTP `404` during Phase 0 and again on 2026-09-03. It is not listed among the public repositories visible on the official Brickken organization page. Source-level audit and issue tracking remain unavailable. [Brickken GitHub](https://github.com/Brickken) [npm-declared repository](https://github.com/Brickken/brickken-sdk)

**VERIFIED** — SDK namespace mapping covers `tokenization.create` → `newTokenization`, `.whitelist` → `whitelist`, `.mint` → `mintToken`, `.info` → `/get-token-info`, `.tokenizer` → `/get-tokenizer-info`, `.whitelistStatus` → `/get-whitelist-status`, `.balanceAndWhitelist` → `/get-balance-whitelist`, plus raw `tx` prepare/send/status. [SDK namespaces](https://docs.brickken.com/sdk/namespaces)

**VERIFIED** — Browser-wallet signers commonly cannot produce a raw signed transaction; the SDK consequently excludes such signers from its automatic `client-signed` and `client-broadcast` execution. [SDK signers](https://docs.brickken.com/sdk/signers)

| Criterion | Official SDK, server-only | Direct REST, server-only |
| --- | --- | --- |
| Type safety | VERIFIED — Typed methods, shared write result, typed errors; DECISION — supplement with runtime schemas because evolving nested payloads and reads still require validation. [SDK](https://docs.brickken.com/sdk/introduction) | DECISION — All request/response types and error mapping must be maintained locally. |
| Browser-wallet signing | VERIFIED — Automatic execution needs raw transaction signing, which a browser-wallet signer may not expose. [SDK signers](https://docs.brickken.com/sdk/signers) | DECISION — Browser calls its native send method on a normalized prepared transaction and returns `txHash`. |
| Server-only key | DECISION — Safe if the SDK is imported only from server-only modules. | DECISION — Safe if a single server adapter owns all Brickken HTTP calls. |
| Serialization | VERIFIED — The SDK preserves prepared transaction fields for its own signer path. [SDK signers](https://docs.brickken.com/sdk/signers) | DECISION — Edict must normalize quantity fields for the browser provider without dropping any field. |
| Error handling | VERIFIED — Fourteen error classes and documented retry policy. [SDK errors](https://docs.brickken.com/sdk/errors) | DECISION — Must parse inconsistent HTTP status/body formats manually. |
| Testing | VERIFIED — The SDK accepts an injected `fetch`, supporting deterministic transport tests. [SDK](https://docs.brickken.com/sdk/introduction) | DECISION — A small adapter is straightforward to fake, but every behavior is Edict-owned. |
| Implementation speed | DECISION — Faster for prepare, reads, send reconciliation, and errors, with a narrow custom wallet bridge. | DECISION — More wire work and more opportunities to drift. |
| Undocumented behavior | OPEN QUESTION — New package and inaccessible declared source increase supply-chain/change risk; pin and contract-test. | DECISION — Fewer hidden client behaviors, but more exposure to inconsistent docs and response evolution. |

**DECISION** — Brickken access must remain behind an Edict-owned server adapter so application logic does not depend directly on SDK behavior. Use pinned `brickken-sdk@0.2.1` strictly inside this server-only adapter for prepare, read, send reconciliation, and status. Use the vendor-neutral injected EIP-1193 boundary and pinned viem primitives in the browser; no wagmi or wallet-vendor dependency is required. Do not pass the browser wallet into the SDK, and do not call SDK `execute: true`.

**DECISION** — Wrap every SDK response in Edict-owned runtime schemas, persist raw sanitized response snapshots for audit, set `executionMode: "client-broadcast"` explicitly, and keep a single raw REST escape hatch behind the same adapter only if a verified endpoint is missing from the pinned SDK.

## Phase 1 gates and unresolved questions

- **OPEN QUESTION** — A historical credential-bearing network-information request succeeded, but its authentication semantics remain unverified. Brickken approval for the exact tokenizer signer address, active tokenizer licensing, native gas, and write-method credits also remain unverified. Do not place credentials in source control. [Request an API key](https://docs.brickken.com/get-started/request-api-key)
- **OPEN QUESTION** — Ask Brickken to resolve the public `get-network-info` documentation/live `401` conflict.
- **OPEN QUESTION** — Confirm live `userToWhitelist[].whitelistStatus` JSON type if anything other than boolean is still accepted.
- **OPEN QUESTION** — Confirm standalone whitelist followed by mint with `needWhitelist: false` returns a single transaction and mints.
- **OPEN QUESTION** — Confirm the selected browser wallet can broadcast a payload normalised per official browser-wallet guidance, and that Brickken reconciles the resulting hash for a `client-broadcast` prepare.
- **OPEN QUESTION** — Confirm `newTokenization.url` behaviour when omitted, plus the exact nested active-license error fields and prose; Phase 10C retained only the safe top-level envelope and semantic category.
- **OPEN QUESTION** — Confirm whether the accepted `tokenSymbol` lower bound is two or three characters on live sandbox. Current docs say 2–5; Edict V1 still sends 3–5.
- **OPEN QUESTION** — Confirm prepared transaction expiry, finality expectations, per-tier quotas, and whether `newTokenization`/`whitelist` prepare consumes a credit before send.
- **OPEN QUESTION — activation blocker, 2026-09-12** — Establish from an authoritative Brickken registry, deployment record, or reviewed contract artifact the exact Sepolia destination and canonical ABI function signature used by prepared `newTokenization`. The pinned SDK exposes the REST method mapping but not that deployment ABI/registry, and the official response example retained here has placeholder/truncated transaction values. It cannot authorize a live send.
- **OPEN QUESTION** — Confirm whether API-key Dapp transaction-status polling always requires the key, including after client broadcast. Edict will send the key regardless.
- **OPEN QUESTION** — Confirm live unsigned-transaction encoding (string fees vs BigNumber objects) and whether `executionMode: "client-broadcast"` is accepted on Dapp prepare despite its absence from the prepare OpenAPI properties.
- **OPEN QUESTION** — Confirm sandbox acceptance of `needKyc: false` on whitelist/mint despite its absence from the dedicated OpenAPI properties.
