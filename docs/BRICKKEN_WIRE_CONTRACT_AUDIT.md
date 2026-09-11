# Brickken sandbox wire-contract audit

Checked: 2026-09-03. No authenticated Brickken request, write, prepare, sign, or broadcast was made.

This document is the Phase 3 adversarial audit of the Brickken sandbox wire contracts required by Edict's locked MVP:

manifest/form → validation → execution plan → approval → tokenization → transaction tracking → investor whitelist → mint → read-back verification → deployment receipt

It does not change the Phase 2 deterministic core. It does not implement the Brickken adapter.

## 1. Executive conclusion

The support-confirmed Dapp write path is `POST /prepare-transactions` → wallet `eth_sendTransaction` → durable hash → `POST /send-transactions` correlation → `GET /transaction-status` → trusted-RPC finality → token-scoped reads. Edict's locked mode is `client-broadcast`: the server prepares with `x-api-key`; the browser wallet alone broadcasts; the server correlates exactly one `{ txId, txHash }` pair; the server polls.

That path is documented well enough to implement a **prepare-only, fail-closed adapter**, provided Phase 4 treats several official conflicts as runtime variants rather than resolved facts:

1. **Do not hand a prepared transaction to `eth_sendTransaction` unchanged.** Official browser-wallet guidance says prepared payloads are ethers-style, not EIP-1193. Numeric `nonce`/`chainId`/`type`, decimal fee strings, and `gasLimit` will fail injected wallets. [Browser wallets](https://docs.brickken.com/api-reference/guides/browser-wallets)
2. **`client-broadcast` accepts exactly one `txId` and one `txHash`.** Arrays are rejected. The pinned SDK also refuses a multi-transaction `client-broadcast` locally. A `mintToken` that still needs whitelisting returns two transactions and an array `txId`. Edict must keep standalone whitelist, then `needWhitelist: false`, and must refuse any prepare whose `transactions.length !== 1`. [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send) `brickken-sdk@0.2.1` `dist/index.js`
3. **Prepared unsigned-transaction field encodings conflict** between the prepare-page examples (hex/decimal strings) and the send OpenAPI `UnsignedTransaction` schema (`{ type: "BigNumber", hex }`). Runtime schemas must accept both; they must not drop unknown fields. [Prepare Transactions](https://docs.brickken.com/api-reference/endpoint/create) [Send Transactions](https://docs.brickken.com/api-reference/endpoint/send)
4. **Current official pages no longer show several Phase 0 text conflicts**, but live sandbox behaviour is still unproven: `whitelistStatus` is now documented as a JSON boolean; `tokenSymbol` is now documented as 2–5 characters; `url` is now documented as optional in both prepare views. Edict core still validates 3–5-character symbols and a required HTTPS `url`. Those core rules must not be changed in this phase.
5. **Credits, prepare expiry, finality depth, and prepare idempotency are not published** for Dapp API-key writes, except that `mintToken` credits are documented as consumed at send time and that an outstanding-prepare quota can return `429`.

**Phase 4 can implement the adapter. It cannot treat the happy path as proven until an authenticated sandbox contract test resolves the remaining unknowns.**

## 2. Source hierarchy

Classification used below:

| Label | Meaning |
| --- | --- |
| `VERIFIED` | Supported by the cited official URL, official Brickken GitHub repository, official npm metadata, pinned `brickken-sdk@0.2.1` package file, or a recorded unauthenticated live check. |
| `CONFLICT` | Two or more official sources disagree. Both claims are retained. |
| `INFERENCE` | Bounded deduction from official text that is not itself guaranteed. Not an implementation default. |
| `UNKNOWN` | Not published in the inspected official sources. |
| `EDICT_DECISION` | Edict policy. Not a Brickken guarantee. |

### 2.1 Official documentation (`https://docs.brickken.com`)

Accessed 2026-09-03 via `https://docs.brickken.com/llms.txt` and the pages it lists.

| Source | URL | Used for |
| --- | --- | --- |
| Docs index | https://docs.brickken.com/llms.txt | Page inventory |
| Dapp API | https://docs.brickken.com/api-reference/introduction | Base URLs, flow, networks |
| Authentication | https://docs.brickken.com/get-started/authentication | Credentials, credits, scoping, errors |
| Request an API key | https://docs.brickken.com/get-started/request-api-key | Sandbox networks, signer whitelist thread |
| Sandbox | https://docs.brickken.com/get-started/sandbox | `needKyc: false`, identities |
| API Hello World | https://docs.brickken.com/get-started/build-programme/api-hello-world | Direct HTTP tokenize example |
| Prepare Transactions | https://docs.brickken.com/api-reference/endpoint/create | Unified prepare schema |
| newTokenization | https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization | Dedicated write schema |
| whitelist | https://docs.brickken.com/api-reference/endpoint/prepare-whitelist | Dedicated write schema |
| mintToken | https://docs.brickken.com/api-reference/endpoint/prepare-mintToken | Dedicated write schema |
| Send Transactions | https://docs.brickken.com/api-reference/endpoint/send | Execution modes, send shapes |
| Get Transaction Status | https://docs.brickken.com/api-reference/endpoint/get-transaction-status | Polling |
| Get Token Information | https://docs.brickken.com/api-reference/endpoint/get-token-info | Read-back |
| Get Tokenizer Information | https://docs.brickken.com/api-reference/endpoint/get-tokenizer-info | Deployed address |
| Get Whitelist Status | https://docs.brickken.com/api-reference/endpoint/get-whitelist-status | Whitelist read-back |
| Get Balance and Whitelist | https://docs.brickken.com/api-reference/endpoint/get-balance-whitelist | Final read-back |
| Get Network Information | https://docs.brickken.com/api-reference/endpoint/get-network-info | Auth conflict only |
| Browser wallets | https://docs.brickken.com/api-reference/guides/browser-wallets | EIP-1193 contract |
| Troubleshooting | https://docs.brickken.com/api-reference/guides/troubleshooting | Errors, multi-tx order |
| Tokenize and run an STO | https://docs.brickken.com/api-reference/guides/tokenize-and-run-an-sto | Sequential write examples |
| Postman | https://docs.brickken.com/api-reference/postman | Official collection location |
| Docs OpenAPI | https://docs.brickken.com/api-reference/openapi.json | Generated V2 spec |
| Method OpenAPI | https://docs.brickken.com/api-reference/prepare/newTokenization.json https://docs.brickken.com/api-reference/prepare/whitelist.json https://docs.brickken.com/api-reference/prepare/mintToken.json | Method-scoped schemas |
| SDK docs | https://docs.brickken.com/sdk/introduction https://docs.brickken.com/sdk/installation https://docs.brickken.com/sdk/authentication https://docs.brickken.com/sdk/execution-modes https://docs.brickken.com/sdk/signers https://docs.brickken.com/sdk/errors https://docs.brickken.com/sdk/namespaces https://docs.brickken.com/sdk/configuration https://docs.brickken.com/sdk/guides/tokenize-and-run-an-sto | Client mapping |

Out of scope pages (STOs, agentic/x402, RAMS, production) were not used as Dapp write evidence except where they state a cross-cutting auth or send rule that also applies to Dapp `client-broadcast`.

### 2.2 Official SDK documentation and pinned package

| Source | Location | Accessed |
| --- | --- | --- |
| npm metadata | https://registry.npmjs.org/brickken-sdk/0.2.1 | 2026-09-03 |
| Installed package | `node_modules/brickken-sdk@0.2.1` (`package.json`, `README.md`, `dist/index.d.ts`, `dist/index.js`, `dist/chunk-UIR6ERML.js`, `dist/openapi/index.js`) | 2026-09-03 |

npm `0.2.1` reports homepage `https://docs.brickken.com`, repository `git+https://github.com/Brickken/brickken-sdk.git`, Node `>=20`, runtime dependency `micro-eth-signer`, optional peers `ethers` and `viem`, tarball integrity `sha512-WPAQ7QGNfKoh7FLMYfuQV87nsESxRQkS8+LGtUY117JtTjG4Ana7mOjvqSvWxaGVR6dPlkgEKpshqE68xNJzHg==`. **VERIFIED**

### 2.3 Official Postman collection

Downloaded 2026-09-03 from the docs page:

- https://raw.githubusercontent.com/fbrickken/docs/main/downloads/postman/brickken-api.postman_collection.json HTTP 200
- https://raw.githubusercontent.com/fbrickken/docs/main/downloads/postman/brickken-api-sandbox.postman_environment.json HTTP 200

The sandbox environment file has empty `apiKey`. No credential values were present.

### 2.4 Official GitHub

Queried 2026-09-03:

| Target | Result |
| --- | --- |
| `GET https://api.github.com/orgs/Brickken/repos?per_page=100` | Public repos: `license`, `DefiLlama-Adapters`, `ethereum-optimism.github.io`, `protocol-public`, `n8n-node-brickken-api`, `n8n-nodes-brickken-sign`, `brickken-api-cli`. **VERIFIED** |
| `GET https://github.com/Brickken/brickken-sdk` | HTTP 404. Matches Phase 0. **VERIFIED** |
| `fbrickken/docs` Postman files | Reachable raw URLs used above. **VERIFIED** |

Source-level SDK audit remains unavailable.

### 2.5 Unauthenticated live checks this phase

**VERIFIED** — `GET https://api.sandbox.brickken.com/openapi.json` with `Accept: application/json`, no `x-api-key`, 2026-09-03 `19:30:20 GMT`, HTTP 200. Body title `Brickken x402 Agentic API` version `1.0.0`, 25 paths, all `/x402/*`, `/rams` omitted from this snapshot, `/faucet/bkn` present. **No Dapp prepare, correlation, status, or token-read routes were present.** This public document is not the Dapp wire spec.

**VERIFIED** — `GET https://docs.brickken.com/api-reference/openapi.json`, 2026-09-03 `19:30:24 GMT`, HTTP 200. Title `Brickken API V2` version `2.0.0`, 56 paths including every scoped Dapp operation.

Phase 0 unauthenticated `GET /get-network-info?chainId=aa36a7` returning HTTP 401 is retained and was not repeated.

No `.env.local` inspection. No API key used. No write or send call.

## 3. Operation-by-operation contract matrix

Common prepare transport, unless a row says otherwise:

- HTTP `POST https://api.sandbox.brickken.com/prepare-transactions`
- Header `x-api-key` required for Dapp methods
- Header `Content-Type: application/json`
- `executionMode` documented on send/guides as selected at prepare time; **absent** from the unified prepare OpenAPI properties. **CONFLICT** — see §10.

SDK mapping (`brickken-sdk@0.2.1` `dist/chunk-UIR6ERML.js`): Dapp writes post to `/prepare-transactions` with `auth: "api-key"`, `defaultExecutionMode: "client-signed"`, `allowsRelay: false`.

### 3.1 `newTokenization`

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Method / path | `POST /prepare-transactions` with `method: "newTokenization"` | VERIFIED | [newTokenization](https://docs.brickken.com/api-reference/endpoint/prepare-newTokenization) |
| Auth | `x-api-key`. x402 not accepted for Dapp writes. | VERIFIED | [Authentication](https://docs.brickken.com/get-started/authentication) |
| Execution modes | `client-signed` (default), `client-broadcast`. `brickken-relayed` not available for Dapp. | VERIFIED | [Send](https://docs.brickken.com/api-reference/endpoint/send) [SDK execution modes](https://docs.brickken.com/sdk/execution-modes) |
| Required fields | `method`, `chainId`, `signerAddress`, `tokenizerEmail`, `name`, `tokenSymbol` | VERIFIED | dedicated OpenAPI `required` |
| Optional fields | `tokenType` (default `EQUITY`), `supplyCap` (default `"0"` = uncapped), `url` (default empty string), `tokenizerAddress`, `paymentTokenAddress`, `preMints`, `initialHolders` | VERIFIED | dedicated schema |
| Field types | `chainId` string; emails format `email`; `supplyCap` string; `preMints[].amount` string; holder `walletAddress` `^0x[a-fA-F0-9]{40}$` | VERIFIED | dedicated schema |
| `name` vs `tokenName` | Use `name`. `tokenName` is not accepted. | VERIFIED | dedicated page |
| `tokenSymbol` | 2–5 uppercase letters or numbers, unused | VERIFIED | dedicated + unified OpenAPI |
| `tokenType` | Enum includes `RWA_TOKEN` | VERIFIED | dedicated schema |
| Signer | Brickken-whitelisted tokenizer wallet; becomes tokenizer | VERIFIED | dedicated `signerAddress` description |
| Tokenizer email | Existing account with active tokenization license | VERIFIED | dedicated schema |
| Credits | Metered method `newTokenization`. When consumed is **not** stated for this method. | CONFLICT | [Authentication](https://docs.brickken.com/get-started/authentication) vs mint-at-send exception in §10 |
| Prepare response | `{ transactions, txId, info? }`. `txId` is not a chain hash. | VERIFIED | dedicated 200 schema |
| Wait before next write | Poll until `success` before whitelist or mint | VERIFIED | dedicated prerequisites; [Troubleshooting](https://docs.brickken.com/api-reference/guides/troubleshooting) |

Edict omits `preMints`, `initialHolders`, `tokenizerAddress`, `paymentTokenAddress`, gas/nonce overrides. **EDICT_DECISION**

### 3.2 `whitelist`

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Method / path | `POST /prepare-transactions` with `method: "whitelist"` | VERIFIED | [whitelist](https://docs.brickken.com/api-reference/endpoint/prepare-whitelist) |
| Auth | `x-api-key` | VERIFIED | dedicated security `apiKeyAuth` |
| Required fields | `method`, `chainId`, `signerAddress`, `tokenSymbol`, `userToWhitelist` (minItems 1) | VERIFIED | dedicated OpenAPI |
| Per-entry required | `investorAddress`, `investorEmail`, `whitelistStatus` | VERIFIED | dedicated OpenAPI `items.required` |
| `whitelistStatus` type | JSON boolean. `true` whitelist, `false` blacklist. | VERIFIED for current docs | dedicated schema type `boolean`; Postman body `true`; HTTP guide `whitelistStatus: true` |
| String `"true"`/`"false"` | Not present in current official pages, OpenAPI, Postman, or SDK mapper | UNKNOWN as live behaviour; omitted as a fixture | this audit |
| `needKyc` | Prose: optional, default `true`; `false` sandbox-only. OpenAPI schema does **not** declare `needKyc`. | CONFLICT | whitelist prose vs dedicated OpenAPI properties |
| `newInvestor` | Optional profile defaults when creating a missing investor | VERIFIED | dedicated schema |
| Investor record timing | Created during **prepare**, not when mined | VERIFIED | whitelist page |
| Email vs tokenizer | Investor email must not already be a tokenizer account or later reads report `Investor not found` | VERIFIED | whitelist warning |
| Wallet immutability | Existing investor with a different stored wallet is rejected | VERIFIED | whitelist page |
| Signer | Tokenizer wallet | VERIFIED | [Authentication](https://docs.brickken.com/get-started/authentication) |
| Response | `{ transactions, txId, info? }` | VERIFIED | dedicated 200 |

Edict sends exactly one investor. **EDICT_DECISION**

### 3.3 `mintToken`

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Method / path | `POST /prepare-transactions` with `method: "mintToken"` | VERIFIED | [mintToken](https://docs.brickken.com/api-reference/endpoint/prepare-mintToken) |
| Required fields | `method`, `chainId`, `signerAddress`, `tokenSymbol`, `userToMint` (minItems 1) | VERIFIED | dedicated OpenAPI |
| Per-entry required | `investorEmail`, `amount` (positive whole-token string) | VERIFIED | dedicated OpenAPI |
| `investorAddress` | Optional; if omitted API may create/resolve a DFNS wallet | VERIFIED | dedicated schema |
| `needWhitelist` | Boolean; defaults `true` unless explicitly `false` | VERIFIED | dedicated schema |
| Email identity | `investorEmail` must differ from tokenizer email; same wallet allowed for sandbox testing | VERIFIED | mintToken recipient requirements |
| Multi-tx | If a recipient still needs whitelisting: two transactions, whitelist first, `txId` is a matching array. Sign/send **in order**. | VERIFIED | mintToken response shape |
| Single-tx | When no recipient needs whitelisting: one transaction, string `txId` | VERIFIED | mintToken “when no recipient needs whitelisting” |
| Credits | API-key mint credits consumed **once per mint operation at send time** (`Out of credits for minting`). Separate license mint-recipient and invitation counters. | VERIFIED | mintToken Credits |
| Signer | Tokenizer signs mint and any bundled whitelist | VERIFIED | dedicated `signerAddress` description |

Standalone whitelist then `needWhitelist: false` is the documented single-tx shape **when no recipient needs whitelisting**, and `false` is an explicit schema value. A complete official example of that exact sequence is not published. **INFERENCE / OPEN for sandbox proof** — see §10 and §13.

### 3.4 `POST /send-transactions` (`client-broadcast`)

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Path | `POST /send-transactions` | VERIFIED | [Send](https://docs.brickken.com/api-reference/endpoint/send) |
| Auth for Dapp | `x-api-key`. x402 is for agentic methods only. | VERIFIED | Send headers; Authentication Dapp row |
| Mode binding | Send shape must match prepare `executionMode`. Mismatch: `Prepared transaction was not created for … execution`. | VERIFIED | Send “three execution modes” |
| Request | `{ txId: string, txHash: string }`. Exactly one each. Arrays rejected. | VERIFIED | Send parameters + OpenAPI oneOf client-broadcast |
| Mutually exclusive | Send exactly one of `signedTransactions`, `txHash`, `transactions` | VERIFIED | Send IMPORTANT note |
| Idempotency | Resubmitting the identical `txId + txHash` pair is idempotent; changing either identifier is not an authorized retry | SUPPORT-CONFIRMED 2026-09-11 | Brickken Technical Support |
| Client-broadcast success | HTTP 202; `results[0].result` contains matching `transactionHash`, `status: "pending"`, `executionMode: "client-broadcast"` | SUPPORT-CONFIRMED 2026-09-11 | Brickken Technical Support |
| Published schema conflict | The older public example/OpenAPI describes a flat HTTP 200 body; it must not drive the client-broadcast production parser | CONFLICT | Send workflow vs support-confirmed behavior |
| Blockchain effect | Correlation only; Brickken verifies the existing blockchain transaction and does not rebroadcast it | SUPPORT-CONFIRMED 2026-09-11 | Brickken Technical Support |
| Compared fields | Exact `chainId`, `from`, `to`, `data`, `value`, `nonce`; gas fields may vary | SUPPORT-CONFIRMED 2026-09-11 | Brickken Technical Support |
| 400 example | `{ error: { code, message, details } }` e.g. `INVALID_SIGNATURE` | VERIFIED | Send 400 schema |
| SDK send auth descriptor | SDK posts send with `auth: "api-key-or-x402"` | VERIFIED | `dist/index.js` `sendTransactions` |

Postman Send example is **client-signed** (`signedTransactions` + `txId: "tx_abc123def456"`), not `client-broadcast`. **VERIFIED** gap.

### 3.5 `GET /transaction-status`

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Path | `GET /transaction-status` | SUPPORT-CONFIRMED 2026-09-11; pinned SDK path is obsolete | [status](https://docs.brickken.com/api-reference/endpoint/get-transaction-status) |
| Query | At least one of `hash` or `txId`. No body. | VERIFIED | status page |
| `hash` | On-chain hash, `0x` prefix | VERIFIED | status page |
| `txId` | Internal prepare id | VERIFIED | status page |
| Status enum | `pending` \| `success` \| `rejected` | VERIFIED | OpenAPI enum |
| Success example | `{ "status": "success", "transactionHash": "0x…" }` | VERIFIED | status page |
| Rejected example | `{ "status": "rejected", "error": "Transaction failed" }` | VERIFIED | status page |
| Pending | Broadcast but not yet confirmed/mined; do not resubmit. `transactionHash` may be absent until resolved. | VERIFIED | status prose |
| Auth | Endpoint page and OpenAPI: `x-api-key` required. Authentication page: not needed for a **relayed** transaction. SDK auth page: reachable anonymously. SDK descriptor: `api-key-or-x402`. | CONFLICT | §10 |
| Deployed token address | Not in this response. Read `GET /get-tokenizer-info` `tokenAddress` after `success`. | VERIFIED | status page |

SDK `transactionStatus` maps `data.hash ?? data.transactionHash` into `.hash`. **VERIFIED** `dist/index.js`. The official HTTP field is `transactionHash`.

### 3.6 `GET /get-token-info`

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Path | `GET /get-token-info` | VERIFIED | [token-info](https://docs.brickken.com/api-reference/endpoint/get-token-info) |
| Auth | `x-api-key` | VERIFIED | headers + OpenAPI |
| Query | `tokenSymbol` optional. Omit to list symbols/emails for the key. | VERIFIED | token-info |
| Asset mode fields | `uuid`, `name`, `tokenName`, `tokenSymbol`, `tokenType`, `tokenizerEmail`, `companyWalletAddress`, docs/logo refs, `allowedTokenDecimals`, `initialTokenSupply`, `maxTokenSupply`, `paymentToken.{symbol,address,decimals,blockchain}` | VERIFIED | example + schema |
| `tokenType` example | `"equity"` lowercase in the example; prepare enum is uppercase `EQUITY` / `RWA_TOKEN` | CONFLICT | example vs prepare enum |
| Token contract address | **Not** returned | VERIFIED | token-info note |
| SDK type | `tokenization.info({ tokenSymbol: string })` requires the symbol | CONFLICT | REST optional vs `dist/index.d.ts` |

### 3.7 `GET /get-tokenizer-info`

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Path | `GET /get-tokenizer-info` | VERIFIED | [tokenizer-info](https://docs.brickken.com/api-reference/endpoint/get-tokenizer-info) |
| Auth | `x-api-key` | VERIFIED | headers |
| Query | `tokenSymbol` required | VERIFIED | OpenAPI |
| Fields | `companyWalletAddress`, `tokenAddress`, `paymentTokenAddress`, `escrowAddress`, `chainId`, `email` | VERIFIED | example |
| `chainId` example | string `"aa36a7"` | VERIFIED | example |
| `tokenAddress` | Deployed token contract | VERIFIED | page note |

### 3.8 `GET /get-whitelist-status`

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Path | `GET /get-whitelist-status` | VERIFIED | [whitelist-status](https://docs.brickken.com/api-reference/endpoint/get-whitelist-status) |
| Auth | `x-api-key` | VERIFIED | headers |
| Query | `tokenSymbol` required; `address` required; `investorAddress` legacy alias; send either, not both | VERIFIED | OpenAPI |
| Postman | Uses `investorAddress` only | CONFLICT | Postman vs current `address` |
| Response | `{ isWhitelisted: boolean, address, tokenSymbol, source: "blockchain" }` | VERIFIED | example + enum |
| SDK | `whitelistStatus({ tokenSymbol, investorAddress })` | VERIFIED | `dist/index.d.ts`; descriptor params `investorAddress` |

### 3.9 `GET /get-balance-whitelist`

| Topic | Contract | Class | Source |
| --- | --- | --- | --- |
| Path | `GET /get-balance-whitelist` | VERIFIED | [balance-whitelist](https://docs.brickken.com/api-reference/endpoint/get-balance-whitelist) |
| Auth | `x-api-key` | VERIFIED | headers |
| Query | `tokenSymbol`, `investorEmail` required | VERIFIED | OpenAPI |
| Response | `walletAddress`, `tokenAddress`, `tokenDecimals`, `tokenBalanceRaw`, `tokenBalance`, `isWhitelisted`, `balanceSource: "blockchain"`, deprecated `bknFees`/`senderBalance` always `"0"` | VERIFIED | example |
| Failure if tokenizer email | `Investor not found` | VERIFIED | whitelist / troubleshooting |
| Address-only whitelist | Use `/get-whitelist-status` if the wallet is not registered under an email | VERIFIED | balance-whitelist warning |

## 4. Authentication, signer and identity requirements

| Rule | Class | Source |
| --- | --- | --- |
| Dapp writes and the MVP reads require `x-api-key`. x402 is not accepted for the Dapp API. | VERIFIED | [Authentication](https://docs.brickken.com/get-started/authentication) |
| Sandbox base URL `https://api.sandbox.brickken.com`. Separate DB/keys from production. | VERIFIED | Dapp API; Authentication |
| `signerAddress` must be Brickken-whitelisted before prepare accepts it. Same key-request thread. | VERIFIED | Authentication; request-api-key; SDK tokenize guide |
| HTTP tokenize troubleshooting row: “An API key does not require a separately whitelisted signer address” | CONFLICT | [Tokenize guide](https://docs.brickken.com/api-reference/guides/tokenize-and-run-an-sto) vs Authentication |
| Wallet that performs `newTokenization` becomes tokenizer; only tokenizer may later mint or manage whitelist | VERIFIED | Authentication |
| Key scoped to symbols whose tokenizer email matches a `newTokenization` under the same key. Else `Unauthorized token symbol`. Listed as affecting `get-stos`, `get-sto-by-id`, `get-investor-info`, `get-whitelist-status`, `get-allowance`, `get-token-info`. Payment tokens `HAI`, `BKN`, `USDC`, `USDt`, `USDT` exempt. | VERIFIED | Authentication |
| Per-method credit balances. Starter/Professional/Enterprise: 10 / 100 / 10 000 initial credits per method. Exhaustion: `Out of credits for <method>`. Per-tier request quotas unpublished. | VERIFIED | Authentication |
| Prepare rate limits with a key: burst 120, 60/minute, concurrent 500. `429` with `Retry-After: 60`. | VERIFIED | Authentication |
| Outstanding prepared transactions per wallet can `429` with `Too many outstanding prepared transactions for this wallet` | VERIFIED | `brickken-sdk@0.2.1` README |
| Tokenizer and investor **emails** must differ. Same **wallets** allowed for sandbox testing. | VERIFIED | mintToken; tokenize guide |
| Sandbox `needKyc: false` on whitelist/mint/create-kyc-link. Rejected in production. | VERIFIED | [Sandbox](https://docs.brickken.com/get-started/sandbox) |
| Missing-key reporting is not uniform: `401` on some reads, `400` on others | VERIFIED | Authentication table; SDK errors |

Edict uses Sepolia decimal `11155111` in the manifest and plan. **EDICT_DECISION**. REST examples also use `aa36a7` / `0xaa36a7`. See §10.

## 5. Prepared transaction and browser-wallet contract

### 5.1 Prepare response

Required fields: `transactions` array, `txId`. Optional `info` with `tokenizerEmail`, `tokenSymbol`, `investorEmail`. **VERIFIED** prepare 200 schema.

`txId` is Brickken's prepared-batch identifier, not a blockchain hash. **VERIFIED**

`txId` may be a string or, for multi-tx mint, an array of strings in transaction order. **VERIFIED** mintToken OpenAPI `oneOf`. Unified prepare 200 schema types `txId` as string only. **CONFLICT**

### 5.2 Unsigned transaction encodings

**Encoding A — prepare endpoint examples** (newTokenization, whitelist, mintToken, unified prepare, browser-wallets):

```json
{
  "from": "0xfd1cbe1783ca6ed03412be9cdf7b7842f8567f81",
  "to": "0x28d2B01854D0aBec267a3DDcad9163580E6E8604",
  "value": "0x00",
  "nonce": 51,
  "chainId": 11155111,
  "data": "0x095ea7b3...",
  "type": 2,
  "maxPriorityFeePerGas": "1150000",
  "maxFeePerGas": "1209073256",
  "gasLimit": "0xc920"
}
```

Types: `nonce`/`chainId`/`type` numbers; `value`/`gasLimit` hex strings; fees decimal strings without `0x`. **VERIFIED** [Browser wallets](https://docs.brickken.com/api-reference/guides/browser-wallets)

**Encoding B — send OpenAPI `UnsignedTransaction`:** `value`, `gasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas` as `{ "type": "BigNumber", "hex": "0x…" }`. Description: “BigNumber fields are serialised as `{ type, hex }`.” **VERIFIED** https://docs.brickken.com/api-reference/openapi.json component `UnsignedTransaction`

SDK `UnsignedTransactionLike` is deliberately loose and preserves unknown fields. **VERIFIED** `dist/index.d.ts`

Which encoding sandbox actually returns for Dapp `client-broadcast` prepare is **UNKNOWN** until an authenticated prepare is observed. Phase 4 schemas must accept both and must not drop extra keys.

### 5.3 EIP-1193 forwarding

Prepared transactions are **not** EIP-1193 payloads. Passing them to `eth_sendTransaction` fails differently per wallet. **VERIFIED** [Browser wallets](https://docs.brickken.com/api-reference/guides/browser-wallets)

Official normalisation:

- convert numeric/decimal fields to hex
- rename `gasLimit` → `gas`
- omit `nonce`, `chainId`, `type`, and fee fields so the wallet fills them
- `wallet_switchEthereumChain` to `0xaa36a7` first
- send `from` as the connected account
- iterate `transactions`; do not assume length 1

**CONFLICT** with SDK signer guidance to forward `TransactionRequest` **as-is** to `signTransaction` (ethers/viem raw signing), and with Edict's architecture intent to compare and retain prepared fields. Those are different APIs: `signTransaction` vs `eth_sendTransaction`.

Omitting nonce/fees means the broadcast transaction may differ from the prepared nonce/gas. How Brickken reconciles `txHash` against the prepared record in that case is **UNKNOWN**.

**DECISION — Phase 7** — Edict does not adopt the example's omission of nonce, type, or fee fields. Its strict projection preserves every supported prepared signing field and rejects conflicts or unknowns. Only transaction-level `chainId` is omitted: it remains validated and bound into the canonical wallet intent, while Sepolia is enforced as a provider precondition immediately before send. That precondition is not assumed atomic or equivalent across wallets. Production execution remains deny-all until a controlled wallet/version test validates either transaction-level chain acceptance or the active-chain constraint, and until Brickken accepts and reconciles the resulting hash.

### 5.4 Multi-transaction batches

Order is semantically mandatory because transactions carry sequential nonces. Broadcasting only a later item leaves it stranded. **VERIFIED** mintToken warning; browser-wallets; troubleshooting.

`client-broadcast` cannot confirm a batch: exactly one hash. **VERIFIED** Send + SDK validation `client-broadcast execution requires exactly one prepared transaction and txId.`

Phase 4 must fail closed if `transactions.length !== 1` or `txId` is an array.

### 5.5 `executionMode` on prepare

Send docs: prepare with `executionMode: "client-broadcast"` then confirm `{ txId, txHash }`. **VERIFIED**

Unified prepare OpenAPI properties **do not include** `executionMode`. Dedicated method OpenAPI files also omit it. SDK `buildBasePayload` still sends `executionMode` when provided. **CONFLICT** / **INFERENCE** that the live API accepts a field the published prepare schema does not list.

SDK tokenize guide: chain ids accept decimal or `0x`-prefixed hex; **a bare `aa36a7` is rejected** by `normalizeChainId`. **VERIFIED** [SDK tokenize guide](https://docs.brickken.com/sdk/guides/tokenize-and-run-an-sto) `dist/chunk-UIR6ERML.js`

REST docs recommend hex `aa36a7` without `0x` and also show decimal `"11155111"`. **CONFLICT**

## 6. Send and polling state model

```text
prepare (API key)
  → persist txId + exact unsigned transactions
  → wallet eth_sendTransaction (normalised)
  → persist txHash before Brickken correlation
  → POST /send-transactions { txId, txHash }   // correlation; idempotent same pair
  → GET /transaction-status?txId=… and/or hash=…
       pending  → keep polling, never resubmit
       success  → read-back
       rejected → terminal for that tx
```

| State | Meaning | Next |
| --- | --- | --- |
| Prepared, not broadcast | Unsigned txs + `txId` exist | Wallet prompt. Do not prepare again automatically. |
| Broadcast, RPC not verified | Local `txHash` exists | Trusted RPC verifies immutable identity and fee envelope; never resend. |
| RPC verified, correlation pending | Exact pair exists | Correlate or bounded-retry only the identical pair. Temporary not-found stays pending. |
| Correlation HTTP 202 `pending` | Brickken accepted the pair; chain confirmation incomplete | Poll `/transaction-status` and trusted RPC independently. |
| Status `pending` | Broadcast, not mined/confirmed | Poll. Do not resubmit. |
| Status `success` | Brickken terminal success | Read-back. Token address is not in this payload. |
| Status `rejected` | Brickken terminal failure + `error` | Do not issue a receipt. |

Relayed send prose uses `status: "confirmed"` on HTTP 200. That value is **not** in the status enum. **CONFLICT**. It is out of scope for Edict `client-broadcast` except as a parser hazard.

Finality/confirmation depth: **UNKNOWN**. Prose equates `pending` with “not yet mined” / “not yet confirmed”.

Prepared-transaction expiry time: **UNKNOWN**. Outstanding-prepare quota: **VERIFIED** SDK README.

## 7. Read-back contract

Edict verification (architecture / execution plan) compared with documented fields:

| Plan read | Endpoint | Compare |
| --- | --- | --- |
| TOKEN_INFO | `GET /get-token-info?tokenSymbol=` | `name`/`tokenName`/`tokenSymbol`/`tokenType`/`tokenizerEmail`/`companyWalletAddress`/`maxTokenSupply`/`paymentToken.blockchain.chainId`. No `tokenAddress`. |
| TOKENIZER_INFO | `GET /get-tokenizer-info?tokenSymbol=` | Nonzero `tokenAddress`, `chainId`, `companyWalletAddress`, `email` |
| WHITELIST_STATUS | `GET /get-whitelist-status?tokenSymbol=&address=` | `isWhitelisted === true`, address match, `source === "blockchain"` |
| BALANCE_AND_WHITELIST | `GET /get-balance-whitelist?tokenSymbol=&investorEmail=` | resolved `walletAddress`, `tokenAddress`, `isWhitelisted`, `tokenBalanceRaw` + `tokenDecimals`, `balanceSource === "blockchain"` |

`tokenType` case (`equity` vs `RWA_TOKEN`) is a comparison hazard. **CONFLICT**

Tokenizer `chainId` is a hex-like string in the example (`aa36a7`), while Edict plans use decimal `"11155111"`. Phase 4 must normalise before compare. **VERIFIED** example vs **EDICT_DECISION** plan.

List mode of `/get-token-info` (no symbol) is useful immediately after tokenization to confirm the symbol is registered. Hello World uses that mode. **VERIFIED**

## 8. Error taxonomy

Official shapes are not one schema. Branch on class/message, not status alone. **VERIFIED** [SDK errors](https://docs.brickken.com/sdk/errors)

### 8.1 Authentication / entitlement

| Message / status | Class | Source |
| --- | --- | --- |
| `401` `API key is required for this endpoint` | Auth | Authentication; Phase 0 live `{ errors: { messages, status, name } }` |
| `400` `API key is missing from headers.` | Auth | Authentication |
| `401` `API key is required for this method` | Auth | Authentication |
| `Unauthorized token symbol` | Entitlement | Authentication |
| `Out of credits for <method>` | Entitlement | Authentication |
| `Out of credits for minting` | Entitlement | mintToken credits |
| `Mint credit limit exceeded` / `Invitation credit limit exceeded` / `Insufficient license credits: mint, invitation` | Entitlement | mintToken; troubleshooting |
| `429` + `Retry-After: 60` | Rate limit | Authentication |
| `Too many outstanding prepared transactions for this wallet` | Rate limit | SDK README |

### 8.2 Validation / preflight (prepare, no chain)

Prepare walks: request validation → API preflight → on-chain gas estimation. All three return `400` and **do not broadcast**. **VERIFIED** [Troubleshooting](https://docs.brickken.com/api-reference/guides/troubleshooting)

Documented messages include `tokenAmount is required`, `investorEmail cannot be the tokenizer email (index N)`, `No company found with this token symbol`, `Investor <email> is already associated with a different wallet address`, `License for user not found`, `needKyc=false is only available in the sandbox environment`.

Exact JSON envelopes for those strings are **UNKNOWN** except the send `error: { code, message, details }` example and the Phase 0 `{ errors: { messages, status, name } }` 401.

**CONTROLLED OBSERVATION — 2026-09-09** — One authorized `newTokenization` preparation-only request received HTTP 400 `application/json`, 101 bytes. Its sanitized shape was a top-level `errors` object with license/subscription/entitlement semantics and no `txId` or `transactions`. Exact nested values and prose were intentionally not retained. The pinned SDK represented this unrecognized 400 as `ApiError`; Edict now maps only SDK HTTP 400 `ApiError` responses to definite `INVALID_REQUEST`, specializing license/subscription/entitlement semantics to `ENTITLEMENT_REJECTED`. This changes refusal classification only and does not relax any prepared-transaction schema; every other unrecognized status remains fail-closed and ambiguous.

### 8.3 Wallet / RPC / send

| Signal | Class | Source |
| --- | --- | --- |
| Injected wallet generic JS errors | Malformed EIP-1193 payload | Browser wallets |
| MetaMask `4100` | `from` not connected | Browser wallets |
| `INVALID_SIGNATURE` 400 | Wrong signer | Send 400 example |
| `Prepared transaction was not created for … execution` | Mode mismatch | Send |
| SDK `RpcRejectedError` | Node refused `eth_sendRawTransaction` | SDK errors; not used if Edict broadcasts via wallet |
| SDK `BroadcastConfirmationError` | Chain has hash, Brickken confirm failed | SDK errors |
| Simulated revert at prepare (gas estimation) | Chain-state, **not** a broadcast | Troubleshooting |

### 8.4 Status / on-chain after send

| Signal | Class | Source |
| --- | --- | --- |
| `pending` | In flight | Status |
| `rejected` + `error` | Terminal Brickken failure | Status |
| `UserIsNotWhitelisted(address)` selector `0xaafefe9b` | Contract revert | Troubleshooting |

## 9. Retry and ambiguity matrix

This matrix is the Phase 3 contract for later orchestration. It exists to prevent duplicate tokenization, whitelist, or mint after an ambiguous wallet, RPC, or API outcome.

| Outcome | Classification | Action |
| --- | --- | --- |
| Local validation / schema / plan mismatch | Permanent / user-correctable | Do not call Brickken |
| Missing/invalid API key, unauthorized symbol, exhausted credits, production `needKyc: false` | Authentication or entitlement | Do not retry until a human changes credentials/plan |
| Prepare `400` field/business validation | Permanent / user-correctable | Do not retry unchanged if the body is illegal; fix input in a new plan revision |
| Prepare `429` / `5xx` / transport **before** a durable `txId` | Safe to retry unchanged **only if** no `txId` was persisted. Honour `Retry-After`. Do not overlap prepares. | Bounded retry |
| Prepare timeout / connection drop with **no** persisted body | Ambiguous | **Never automatically resubmit.** Mark `RETRYABLE_FAILURE` for operator reconciliation. A second prepare may consume another outstanding slot or credit. No client idempotency key is documented for Dapp methods. |
| Prepare succeeded, `txId` persisted, user rejects wallet | Safe only before any wallet broadcast | Keep `txId`. Do not prepare again automatically. |
| Wallet prompt still open / unknown whether the user confirmed | Ambiguous | **Never automatically resubmit.** Do not prepare a replacement. |
| Wallet returned `txHash` | Safe only to poll / confirm | Persist hash. Confirm `{txId,txHash}`. Never prepare, sign, or broadcast a replacement. |
| `eth_sendTransaction` RPC error with **no** hash | Safe only before any wallet broadcast **if** it is certain no hash exists. Many wallet errors are not that certain. | Treat as ambiguous unless the wallet explicitly reports user rejection with no hash |
| Brickken send transport/`5xx` after a persisted hash | Safe to retry **identical** `{txId,txHash}` only | Idempotent confirm |
| Brickken send `400` “broadcast transaction not found on the prepared chain” | Safe to retry identical confirm (propagation) | SDK documents this gap |
| Brickken send 400 signature/mode/shape | Permanent / user-correctable or FAILED | Do not broadcast a second transaction |
| Status `pending` | Safe only to poll | Never resubmit |
| Local poll timeout | Safe only to poll later | `TIMED_OUT`, nonterminal. Resume same ids. |
| Status `success` | Terminal success for that write | Read-back. Never resend. |
| Status `rejected` | Permanent for that transaction | No receipt. No automatic replacement. |
| Multi-tx prepare under `client-broadcast` | Permanent for this mode | Refuse. Do not sign a subset. |
| Read `401`/`400` missing key | Authentication | Fix server config |
| Read `Unauthorized token symbol` / `Investor not found` / whitelist false / balance mismatch | Permanent / verification failure | Fail closed |
| Read transport/`5xx`/`429` | Safe to retry unchanged (read-only) | Bounded backoff |

**Never automatically resubmit** after any of: persisted `txHash`; ambiguous prepare timeout; ambiguous wallet result; `BroadcastConfirmationError`; `pending`; `success`; `rejected`.

SDK default retry (3 attempts, 500 ms, jitter) applies to `429`, `5xx`, and transport. **EDICT_DECISION** — set prepare attempts to **one** until prepare idempotency is documented. Confirm-send of an existing pair may retry. Reads may retry.

## 10. Conflict register

| ID | Topic | Claim A | Claim B | Audit disposition |
| --- | --- | --- | --- | --- |
| C1 | `whitelistStatus` type | Current dedicated OpenAPI, Postman, HTTP/SDK guides: JSON boolean | Phase 0 recorded dedicated-page strings `"true"`/`"false"`. That string schema is **not** in current official sources inspected 2026-09-03. | Keep runtime open until sandbox observe. Do not coerce. No string fixture. |
| C2 | Symbol length | Current dedicated + unified OpenAPI + Hello World: 2–5 uppercase alphanumeric | Phase 0 recorded unified prepare 3–5. That 3–5 sentence is **not** in current official sources. | Edict core remains `[A-Z0-9]{3,5}`. **EDICT_DECISION**. Do not change core. |
| C3 | `url` required? | Current dedicated + unified: optional, default empty string | Phase 0 recorded unified summary as required. Not found in current unified schema. | Edict still requires HTTPS documentation URL. **EDICT_DECISION**. |
| C4 | `chainId` request form | REST: decimal or hex; examples `aa36a7`, `11155111`, table `0xaa36a7` | SDK `normalizeChainId` accepts decimal or `0x` hex; **rejects bare `aa36a7`** | If Phase 4 uses the SDK mapper, send decimal `"11155111"` or `"0xaa36a7"`, not bare `aa36a7`. |
| C5 | Prepared `chainId` | Integer `11155111` in unsigned txs | Tokenizer-info example string `"aa36a7"` | Normalise before compare. |
| C6 | Hash field names | Send body/response `txHash`; status query `hash`; status body `transactionHash`; prepare `txId`; SDK `.hash` from `hash ?? transactionHash` | Four names for two concepts (internal id vs chain hash) | Persist both. Never treat `txId` as a chain hash. |
| C7 | Status polling auth | Status OpenAPI/page: API key required | Authentication: relayed status needs no key. SDK auth: status and network-info reachable anonymously. SDK descriptor `api-key-or-x402`. | Edict always sends the server key. Do not build an anonymous poller. |
| C8 | Status values | Enum `pending`/`success`/`rejected` | Relayed send prose `confirmed` on HTTP 200 | Parser must not assume `confirmed` for Dapp. |
| C9 | Send HTTP 200 vs 202 | OpenAPI send: 200 only. Client-broadcast example 200 pending. | Relayed: 200 confirmed or 202 pending | Treat 202 as undocumented for `client-broadcast`; if observed, poll, do not resubmit. |
| C10 | Unsigned tx encoding | Prepare examples: string hex/decimal fees | Send `UnsignedTransaction`: BigNumber objects | Accept both. |
| C11 | EIP-1193 passthrough | Browser-wallets: **must not** forward unchanged; omit nonce/fees | SDK signers: forward as-is to `signTransaction` | Different APIs. Edict browser path follows browser-wallets. |
| C12 | `executionMode` on prepare | Send/guides require `client-broadcast` at prepare | Unified/dedicated prepare OpenAPI omit the property | Send it anyway via SDK/body; contract-test live accept. |
| C13 | `needKyc` on whitelist/mint | Prose + sandbox guide | Dedicated OpenAPI properties omit `needKyc` | Include `needKyc: false` for sandbox; expect either accept or 400. |
| C14 | Whitelist `investorEmail` | Current OpenAPI required | Phase 0 said optional | Send the email. Core already has it. |
| C15 | Signer whitelist | Authentication/SDK: required | HTTP tokenize troubleshooting: key does not require a separately whitelisted signer | Gate demo on Brickken-approved signer anyway. |
| C16 | `get-network-info` public? | Authentication + SDK install: public 200 | Endpoint OpenAPI requires key. Phase 0 live 401. SDK descriptor `api-key-or-x402`. | Not an MVP read. Do not use as unauthenticated health. |
| C17 | Credit consume time | mintToken: at **send**. SDK README: prepare is free (x402/agentic framing). x402 client-broadcast: half at prepare, half at send. | newTokenization/whitelist consume time unpublished | Assume a second prepare can cost; never auto-prepare. |
| C18 | Credit message | `Out of credits for <method>` | `Out of credits for minting` | Match both. |
| C19 | `txId` format | Docs examples `0x` + 64 hex | Postman `tx_abc123def456` | Treat as opaque string. |
| C20 | Multi-tx `client-broadcast` one-by-one | Send: exactly one pair; arrays rejected | mintToken can return two txs | Unsupported. Keep Edict split flow. |
| C21 | Standalone whitelist then `needWhitelist: false` | Schema allows `false`; single-tx when none need whitelisting | Guides’ mint examples use `needWhitelist: true` and say that collapses whitelist | Implement Edict split; prove in sandbox. |
| C22 | `tokenType` case | Prepare enum `RWA_TOKEN` | Token-info example `"equity"` | Case-insensitive compare or fail closed on unknown. |
| C23 | Whitelist-status query name | Docs `address` | Postman `investorAddress` | Send `address`; SDK currently sends `investorAddress`. |
| C24 | Token-info list vs SDK | REST symbol optional | SDK `info({ tokenSymbol: string })` required | Adapter may need raw REST/query omit for list mode. |
| C25 | Prepare 200 `txId` type | Unified schema string | mintToken schema string \| string[] | Accept both; Edict requires string. |

## 11. Test-vector inventory

Stored under `src/server/brickken/test-vectors/`. Provenance is in `index.json`. Fixtures contain only official or minimally normalised example.com / obvious `0x1111…` identities. No API keys.

| File | Kind | Provenance | Confidence | Conflicts |
| --- | --- | --- | --- | --- |
| `prepare/newTokenization.request.json` | Prepare request | Minimally normalised from dedicated newTokenization example + Hello World `RWA_TOKEN` | VERIFIED shape | C2, C3, C4, C12 |
| `prepare/newTokenization.response.json` | Prepare response | Minimally normalised from dedicated 200 property examples (encoding A) | VERIFIED example, not a live prepare | C10, C19 |
| `prepare/whitelist.request.json` | Prepare request | Copied structure from dedicated OpenAPI example | VERIFIED | C1, C13, C14 |
| `prepare/whitelist.response.json` | Prepare response | Same encoding A example as other prepares | VERIFIED example | C10 |
| `prepare/mintToken.request.json` | Official mint example (`needWhitelist: true`) | Dedicated OpenAPI example | VERIFIED | C21 |
| `prepare/mintToken.request.needWhitelist-false.json` | Edict-shaped mint request | Constructed from dedicated schema (`needWhitelist` explicitly false) | INFERENCE | C21 |
| `prepare/mintToken.response.single.json` | Single-tx mint response | Encoding A + mintToken single-tx prose (`txId` string) | INFERENCE combination | C10, C20 |
| `send/client-broadcast.request.json` | Send request | Copied from Send client-broadcast example | VERIFIED | C6, C19 |
| `send/pending.response.json` | Send 200 | Copied from Send success example | VERIFIED | C8, C9 |
| `status/success.response.json` | Status 200 | Copied from status page | VERIFIED | C6 |
| `status/rejected.response.json` | Status 200 rejected | Copied from status page | VERIFIED | — |
| `status/pending.response.json` | Status pending | Minimally constructed from schema enum + prose that `transactionHash` may be absent | INFERENCE | C8 |
| `reads/token-info.asset.response.json` | Token info | Copied from token-info Mode 2 example; emails/addresses already example.com / `0x1111` | VERIFIED | C22 |
| `reads/token-info.list.response.json` | Token list | Copied from Mode 1 example | VERIFIED | C24 |
| `reads/tokenizer-info.response.json` | Tokenizer info | Copied from tokenizer-info example (zero-padded test addresses) | VERIFIED | C5 |
| `reads/whitelist-status.boolean.response.json` | Whitelist status | Copied from whitelist-status example | VERIFIED | C23 |
| `reads/balance-whitelist.response.json` | Balance+whitelist | Copied from balance-whitelist example | VERIFIED | — |
| `errors/unauthorized-endpoint.401.json` | Auth error | Phase 0 live unauthenticated body | VERIFIED live 2026-09-03 | envelope vs send `error` object |
| `errors/send-invalid-signature.400.json` | Send 400 | Copied from Send error example | VERIFIED | — |
| `errors/out-of-credits.message.json` | Credit message | Authentication wording | VERIFIED string, envelope UNKNOWN | C18 |
| `errors/unauthorized-token-symbol.message.json` | Scoping message | Authentication wording | VERIFIED string, envelope UNKNOWN | — |

**Omitted (insufficient official success body):**

- String `whitelistStatus` request/response (no current official example)
- HTTP 202 send body for `client-broadcast` (not documented)
- Send body with `status: "confirmed"` for Dapp (relayed-only prose)
- Live prepare/send/status payloads (no authenticated call)
- `needKyc` field in OpenAPI-copied whitelist request (not in schema)

## 12. Confirmed facts usable for implementation

1. Sandbox host is `https://api.sandbox.brickken.com`. Production is out of scope.
2. Dapp writes: `POST /prepare-transactions` with `method` `newTokenization` | `whitelist` | `mintToken`.
3. Dapp reads used by MVP: `GET /get-token-info`, `/get-tokenizer-info`, `/get-whitelist-status`, `/get-balance-whitelist`, `/transaction-status`.
4. Dapp methods require `x-api-key`. Do not send x402. Do not use `brickken-relayed`.
5. Pin `brickken-sdk@0.2.1` behind `server-only`. Namespaces: `tokenization.create/whitelist/mint/info/tokenizer/whitelistStatus/balanceAndWhitelist`, `tx.prepare/send/status`.
6. Set `executionMode: "client-broadcast"` and `execute: false`. Do not pass a browser wallet into the SDK. Do not set SDK `rpcUrl` for the Edict wallet path.
7. Required tokenizer signer is the connected Brickken-approved wallet. Persist only public addresses, prepared metadata, `txId`, and hashes.
8. `newTokenization` required: `chainId`, `signerAddress`, `tokenizerEmail`, `name`, `tokenSymbol`. Use `name` not `tokenName`. `tokenType: "RWA_TOKEN"` is a documented enum value.
9. `whitelist` required per entry: `investorAddress`, `investorEmail`, `whitelistStatus` boolean `true`.
10. `mintToken` required per entry: `investorEmail`, `amount`. Edict also sends `investorAddress` and `needWhitelist: false` after standalone whitelist success.
11. Investor email ≠ tokenizer email. Wallets may match.
12. `txId` is internal. `txHash` / `transactionHash` / query `hash` are chain hashes.
13. Confirm with `{ txId, txHash }` only. Same pair is idempotent.
14. Poll `pending`; never resubmit. `success` then read-back. `rejected` is terminal.
15. Token contract address comes from `/get-tokenizer-info` `tokenAddress`, not status or token-info.
16. `/get-whitelist-status` `isWhitelisted` is a boolean in current docs; `source` is `"blockchain"`.
17. Compare mint using `tokenBalanceRaw` and `tokenDecimals`, not `tokenBalance` float.
18. Browser path must normalise to EIP-1193 per official browser-wallets page.
19. If prepare returns more than one transaction, refuse `client-broadcast`.
20. SDK retries 429/5xx/transport by default; Edict must disable automatic prepare retries.
21. Injected `fetch` is supported for contract tests.

## 13. Unknowns requiring authenticated sandbox evidence

Do not resolve these by guesswork. They remain gates for the authorized contract test (MVP task 11):

1. Live `whitelistStatus` wire type if anything other than boolean is still accepted.
2. Whether a 2-character symbol prepares successfully (Edict will not send one).
3. Whether omitting `url` prepares; whether a documentation URL is stored/read back.
4. Whether `executionMode: "client-broadcast"` is accepted on Dapp prepare despite OpenAPI omission.
5. Actual unsigned-transaction JSON encoding returned by sandbox prepare.
6. Whether Brickken confirm accepts a wallet-broadcast hash when nonce/gas were omitted per browser-wallets guidance.
7. Whether `needKyc: false` on whitelist/mint is accepted on the sandbox key in use.
8. Whether standalone whitelist (with investor email) then `mintToken` `needWhitelist: false` prepares **one** transaction and mints to the already-whitelisted address.
9. Whether `/transaction-status` for a Dapp `client-broadcast` tx requires the key (Edict will send it regardless).
10. When `newTokenization` and `whitelist` credits are decremented (prepare vs send).
11. Prepared-tx expiry and outstanding-prepare numeric cap.
12. Finality: is `success` 1-block mined or deeper?
13. Exact JSON envelope for `Out of credits for …`, `Unauthorized token symbol`, and license-credit errors.
14. `tokenType`/`name`/`tokenName`/`maxTokenSupply` exact observed values for an `RWA_TOKEN` with a supply cap.
15. Whether `GET /get-whitelist-status` accepts `address`, `investorAddress`, or both on live sandbox.
16. Confirm HTTP status for `client-broadcast` send (`200` vs unexpected `202`).
17. Signer-whitelist enforcement vs the tokenize-guide troubleshooting sentence.
18. Behaviour if tokenizer and investor wallets are identical (documented allowed; untested).

## 14. Recommendation for the smallest safe Phase 4 adapter

Implement only the Edict-owned server adapter (`brickken.server`) around pinned `brickken-sdk@0.2.1`, with injected `fetch` and Zod (or equivalent) **runtime** schemas. Do not implement UI, wallet code, receipts, or core-domain changes.

Minimum adapter:

1. Allowlist `baseUrl === https://api.sandbox.brickken.com`. Read `BRICKKEN_API_KEY` only in `server-only` code. Never log it.
2. Prepare with `executionMode: "client-broadcast"`, `execute: false`, `retry.attempts: 1`.
3. Map methods explicitly: `newTokenization`, `whitelist`, `mintToken`.
4. Send `chainId` as decimal string `"11155111"` so the SDK mapper does not reject it.
5. Whitelist body: one entry, boolean `whitelistStatus: true`, `investorEmail`, `investorAddress`, and sandbox `needKyc: false`.
6. Mint body: one entry, `needWhitelist: false`, distinct email, planned address and amount.
7. Validate prepare: `txId` is a non-empty string (not array); `transactions.length === 1`; `from` matches planned tokenizer; numeric `chainId` is Sepolia; persist the raw sanitized body before returning anything to the browser.
8. Accept both unsigned-tx encodings; preserve unknown keys for diagnostics; project a normalised view for the browser (`to`, `data`, `value`, `gas` hex) without claiming that view is what Brickken hashed.
9. `send` only `{ txId, txHash }` after the hash is persisted. Retry only that pair.
10. Poll `GET /transaction-status` with the API key and at least `txId`; accept `transactionHash` or `hash` if present; persist `pending`/`success`/`rejected` only.
11. Reads through SDK or raw GET with runtime schemas copied from §7. Fail closed on missing fields. Compare addresses case-insensitively; compare quantities as integers.
12. Contract-test against the sourced vectors with injected fetch. Do not call the live API in CI.

Do not: `execute: true`, SDK `rpcUrl` broadcast, `client-signed` in MVP, private-key adapters, production URL, STOs, x402, or automatic prepare/broadcast replay.

Persistence (MVP Task 4) should land with or immediately before this adapter so `txId` and `txHash` can be stored before any wallet prompt. The locked plan still sequences Task 4 then Task 5; this audit does not reorder that dependency.
