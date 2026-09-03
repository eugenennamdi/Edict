# Brickken integration specification

Checked: 2026-09-03 (Africa/Lagos; live response timestamp 2026-09-03 17:47:30 GMT)

## Claim labels

- **VERIFIED** — Supported directly by the adjacent official Brickken documentation, official Brickken repository, official npm metadata, or the recorded safe live check.
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

**DECISION** — Until resolved, Edict's readiness check reports the host as reachable but the public network-info contract as incompatible. No authenticated fallback was attempted in Phase 0.

## Transaction lifecycle

**VERIFIED** — Dapp writes follow `prepare → sign → send → poll`: prepare with `POST /prepare-transactions`, sign every returned transaction with the wallet matching `signerAddress`, send, then poll `GET /get-transaction-status`. [Dapp API](https://docs.brickken.com/api-reference/introduction)

**VERIFIED** — The API exposes three execution modes. For `client-broadcast`, the user signs and broadcasts, then the client confirms exactly one `{ txId, txHash }` pair to Brickken; this mode works for Dapp methods. Resubmitting the same pair is idempotent. [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)

**DECISION** — Edict uses `client-broadcast` for all three on-chain operations. The server prepares with the API key; the browser wallet signs and broadcasts; the server reconciles the returned hash with Brickken; the server then polls status.

**VERIFIED** — A prepared response contains `transactions` (unsigned transaction objects), `txId` (Brickken's internal prepared-batch identifier, not a blockchain hash), and optional `info`. [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create)

**VERIFIED** — Prepared transaction fields shown by Brickken include `from`, `to`, `value`, `nonce`, numeric `chainId`, `data`, `type`, `maxPriorityFeePerGas`, `maxFeePerGas`, and `gasLimit`. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**VERIFIED** — `POST /send-transactions` in `client-broadcast` mode accepts exactly one string `txId` and one string `txHash`; arrays are rejected for this mode. A successful submission returns a transaction hash and status, commonly `pending`. [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)

**VERIFIED** — `GET /get-transaction-status` requires at least one of `txId` or `hash`, accepts no request body, and returns `status` as `pending`, `success`, or `rejected`; `transactionHash` appears when known and `error` appears on failure. [Get Transaction Status](https://docs.brickken.com/api-reference/endpoint/get-transaction-status)

**VERIFIED** — A `pending` status means broadcast but not yet confirmed and must be polled rather than resubmitted. [Get Transaction Status](https://docs.brickken.com/api-reference/endpoint/get-transaction-status)

**DECISION** — Persist the prepare response before exposing the wallet action; persist `txHash` immediately after the wallet returns it and before calling `/send-transactions`; persist every poll result.

**DECISION** — A local polling timeout changes the operation to `TIMED_OUT`, not failed. Resume polling the same `txId`/`txHash` after refresh or operator action; never create a replacement automatically.

## MVP write contract

### `newTokenization`

**VERIFIED** — Prepare with `POST /prepare-transactions` and `method: "newTokenization"`. Required fields on the current dedicated page are `method`, `chainId`, `signerAddress`, `tokenizerEmail`, `name`, and `tokenSymbol`. `tokenType`, `supplyCap`, `url`, `tokenizerAddress`, `paymentTokenAddress`, `preMints`, and `initialHolders` are optional. `name`, not `tokenName`, is accepted. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**VERIFIED** — The current dedicated page says `tokenSymbol` must be 2–5 uppercase letters or numbers and unused; `tokenType` defaults to `EQUITY`; `tokenizerEmail` must identify an existing account with an active tokenization license. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**OPEN QUESTION** — The unified prepare page says a token symbol is 3–5 characters while the dedicated page says 2–5. The MVP validates 3–5 uppercase letters or numbers until an authenticated sandbox contract test resolves the lower bound. [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create) [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**VERIFIED** — If `preMints` is supplied, `initialHolders` must also be supplied at the same length; each holder may use `walletAddress` or an email resolvable to a DFNS wallet. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**DECISION** — The MVP omits `preMints`, `initialHolders`, `tokenizerAddress`, `paymentTokenAddress`, private RPC overrides, gas overrides, and nonce overrides. It provides an HTTPS documentation `url` even though the current dedicated schema calls it optional.

**OPEN QUESTION** — Official descriptions disagree on whether `url` is required: the unified prepare summary calls it required, while the current dedicated endpoint schema calls it optional. Edict supplies it and validates it as required until an authenticated sandbox contract test confirms behavior. [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create) [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**VERIFIED** — Wait for tokenization `success` before using the symbol for whitelist or mint. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

**VERIFIED** — The tokenizer wallet (`signerAddress`) signs this deployment. It must be Brickken-approved and funded with Sepolia native gas. [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization)

### `whitelist`

**VERIFIED** — Prepare with `POST /prepare-transactions` and `method: "whitelist"`. Required fields are `method`, `chainId`, `signerAddress`, `tokenSymbol`, and `userToWhitelist`; each entry contains `investorAddress` and `whitelistStatus`, with investor email optional. The response contains `transactions` and `txId`. [whitelist](https://docs.brickken.com/api-reference/endpoint/prepare-whitelist)

**VERIFIED** — The tokenizer wallet signs whitelist management. [Authentication](https://docs.brickken.com/get-started/authentication)

**OPEN QUESTION** — Official schemas conflict on `whitelistStatus`: the dedicated endpoint documents strings (`"true"`/`"false"`), while the unified prepare example uses a JSON boolean. Resolve with an authenticated sandbox contract test before implementation; do not coerce silently. [whitelist](https://docs.brickken.com/api-reference/endpoint/prepare-whitelist) [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create)

**DECISION** — The approved plan contains a standalone whitelist operation before mint. After it reaches `success`, Edict calls `GET /get-whitelist-status` and requires `isWhitelisted === true` before preparing mint.

**DECISION** — The MVP sends exactly one investor per whitelist operation even though the endpoint accepts an array.

### `mintToken`

**VERIFIED** — Prepare with `POST /prepare-transactions` and `method: "mintToken"`. Required fields are `method`, `chainId`, `signerAddress`, `tokenSymbol`, and a non-empty `userToMint`. Each recipient needs `investorEmail`, `investorAddress`, a positive whole-token string `amount`, and boolean `needWhitelist`. [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken)

**VERIFIED** — `investorEmail` must differ from `tokenizerEmail`, even if sandbox testing uses the same wallet. `needWhitelist` controls whether the mint also whitelists; it does not remove the separate identity requirement. [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken)

**VERIFIED** — The tokenizer wallet signs the mint and any whitelist bundled into it. [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken)

**DECISION** — Because the locked MVP requires an explicit whitelist stage, set `needWhitelist: false` only after standalone whitelist read-back succeeds. This avoids hiding a second state change inside mint and yields distinct approval, transaction, and verification evidence.

**OPEN QUESTION** — Confirm in an authenticated sandbox contract test that `needWhitelist: false` succeeds for a previously whitelisted address and that a standalone whitelist does not require a registered investor email in the selected flow.

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

**OPEN QUESTION** — Brickken does not publish finality depth, typical confirmation latency, prepared-transaction expiry, nonce reservation behavior, or a prepare idempotency key for Dapp methods in the reviewed official sources.

## Official SDK versus direct REST

**VERIFIED** — `brickken-sdk` is Brickken's official TypeScript client for Dapp, Agentic, and RAMS APIs; it supports Node 20+, browsers, and edge runtimes, has one runtime dependency, typed write results/errors, and defaults writes to prepare-only. [SDK](https://docs.brickken.com/sdk/introduction) [SDK installation](https://docs.brickken.com/sdk/installation)

**VERIFIED** — On 2026-09-03, official npm registry metadata reported `brickken-sdk@0.2.1`, Node `>=20`, types, ESM/CJS exports, optional viem/ethers peer adapters, one runtime dependency, and repository metadata pointing to `github.com/Brickken/brickken-sdk`. [Official npm metadata](https://registry.npmjs.org/brickken-sdk/latest)

**OPEN QUESTION** — The npm-declared GitHub repository returned HTTP `404` during Phase 0 and was not listed among the public repositories visible on the official Brickken organization page. Source-level audit and issue tracking are therefore unavailable until Brickken makes the repository public or corrects the metadata. [Brickken GitHub](https://github.com/Brickken) [npm-declared repository](https://github.com/Brickken/brickken-sdk)

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

**DECISION** — Use pinned `brickken-sdk@0.2.1` in server-only code for prepare, read, send reconciliation, and status. Use viem/wagmi only in the browser to request wallet signing and broadcasting of the prepared transaction. Do not pass the browser wallet into the SDK, and do not call SDK `execute: true`.

**DECISION** — Wrap every SDK response in Edict-owned runtime schemas, persist raw sanitized response snapshots for audit, set `executionMode: "client-broadcast"` explicitly, and keep a single raw REST escape hatch behind the same adapter only if a verified endpoint is missing from the pinned SDK.

## Phase 1 gates and unresolved questions

- **OPEN QUESTION** — Obtain a sandbox API key and Brickken approval for the exact tokenizer signer address through the official request process; do not place either in source control. [Request an API key](https://docs.brickken.com/get-started/request-api-key)
- **OPEN QUESTION** — Ask Brickken to resolve the public `get-network-info` documentation/live `401` conflict.
- **OPEN QUESTION** — Confirm the JSON type of `userToWhitelist[].whitelistStatus`.
- **OPEN QUESTION** — Confirm standalone whitelist followed by mint with `needWhitelist: false`.
- **OPEN QUESTION** — Confirm browser-wallet compatibility with each prepared EIP-1559 field and the `client-broadcast` reconciliation path.
- **OPEN QUESTION** — Confirm `newTokenization.url` requiredness and the exact active-license failure shape.
- **OPEN QUESTION** — Confirm whether the accepted `tokenSymbol` lower bound is two or three characters.
- **OPEN QUESTION** — Confirm prepared transaction expiry, finality expectations, per-tier quotas, and whether prepare consumes a credit before send.
- **OPEN QUESTION** — Confirm whether API-key Dapp transaction-status polling always requires the key, including after client broadcast.
