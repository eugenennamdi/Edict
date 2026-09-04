import { describe, expect, it } from "vitest";
import encodingA from "@/server/brickken/test-vectors/prepare/newTokenization.response.json";
import {
  createWalletPromptEnvelopeV1,
  hashWalletIntentV1,
  validateWalletPromptEnvelopeV1,
  type WalletIntentV1,
} from "./intent";
import { projectPreparedTransactionV1 } from "./transaction";

const projected = projectPreparedTransactionV1(encodingA.transactions[0]);

const base = {
  envelopeVersion: "1.0" as const,
  runId: "11111111-1111-4111-8111-111111111111",
  manifestHash: "sha256:7db75c525a9757f6297bd2289c17fa36bb017d8a7ccce5f221eadae638c54baf" as const,
  planHash: "sha256:09a1af3868ffc532f845c88f324fc4ce404f85ad2a37641e1777a3ccc79013c7" as const,
  environment: "sandbox" as const,
  operation: { id: "22222222-2222-4222-8222-222222222222", kind: "TOKENIZE" as const },
  preparedTransactionId: encodingA.txId,
  requiredSigner: encodingA.transactions[0].from,
  chainId: "11155111" as const,
  promptRevision: 5,
  walletRequestVersion: "1.0" as const,
  walletRequest: projected.walletRequest,
  chainRequirement: {
    mode: "PROVIDER_PRECONDITION" as const,
    decimalChainId: "11155111" as const,
    rpcChainId: "0xaa36a7" as const,
  },
};

describe("wallet intent integrity", () => {
  it("round-trips a strict prompt envelope and recomputes its hash", async () => {
    const envelope = await createWalletPromptEnvelopeV1(base);
    await expect(validateWalletPromptEnvelopeV1(structuredClone(envelope))).resolves.toEqual(envelope);
    expect(envelope.walletRequest).not.toHaveProperty("chainId");
    expect(envelope).not.toHaveProperty("unsignedTransaction");
    expect(JSON.stringify(envelope)).not.toContain("tokenizerEmail");
  });

  it("binds every required intent field including prompt revision and chain", async () => {
    const envelope = await createWalletPromptEnvelopeV1(base);
    const intent: WalletIntentV1 = {
      domain: "edict.wallet-intent.v1",
      runId: envelope.runId,
      manifestHash: envelope.manifestHash,
      planHash: envelope.planHash,
      environment: envelope.environment,
      operation: envelope.operation,
      preparedTransactionId: envelope.preparedTransactionId,
      requiredSigner: envelope.requiredSigner,
      chainId: envelope.chainId,
      promptRevision: envelope.promptRevision,
      walletRequestVersion: envelope.walletRequestVersion,
      walletRequest: envelope.walletRequest,
    };
    const original = (await hashWalletIntentV1(intent)).hash;
    const changes: WalletIntentV1[] = [
      { ...intent, domain: "edict.wallet-intent.v1", runId: "changed" },
      { ...intent, manifestHash: `sha256:${"00".repeat(32)}` },
      { ...intent, planHash: `sha256:${"11".repeat(32)}` },
      { ...intent, environment: "sandbox", operation: { ...intent.operation, kind: "MINT" } },
      { ...intent, operation: { ...intent.operation, id: "changed" } },
      { ...intent, preparedTransactionId: "changed" },
      { ...intent, requiredSigner: "0x2222222222222222222222222222222222222222" },
      { ...intent, chainId: "11155111", promptRevision: intent.promptRevision + 1 },
      { ...intent, walletRequestVersion: "1.0", walletRequest: { ...intent.walletRequest, nonce: "0x0" } },
    ];
    for (const changed of changes) expect((await hashWalletIntentV1(changed)).hash).not.toBe(original);
  });

  it("has no concatenation field-boundary ambiguity", async () => {
    const envelope = await createWalletPromptEnvelopeV1(base);
    const common = {
      domain: "edict.wallet-intent.v1" as const,
      manifestHash: envelope.manifestHash,
      planHash: envelope.planHash,
      environment: envelope.environment,
      operation: envelope.operation,
      requiredSigner: envelope.requiredSigner,
      chainId: envelope.chainId,
      promptRevision: envelope.promptRevision,
      walletRequestVersion: envelope.walletRequestVersion,
      walletRequest: envelope.walletRequest,
    };
    const left = await hashWalletIntentV1({ ...common, runId: "ab", preparedTransactionId: "c" });
    const right = await hashWalletIntentV1({ ...common, runId: "a", preparedTransactionId: "bc" });
    expect(left.hash).not.toBe(right.hash);
    expect(left.canonicalJson).not.toBe(right.canonicalJson);
  });

  it("rejects a changed hash or unknown prompt property", async () => {
    const envelope = await createWalletPromptEnvelopeV1(base);
    await expect(
      validateWalletPromptEnvelopeV1({
        ...envelope,
        integrity: { ...envelope.integrity, walletIntentHash: `sha256:${"00".repeat(32)}` },
      }),
    ).rejects.toThrow("WALLET_INTENT_HASH_MISMATCH");
    await expect(validateWalletPromptEnvelopeV1({ ...envelope, rawResponse: encodingA })).rejects.toThrow(
      "MALFORMED_PROMPT_ENVELOPE",
    );
  });
});
