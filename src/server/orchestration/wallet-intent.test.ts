import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createValidRawManifest, TOKENIZER_ADDRESS } from "@/core/test-fixtures";
import { validateAssetManifestV1 } from "@/core";
import encodingA from "@/server/brickken/test-vectors/prepare/newTokenization.response.json";
import { parsePreparedOperation } from "../brickken/prepared-transaction";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import type { WalletSemanticPolicy } from "@/shared/wallet";
import { denyAllWalletSemanticPolicy, validateWalletPromptEnvelopeV1 } from "@/shared/wallet";
import { deriveWalletPromptEnvelopeFromRun } from "./wallet-intent";

const allowFixturePolicy: WalletSemanticPolicy = Object.freeze({
  authorize: () =>
    Object.freeze({ allowed: true as const, policyVersion: "fixture-v1", authorizationId: "fixture" }),
});

async function createPromptedRun(raw: unknown = encodingA) {
  const preparedOperation = parsePreparedOperation(raw);
  if (!preparedOperation.ok) throw preparedOperation.error;
  let operation = 0;
  const clock: Clock = { nowIso: () => "2026-09-04T00:00:00.000Z" };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () =>
      [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ][operation++]!,
    eventId: () => `event-${operation++}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  const service = new ExecutionRunService({ repository, clock, ids });
  const parsed = validateAssetManifestV1(createValidRawManifest());
  if (!parsed.ok) throw new Error("fixture invalid");
  const created = await service.createRun(parsed.value);
  const approved = await service.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, clock.nowIso()),
  });
  const preparing = await service.beginPrepare(approved.id, approved.revision, "TOKENIZE");
  const prepared = await service.recordPrepared(preparing.id, preparing.revision, "TOKENIZE", {
    txId: preparedOperation.value.txId,
    unsignedTransaction: preparedOperation.value.transaction.rawUnsigned,
  });
  return service.recordWalletPrompt(prepared.id, prepared.revision, "TOKENIZE");
}

describe("server wallet intent derivation", () => {
  it("rederives a strict browser envelope only from the durable prompted run", async () => {
    const run = await createPromptedRun();
    const envelope = await deriveWalletPromptEnvelopeFromRun(run, "TOKENIZE", allowFixturePolicy);

    await expect(validateWalletPromptEnvelopeV1(structuredClone(envelope))).resolves.toEqual(envelope);
    expect(envelope).toMatchObject({
      runId: run.id,
      manifestHash: run.manifestHash,
      planHash: run.planHash,
      preparedTransactionId: encodingA.txId,
      requiredSigner: TOKENIZER_ADDRESS,
      chainId: "11155111",
      promptRevision: run.revision,
    });
    expect(envelope.walletRequest).not.toHaveProperty("chainId");
    expect(envelope).not.toHaveProperty("unsignedTransaction");
    expect(JSON.stringify(envelope)).not.toContain("transactions");
  });

  it("refuses a signer mismatch or a deny-all semantic policy", async () => {
    const run = await createPromptedRun();
    const mismatch = {
      ...run,
      operations: [
        {
          ...run.operations[0],
          unsignedTransaction: {
            ...run.operations[0].unsignedTransaction,
            from: "0x9999999999999999999999999999999999999999",
          },
        },
        run.operations[1],
        run.operations[2],
      ],
    } as typeof run;
    await expect(
      deriveWalletPromptEnvelopeFromRun(mismatch, "TOKENIZE", allowFixturePolicy),
    ).rejects.toMatchObject({ code: "EXECUTION_INVARIANT_FAILED" });
    await expect(
      deriveWalletPromptEnvelopeFromRun(run, "TOKENIZE", {
        authorize: () => ({ allowed: false, code: "SEMANTIC_POLICY_UNVERIFIED" }),
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_INVARIANT_FAILED" });
  });
});

// Phase 9 composes existing boundaries only. Encoding A is the checked-in,
// normalized documentation example; its truncated calldata and destination
// establish representation, never live Brickken behavior or semantic authority.
describe("Phase 9 offline TOKENIZE compatibility", () => {
  const network = vi.fn(() => { throw new Error("UNEXPECTED_OFFLINE_NETWORK"); });
  beforeEach(() => {
    network.mockClear();
    vi.stubGlobal("fetch", network);
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("preserves the sourced signing fields through server derivation and browser recomputation", async () => {
    const raw = structuredClone(encodingA);
    const original = structuredClone(raw);
    const run = await createPromptedRun(raw);
    const envelope = await deriveWalletPromptEnvelopeFromRun(run, "TOKENIZE", allowFixturePolicy);
    const browser = await validateWalletPromptEnvelopeV1(JSON.parse(JSON.stringify(envelope)));
    expect(browser).toEqual(envelope);
    expect(browser.walletRequest).toEqual({
      from: encodingA.transactions[0].from,
      to: encodingA.transactions[0].to,
      data: encodingA.transactions[0].data,
      value: "0x0",
      gas: "0xccef",
      nonce: "0xed0",
      type: "0x2",
      maxFeePerGas: "0x11a3c5",
      maxPriorityFeePerGas: "0x118c30",
    });
    expect(browser.requiredSigner).toBe(TOKENIZER_ADDRESS);
    expect(browser.operation.kind).toBe("TOKENIZE");
    expect(browser.chainId).toBe("11155111");
    expect(browser.chainRequirement).toEqual({
      mode: "PROVIDER_PRECONDITION", decimalChainId: "11155111", rpcChainId: "0xaa36a7",
    });
    for (const absent of ["chainId", "gasLimit", "input", "gasPrice", "accessList"]) {
      expect(browser.walletRequest).not.toHaveProperty(absent);
    }
    const repeated = await deriveWalletPromptEnvelopeFromRun(
      await createPromptedRun(raw), "TOKENIZE", allowFixturePolicy,
    );
    expect(repeated).toEqual(envelope);
    expect(raw).toEqual(original);
    expect(run.operations[0].unsignedTransaction).toEqual(original.transactions[0]);
    for (const value of [browser, browser.operation, browser.chainRequirement, browser.integrity, browser.walletRequest]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(JSON.stringify(browser)).not.toMatch(/tokenizerEmail|rawUnsigned|approval|capability|BRICKKEN_API_KEY/);
    await expect(validateWalletPromptEnvelopeV1({
      ...browser, walletRequest: { ...browser.walletRequest, nonce: "0x0" },
    })).rejects.toThrow("WALLET_INTENT_HASH_MISMATCH");
  });

  it("proves canonical equivalence of aliases without changing the wallet intent", async () => {
    const baseline = await deriveWalletPromptEnvelopeFromRun(
      await createPromptedRun(), "TOKENIZE", allowFixturePolicy,
    );
    const raw = structuredClone(encodingA);
    const equivalent = {
      ...raw,
      transactions: [{
        ...raw.transactions[0], chainId: "0xaa36a7", value: "0x0000",
        input: raw.transactions[0].data.toUpperCase().replace("0X", "0x"),
        gas: String(0xccef),
      }],
    };
    const envelope = await deriveWalletPromptEnvelopeFromRun(
      await createPromptedRun(equivalent), "TOKENIZE", allowFixturePolicy,
    );
    expect(envelope).toEqual(baseline);
  });

  it("preserves an explicit access list through the same projection and integrity checks", async () => {
    // Reuse the synthetic access-list values exercised in transaction.test.ts.
    // This tests representation only; it is not a sourced TOKENIZE access list.
    const accessList = [{ address: encodingA.transactions[0].to, storageKeys: [`0x${"AB".repeat(32)}`] }];
    const raw = { ...encodingA, transactions: [{ ...encodingA.transactions[0], accessList }] };
    const original = structuredClone(raw);
    const envelope = await deriveWalletPromptEnvelopeFromRun(
      await createPromptedRun(raw), "TOKENIZE", allowFixturePolicy,
    );
    const browser = await validateWalletPromptEnvelopeV1(JSON.parse(JSON.stringify(envelope)));
    expect(browser.walletRequest.accessList).toEqual([
      { address: accessList[0].address, storageKeys: [`0x${"ab".repeat(32)}`] },
    ]);
    expect(browser.integrity).toEqual(envelope.integrity);
    expect(raw).toEqual(original);
    for (const value of [browser.walletRequest.accessList, browser.walletRequest.accessList?.[0], browser.walletRequest.accessList?.[0]?.storageKeys]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  // These mutations are synthetic incompatibility cases, not provider evidence.
  it.each([
    ["signer mismatch", { from: "0x9999999999999999999999999999999999999999" }, "EXECUTION_INVARIANT_FAILED"],
    ["wrong chain", { chainId: 1 }, "UNSUPPORTED_CHAIN"],
    ["conflicting calldata", { input: "0x1234" }, "CONFLICTING_TRANSACTION_FIELDS"],
    ["conflicting gas", { gas: "0x1" }, "CONFLICTING_TRANSACTION_FIELDS"],
    ["mixed fees", { gasPrice: "1" }, "CONFLICTING_TRANSACTION_FIELDS"],
    ["unknown signing field", { authorizationList: [] }, "UNSUPPORTED_SIGNING_FIELD"],
    ["unsupported type", { type: 3 }, "UNSUPPORTED_SIGNING_FIELD"],
    ["malformed quantity", { value: "not-a-quantity" }, "MALFORMED_PREPARED_TRANSACTION"],
    ["unsafe number", { value: Number.MAX_SAFE_INTEGER + 1 }, "UNSAFE_NUMBER"],
  ])("refuses %s through the composed boundary", async (_label, patch, code) => {
    const raw = { ...encodingA, transactions: [{ ...encodingA.transactions[0], ...patch }] };
    const original = structuredClone(raw);
    await expect(createPromptedRun(raw).then((run) =>
      deriveWalletPromptEnvelopeFromRun(run, "TOKENIZE", allowFixturePolicy),
    )).rejects.toMatchObject({ code });
    expect(raw).toEqual(original);
  });

  it.each([0, 2])("refuses %i transactions before deriving an intent", async (count) => {
    await expect(createPromptedRun({
      ...encodingA, transactions: Array.from({ length: count }, () => structuredClone(encodingA.transactions[0])),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_TRANSACTION_BATCH" });
  });

  it.each(["from", "to", "data", "chainId", "value", "gasLimit", "nonce", "type", "maxFeePerGas", "maxPriorityFeePerGas"])(
    "refuses missing required %s without inventing a value", async (field) => {
      const transaction: Record<string, unknown> = { ...encodingA.transactions[0] };
      delete transaction[field];
      await expect(createPromptedRun({ ...encodingA, transactions: [transaction] }))
        .rejects.toMatchObject({ code: "PREPARED_TRANSACTION_INCOMPLETE" });
      expect(transaction).not.toHaveProperty(field);
    },
  );

  it("keeps a representation-compatible TOKENIZE blocked by the production semantic policy", async () => {
    const run = await createPromptedRun();
    // This allow policy exists only in this test file to reach integrity derivation.
    const representation = await deriveWalletPromptEnvelopeFromRun(run, "TOKENIZE", allowFixturePolicy);
    expect(denyAllWalletSemanticPolicy.authorize({
      operationKind: "TOKENIZE", chainId: "11155111", walletRequest: representation.walletRequest,
    })).toEqual({ allowed: false, code: "SEMANTIC_POLICY_UNVERIFIED" });
    await expect(deriveWalletPromptEnvelopeFromRun(run, "TOKENIZE", denyAllWalletSemanticPolicy))
      .rejects.toMatchObject({ code: "EXECUTION_INVARIANT_FAILED" });
    // No provider, transport, adapter, gateway or database is constructed here.
  });
});
