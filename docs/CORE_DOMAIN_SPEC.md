# Edict core domain specification

## Scope and ownership

**DECISION** — This document owns Edict's Phase 2 manifest, normalization, canonical JSON, hashing, execution-plan, immutability, and domain-error contracts. The core performs no network, persistence, wallet, approval, receipt, or Brickken SDK work.

## Asset Manifest V1

```ts
{
  schemaVersion: "1.0";
  environment: "sandbox";
  chainId: "11155111";
  tokenizer: {
    email: string;
    walletAddress: string;
  };
  asset: {
    name: string;
    symbol: string;
    tokenType: "RWA_TOKEN";
    supplyCap: string;
    documentationUrl: string;
  };
  investor: {
    email: string;
    walletAddress: string;
    mintAmount: string;
  };
}
```

**DECISION** — Zod `4.5.4` is the runtime source of truth. All object schemas are strict, including nested objects. Unknown fields are errors and are never silently stripped.

**DECISION** — Untrusted input has type `unknown`. `validateAssetManifestV1()` is the only public route to `NormalizedAssetManifestV1`. That type is branded, deeply readonly, runtime-frozen, and registered as a validated in-memory instance. There is no unchecked constructor. Hashing and plan construction reject a cast or reconstructed object that did not cross the validation boundary.

**DECISION** — Successful validation constructs an entirely new object. No object or array reference supplied by the caller is retained.

## Normalization and validation

Normalization is deterministic and occurs before hashing:

1. Require exact structural literals: schema version `1.0`, environment `sandbox`, decimal chain ID `11155111`, and token type `RWA_TOKEN`.
2. Normalize human-readable strings to Unicode NFC.
3. Trim asset name, emails, symbol, wallet addresses, and documentation URL.
4. Collapse every whitespace run inside the asset name to one ASCII space.
5. Lowercase both emails.
6. Uppercase the token symbol.
7. Lowercase both wallet addresses. **DECISION** — Lowercasing wallet addresses is an Edict V1 normalization policy; checksum casing is not retained in the normalized manifest.
8. Strip leading zeros from valid decimal quantity strings.
9. Parse the documentation URL with the platform `URL` implementation and retain its canonical `.href`.

**DECISION** — Asset names must contain 1–120 Unicode code points after normalization. The 120-code-point maximum is an Edict policy, not a verified Brickken limit.

**DECISION** — Symbols must match `[A-Z0-9]{3,5}` after normalization. This is the strict intersection used while Brickken's documented two-versus-three-character lower-bound conflict remains open.

**DECISION** — Emails must be syntactically valid and must differ after normalization. Tokenizer and investor wallet addresses may be the same.

**DECISION** — Wallet addresses must match `0x` followed by 40 hexadecimal characters. Quantities must be positive ASCII whole-token decimal strings. Signs, fractions, exponent notation, commas, whitespace, non-ASCII digits, zero, and JavaScript number inputs are rejected. `BigInt` is used only for the `mintAmount <= supplyCap` comparison and is never serialized.

**DECISION** — The documentation URL must be absolute HTTPS and contain no username or password. Query parameters retain platform-parser order; Edict V1 does not reorder them and does not attempt speculative secret-query detection.

## Validation errors

Expected validation failures do not throw. They return:

```ts
{
  ok: false,
  errors: readonly {
    code: ManifestValidationErrorCode;
    path: string;
    message: string;
  }[];
}
```

**DECISION** — Paths use stable dot/bracket notation and `$` for the root. Unknown keys expand into one error per key. Errors sort by path, then code, then message using direct code-unit comparison. Public errors never contain Zod issues, inspected values, stacks, secrets, or arbitrary input objects.

## Edict Canonical JSON V1

**DECISION** — This is an Edict-owned format and is not claimed to implement RFC 8785.

The serializer:

- emits compact JSON encoded as UTF-8 for hashing;
- sorts plain-object keys recursively by ECMAScript UTF-16 code-unit order;
- preserves array order;
- uses JSON string escaping;
- supports null, booleans, strings, and finite safe integers; and
- serializes negative zero as `0`.

It rejects undefined, bigint, functions, symbols, non-finite or unsafe numbers, fractions, sparse arrays, cycles, dates, maps, sets, typed arrays, custom instances, symbol keys, accessors, and unexpected non-enumerable properties. Plain objects may use `Object.prototype` or a null prototype.

**DECISION** — Property descriptors are inspected before values are read. Getter and setter properties are rejected without invocation. Plain objects may contain only enumerable data properties. Arrays may contain only their standard non-enumerable `length` property and enumerable indexed data elements.

Canonicalization errors have stable codes, paths, and messages and never contain inspected property values.

## Hash contract

**DECISION** — Hashing uses `globalThis.crypto.subtle`, SHA-256, and `TextEncoder`. Node crypto APIs are forbidden from `src/core`.

Hashes use `sha256:` followed by exactly 64 lowercase hexadecimal characters.

```text
manifestHash = SHA-256(UTF-8(canonical-json(normalized-manifest)))
planHash     = SHA-256(UTF-8(canonical-json(plan-body-without-planHash)))
```

The golden Phase 2 fixture produces:

```text
manifestHash = sha256:e35ca81e3ace310cfd0405572e4ea62fd182a398045c7de416df021ae4ab51a1
planHash     = sha256:4298e240bb62db3a807fd705d942ca81fe61612c6d2770bbb2809c4c6ce82740
```

These expected values are literal test constants calculated independently from the canonical strings with external SHA-256 implementations.

## Execution Plan V1

```ts
{
  planVersion: "1.0";
  manifestHash: "sha256:<64 lowercase hex>";
  environment: "sandbox";
  chainId: "11155111";
  requiredSigner: {
    role: "tokenizer";
    walletAddress: string;
  };
  operations: [/* fixed seven-operation tuple */];
  planHash: "sha256:<64 lowercase hex>";
}
```

Each operation has a fixed sequence, semantic ID, kind, mode, dependency list, signer role or null, wallet-confirmation flag, strict intent, and deterministic human-readable summary.

| Sequence | ID | Mode | Required result |
| --- | --- | --- | --- |
| 1 | `tokenize` | Wallet transaction | Tokenize the normalized asset with the tokenizer signer. |
| 2 | `confirm-tokenization` | Confirmation and read | Confirm success; compare token and tokenizer read-back with the plan. |
| 3 | `whitelist-investor` | Wallet transaction | Standalone investor whitelist with the tokenizer signer. |
| 4 | `confirm-whitelist` | Confirmation and read | Confirm success and require whitelist read-back true for the planned address. |
| 5 | `mint` | Wallet transaction | Mint with `REQUIRE_CONFIRMED_STANDALONE_WHITELIST`; do not bundle whitelist. |
| 6 | `confirm-mint` | Confirmation and read | Confirm success and verify balance/whitelist read-back. |
| 7 | `verify-deployment` | Final verification | Require every preceding confirmation and requested-versus-observed match. |

**DECISION** — Operations 1, 3, and 5 require separate wallet confirmations. Confirmation and read-back are explicit plan operations, not hidden adapter behavior.

**DECISION** — Human-readable operation summaries are included in the plan body and therefore affect `planHash`. Any future change to summary templates requires an intentional plan-version decision; it is not presentation-only copy.

**ASSUMPTION** — `EQUALS_MINT_AMOUNT_FOR_NEW_INVESTOR` assumes a newly introduced investor with a zero pre-mint balance. Supporting existing investors later requires capturing the pre-mint balance and verifying the post-mint delta.

**DECISION** — The builder creates new operation and intent objects and returns a deeply readonly, runtime-frozen plan. It accepts only the branded normalized manifest and defensively verifies provenance, frozen state, schema validity, and unchanged normalized values at its public boundary.

## Explicit Phase 2 exclusions

- Brickken imports or network calls
- REST/SDK request construction
- persistence or state-machine implementation
- wallet libraries, signing, or broadcasting
- approval and receipt generation
- timestamps, random IDs, or environment-dependent plan fields
- UI, authentication, natural-language input, or fabricated Brickken mocks
