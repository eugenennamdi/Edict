import { describe, expect, it, vi } from "vitest";
import {
  createWalletPromptEnvelopeV1,
  projectPreparedTransactionV1,
  type AuthorizedExecutionRunProjection,
  type EdictEip1193Provider,
  type WalletPromptEnvelopeV1,
  type WalletSemanticPolicy,
} from "@/shared/wallet";
import { WalletBoundaryError } from "./errors";
import {
  executePreparedTransactionFromUserAction,
  type ExecutionGateway,
  type WalletResultRequestV1,
} from "./execution";
import { SelectedWalletSession } from "./session";

const preparedFixture = Object.freeze({
  from: "0xb91155113039693456491ac398614bc81fef5ea7",
  to: "0x4444444444444444444444444444444444444444",
  data: "0x1234",
  value: "0x0",
  gasLimit: "0x5208",
  nonce: "0x1",
  type: "0x2",
  chainId: "0xaa36a7",
  maxFeePerGas: "0x10",
  maxPriorityFeePerGas: "0x1",
});
const PREPARED_TX_ID = "fixture-transaction-id";
const SIGNER = preparedFixture.from;
const HASH = `0x${"ab".repeat(32)}`;
const operationId = "22222222-2222-4222-8222-222222222222";
const projected = projectPreparedTransactionV1(preparedFixture);

const allowFixturePolicy: WalletSemanticPolicy = Object.freeze({
  authorize: () =>
    Object.freeze({ allowed: true as const, policyVersion: "fixture-v1", authorizationId: "fixture" }),
});

function run(
  revision: number,
  stage: string,
  blockchainTxHash: string | null = null,
): AuthorizedExecutionRunProjection {
  return Object.freeze({
    id: "11111111-1111-4111-8111-111111111111",
    manifestHash: `sha256:${"11".repeat(32)}`,
    planHash: `sha256:${"22".repeat(32)}`,
    environment: "sandbox",
    chainId: "11155111",
    requiredSigner: Object.freeze({ role: "tokenizer", walletAddress: SIGNER }),
    phase: "TOKENIZATION",
    status: "AWAITING_WALLET",
    approved: true,
    revision,
    operations: Object.freeze([
      Object.freeze({
        id: operationId,
        kind: "TOKENIZE" as const,
        stage,
        preparedTxId: PREPARED_TX_ID,
        blockchainTxHash,
      }),
      Object.freeze({ id: "33333333-3333-4333-8333-333333333333", kind: "WHITELIST" as const, stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null }),
      Object.freeze({ id: "44444444-4444-4444-8444-444444444444", kind: "MINT" as const, stage: "NOT_STARTED", preparedTxId: null, blockchainTxHash: null }),
    ]),
  });
}

async function promptEnvelope(): Promise<WalletPromptEnvelopeV1> {
  const current = run(5, "WALLET_PROMPT_RECORDED");
  return createWalletPromptEnvelopeV1({
    envelopeVersion: "1.0",
    runId: current.id,
    manifestHash: current.manifestHash,
    planHash: current.planHash,
    environment: current.environment,
    operation: Object.freeze({ id: operationId, kind: "TOKENIZE" }),
    preparedTransactionId: PREPARED_TX_ID,
    requiredSigner: SIGNER,
    chainId: "11155111",
    promptRevision: current.revision,
    walletRequestVersion: "1.0",
    walletRequest: projected.walletRequest,
    chainRequirement: Object.freeze({
      mode: "PROVIDER_PRECONDITION",
      decimalChainId: "11155111",
      rpcChainId: "0xaa36a7",
    }),
  });
}

class Provider implements EdictEip1193Provider {
  accounts: string[] = [SIGNER];
  chainId = "0xaa36a7";
  sendResult: unknown = HASH;
  sendError: unknown = null;
  onSend: (() => void) | null = null;
  readonly calls: Array<{ method: string; params?: readonly unknown[] | Record<string, unknown> }> = [];
  readonly handlers = new Map<string, Set<(...args: readonly unknown[]) => void>>();

  readonly request = vi.fn(async (request: {
    readonly method: string;
    readonly params?: readonly unknown[] | Record<string, unknown>;
  }) => {
    this.calls.push(request);
    if (request.method === "eth_accounts") return this.accounts;
    if (request.method === "eth_chainId") return this.chainId;
    if (request.method === "eth_sendTransaction") {
      this.onSend?.();
      if (this.sendError !== null) throw this.sendError;
      return this.sendResult;
    }
    throw new Error("unexpected method");
  });

  on = (event: string, listener: (...args: readonly unknown[]) => void) => {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(listener);
    this.handlers.set(event, listeners);
  };

  removeListener = (event: string, listener: (...args: readonly unknown[]) => void) => {
    this.handlers.get(event)?.delete(listener);
  };

  emit(event: string) {
    for (const listener of this.handlers.get(event) ?? []) listener();
  }
}

async function harness(options: {
  envelope?: unknown;
  promptError?: unknown;
  resultError?: unknown;
  fallbackRun?: AuthorizedExecutionRunProjection;
} = {}) {
  const provider = new Provider();
  const results: WalletResultRequestV1[] = [];
  let reads = 0;
  let promptRecorded = false;
  const envelope = options.envelope ?? (await promptEnvelope());
  const gateway: ExecutionGateway = {
    readRun: vi.fn(async () => {
      reads += 1;
      return reads === 1 ? run(4, "PREPARED") : (options.fallbackRun ?? run(6, "BROADCAST_HASH_PERSISTED", HASH));
    }),
    recordPrompt: vi.fn(async () => {
      if (options.promptError) throw options.promptError;
      promptRecorded = true;
      return envelope as WalletPromptEnvelopeV1;
    }),
    recordResult: vi.fn(async (result) => {
      results.push(result);
      if (options.resultError) throw options.resultError;
      if (result.result.outcome === "BROADCAST") {
        return run(6, "BROADCAST_HASH_PERSISTED", result.result.txHash);
      }
      return run(6, result.result.outcome === "REJECTED" ? "WALLET_REJECTED" : "BROADCAST_UNKNOWN");
    }),
  };
  provider.onSend = () => {
    expect(promptRecorded).toBe(true);
  };
  return {
    provider,
    gateway,
    results,
    wallet: new SelectedWalletSession("wallet-1", "EIP6963", provider),
  };
}

function execute(setup: Awaited<ReturnType<typeof harness>>, semanticPolicy = allowFixturePolicy) {
  return executePreparedTransactionFromUserAction({
    runId: "11111111-1111-4111-8111-111111111111",
    expectedRevision: 4,
    operationKind: "TOKENIZE",
    wallet: setup.wallet,
    gateway: setup.gateway,
    semanticPolicy,
  });
}

function sendCalls(provider: Provider) {
  return provider.calls.filter((call) => call.method === "eth_sendTransaction");
}

describe("deterministic browser transaction boundary", () => {
  it("records the durable prompt before one send and hands off the exact frozen validated request", async () => {
    const setup = await harness();
    await expect(execute(setup)).resolves.toMatchObject({ outcome: "BROADCAST_RECORDED", txHash: HASH });
    const calls = sendCalls(setup.provider);
    expect(calls).toHaveLength(1);
    const request = (calls[0]!.params as readonly unknown[])[0];
    expect(request).toEqual(projected.walletRequest);
    expect(Object.isFrozen(request)).toBe(true);
    expect(request).not.toHaveProperty("chainId");
    expect(setup.results).toHaveLength(1);
    expect(setup.results[0]?.result).toEqual({ outcome: "BROADCAST", txHash: HASH });
  });

  it("blocks prompt, malformed-envelope, semantic, account, and chain failures before provider invocation", async () => {
    const promptFailure = await harness({ promptError: new Error("storage detail") });
    await expect(execute(promptFailure)).rejects.toMatchObject({ code: "DURABLE_PROMPT_RECORDING_FAILED", reconciliationRequired: false });

    const malformed = await harness({ envelope: { rawTransaction: preparedFixture } });
    await expect(execute(malformed)).rejects.toMatchObject({ code: "MALFORMED_PROMPT_ENVELOPE", reconciliationRequired: false });

    const semantic = await harness();
    await expect(execute(semantic, { authorize: () => ({ allowed: false, code: "SEMANTIC_POLICY_UNVERIFIED" }) })).rejects.toMatchObject({ code: "SEMANTIC_POLICY_REFUSED", reconciliationRequired: false });

    const account = await harness();
    account.provider.accounts = ["0x9999999999999999999999999999999999999999"];
    await expect(execute(account)).rejects.toMatchObject({ code: "REQUIRED_ACCOUNT_UNAVAILABLE", reconciliationRequired: false });

    const chain = await harness();
    chain.provider.chainId = "0x1";
    await expect(execute(chain)).rejects.toMatchObject({ code: "WRONG_CHAIN", reconciliationRequired: false });

    for (const setup of [promptFailure, malformed, semantic, account, chain]) {
      expect(sendCalls(setup.provider)).toHaveLength(0);
      expect(setup.results).toHaveLength(0);
    }
  });

  it("classifies a non-4001 failure after invocation as unknown and never resends", async () => {
    const setup = await harness();
    setup.provider.sendError = Object.assign(new Error("provider secret detail"), { code: 4900 });
    await expect(execute(setup)).rejects.toMatchObject({
      code: "BROADCAST_OUTCOME_UNKNOWN",
      reconciliationRequired: true,
    });
    expect(sendCalls(setup.provider)).toHaveLength(1);
    expect(setup.results.map((result) => result.result)).toEqual([{ outcome: "UNKNOWN" }]);
  });

  it("records a definite 4001 rejection without calling the provider twice", async () => {
    const setup = await harness();
    setup.provider.sendError = Object.assign(new Error("provider detail"), { code: 4001 });
    await expect(execute(setup)).resolves.toEqual({ outcome: "REJECTED" });
    expect(sendCalls(setup.provider)).toHaveLength(1);
    expect(setup.results.map((result) => result.result)).toEqual([{ outcome: "REJECTED" }]);
  });

  it("moves a chain event after invocation and a malformed returned hash to reconciliation", async () => {
    const eventRace = await harness();
    eventRace.provider.onSend = () => eventRace.provider.emit("chainChanged");
    await expect(execute(eventRace)).rejects.toMatchObject({ code: "BROADCAST_OUTCOME_UNKNOWN" });
    expect(eventRace.results.map((result) => result.result)).toEqual([{ outcome: "UNKNOWN" }]);

    const malformed = await harness();
    malformed.provider.sendResult = "0x0";
    await expect(execute(malformed)).rejects.toMatchObject({
      code: "INVALID_TRANSACTION_HASH",
      reconciliationRequired: true,
    });
    expect(malformed.results.map((result) => result.result)).toEqual([{ outcome: "UNKNOWN" }]);
  });

  it("rereads after a failed hash handoff, accepts only the matching durable hash, and never resends", async () => {
    const recovered = await harness({ resultError: new Error("handoff failure") });
    await expect(execute(recovered)).resolves.toMatchObject({ outcome: "BROADCAST_RECORDED", txHash: HASH });
    expect(sendCalls(recovered.provider)).toHaveLength(1);

    const blocked = await harness({
      resultError: new Error("handoff failure"),
      fallbackRun: run(5, "WALLET_PROMPT_RECORDED"),
    });
    await expect(execute(blocked)).rejects.toMatchObject({
      code: "DURABLE_HASH_HANDOFF_FAILED",
      reconciliationRequired: true,
    });
    expect(sendCalls(blocked.provider)).toHaveLength(1);
  });

  it("rejects accessor-backed prompt values without executing the getter", async () => {
    const envelope = structuredClone(await promptEnvelope());
    let reads = 0;
    Object.defineProperty(envelope.walletRequest, "data", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "0x1234";
      },
    });
    const setup = await harness({ envelope });
    await expect(execute(setup)).rejects.toBeInstanceOf(WalletBoundaryError);
    expect(reads).toBe(0);
    expect(sendCalls(setup.provider)).toHaveLength(0);
  });
});
