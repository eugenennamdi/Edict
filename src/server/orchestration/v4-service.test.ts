import { sha256Utf8, validateAssetManifestV1 } from "@/core";
import { TOKENIZER_ADDRESS, createValidRawManifest } from "@/core/test-fixtures";
import {
  type SemanticAuthorizationV1,
  hashWalletExecutionIntentV1,
} from "@/shared/wallet/execution-authorization";
import { describe, expect, it } from "vitest";
import {
  IllegalStateTransitionError,
  RepositoryRevisionConflictError,
} from "../execution/errors";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import type {
  ExecutionRunV4,
  OperationKind,
  PreparationAttemptV1,
} from "../execution/types";
import { projectPublicRun } from "../run-api/projection";
import { createTrustedSepoliaRpcClient } from "../rpc/client";
import type { RpcTransport } from "../rpc/types";
import {
  ExecutionV4Orchestrator,
  OrchestrationError,
  assertV4,
  ingestBroadcastHashInputSchema,
  type BrickkenCorrelationSender,
  type BrickkenStatusFetcher,
  type IngestBroadcastHashInput,
  type SemanticAuthorizationEvaluator,
} from "./v4-service";
import {
  BRICKKEN_NONCE_MISMATCH_STRING,
  type BrickkenServerAdapter,
  type BrickkenTransactionLocator,
} from "../brickken";

class FakeRpcTransport implements RpcTransport {
  #handlers: Map<string, (params?: readonly unknown[]) => unknown> = new Map();
  calls: Array<{ method: string; params?: readonly unknown[] }> = [];

  on(method: string, handler: (params?: readonly unknown[]) => unknown): this {
    this.#handlers.set(method, handler);
    return this;
  }

  async request(method: string, params?: readonly unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    const handler = this.#handlers.get(method);
    if (!handler) {
      throw new Error(`Unhandled RPC method in FakeRpcTransport: ${method}`);
    }
    return handler(params);
  }
}

class FakeSemanticAuthorizationEvaluator
  implements SemanticAuthorizationEvaluator
{
  readonly isProductionDenyAll = false;
  allow: boolean = true;
  authorizationId: string = "test-auth-1";

  async evaluate(input: {
    readonly run: ExecutionRunV4;
    readonly kind: OperationKind;
    readonly attempt: PreparationAttemptV1;
  }): Promise<
    | Readonly<{ authorized: true; semanticAuthorization: SemanticAuthorizationV1 }>
    | Readonly<{ authorized: false; reason: string }>
  > {
    if (!this.allow) {
      return Object.freeze({ authorized: false, reason: "POLICY_DENIED" });
    }
    const attempt = input.attempt;
    if (!attempt.immutableIdentity) {
      return Object.freeze({
        authorized: false,
        reason: "NO_IMMUTABLE_IDENTITY",
      });
    }
    const calldataCommitment = (await sha256Utf8(
      attempt.immutableIdentity.data,
    )) as `sha256:${string}`;
    const method =
      input.kind === "TOKENIZE"
        ? ("newTokenization" as const)
        : input.kind === "WHITELIST"
          ? ("whitelistUser" as const)
          : ("mintToken" as const);
    return Object.freeze({
      authorized: true as const,
      semanticAuthorization: {
        authorizationVersion: "1.0" as const,
        policyVersion: "policy-v1",
        authorizationId: this.authorizationId,
        environment: "sandbox" as const,
        brickkenMethod: method,
        executionMode: "client-broadcast" as const,
        destinationPolicy: {
          policyId: "dest-policy-1",
          reviewedDestination: attempt.immutableIdentity.to,
        },
        selectorPolicy: {
          policyId: "selector-policy-1",
          reviewedSelector: attempt.immutableIdentity.data.slice(0, 10),
        },
        calldataCommitment,
        decision: "ALLOW" as const,
      },
    });
  }
}

const TO = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const FINALIZED_BLOCK_HASH = `0x${"ef".repeat(32)}`;

const UNSIGNED_TOKENIZE_TX = {
  from: TOKENIZER_ADDRESS,
  to: TO,
  value: "0x0",
  nonce: "0x5",
  chainId: "0xaa36a7",
  data: "0x12345678aabb",
  type: "0x2",
  maxPriorityFeePerGas: "0x4",
  maxFeePerGas: "0x20",
  gasLimit: "0x100",
};

const CORRELATION_SUCCESS_DATA = {
  results: [
    {
      result: {
        transactionHash: TX_HASH,
        status: "pending" as const,
        executionMode: "client-broadcast" as const,
      },
    },
  ],
};

class FakeBrickkenCorrelationSender implements BrickkenCorrelationSender {
  response: { status: number; data?: unknown; rawBody?: string } = {
    status: 202,
    data: {
      results: [
        {
          result: {
            transactionHash: TX_HASH,
            status: "pending",
            executionMode: "client-broadcast",
          },
        },
      ],
    },
  };

  calls: Array<{ txId: string; txHash: string }> = [];

  async send(pair: { readonly txId: string; readonly txHash: string }) {
    this.calls.push(pair);
    return this.response;
  }
}

class FakeBrickkenStatusFetcher implements BrickkenStatusFetcher {
  response: { status: number; data?: unknown; rawBody?: string } = {
    status: 200,
    data: {
      status: "success",
      transactionHash: TX_HASH,
    },
  };

  calls: BrickkenTransactionLocator[] = [];

  async fetch(locator: BrickkenTransactionLocator) {
    this.calls.push(locator);
    return this.response;
  }
}

class FakeBrickkenReadBack implements Pick<BrickkenServerAdapter, "getTokenInfo" | "getTokenizerInfo"> {
  tokenCalls = 0;
  tokenizerCalls = 0;
  tokenAddress = "0x3333333333333333333333333333333333333333";
  walletAddress = TOKENIZER_ADDRESS;

  async getTokenInfo(query: { tokenSymbol: string }) {
    this.tokenCalls += 1;
    return {
      ok: true as const,
      value: {
        name: "Café Receivables",
        tokenName: null,
        tokenSymbol: query.tokenSymbol,
        tokenType: "RWA_TOKEN",
        tokenizerEmail: "tokenizer@example.com",
        companyWalletAddress: TOKENIZER_ADDRESS,
        maxTokenSupply: "1000",
        paymentChainId: "11155111",
      },
    };
  }

  async getTokenizerInfo() {
    this.tokenizerCalls += 1;
    return {
      ok: true as const,
      value: {
        companyWalletAddress: this.walletAddress,
        tokenAddress: this.tokenAddress,
        paymentTokenAddress: null,
        chainId: "11155111",
        email: "tokenizer@example.com",
      },
    };
  }
}

let globalAttemptCounter = 0;

function createHarness(options: { readonly readBack?: boolean } = {}) {
  let tick = 0;
  let id = 0;
  const clock: Clock = {
    nowIso: () => new Date(Date.UTC(2026, 8, 11, 9, 0, tick++)).toISOString(),
  };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () => `op-${++id}`,
    eventId: () => `event-${++id}`,
    invocationAttemptId: () => `inv-attempt-${++globalAttemptCounter}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  const runService = new ExecutionRunService({ repository, clock, ids });
  const fakeRpcTransport = new FakeRpcTransport();

  // Configure standard mock RPC responses for freshness
  fakeRpcTransport.on("eth_chainId", () => "0xaa36a7");
  fakeRpcTransport.on("eth_getTransactionCount", () => "0x5");
  fakeRpcTransport.on("eth_getBalance", () => "0x1000000000000000");
  fakeRpcTransport.on("eth_getBlockByNumber", (params) => {
    const tag = params?.[0];
    if (tag === "finalized") {
      return {
        number: "0x20",
        hash: FINALIZED_BLOCK_HASH,
        parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        baseFeePerGas: "0x10",
      };
    }
    return {
      number: "0x10",
      hash: BLOCK_HASH,
      parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      baseFeePerGas: "0x10",
    };
  });

  const rpc = createTrustedSepoliaRpcClient(fakeRpcTransport);
  const semanticAuth = new FakeSemanticAuthorizationEvaluator();
  const correlationSender = new FakeBrickkenCorrelationSender();
  const statusFetcher = new FakeBrickkenStatusFetcher();
  const readBack = new FakeBrickkenReadBack();

  const v4 = new ExecutionV4Orchestrator({
    repository,
    rpc,
    clock,
    ids,
    semanticAuthorization: semanticAuth,
    brickkenCorrelationSender: correlationSender,
    brickkenStatusFetcher: statusFetcher,
    ...(options.readBack ? { brickkenReadBack: readBack } : {}),
  });

  return {
    repository,
    runService,
    fakeRpcTransport,
    rpc,
    semanticAuth,
    correlationSender,
    statusFetcher,
    readBack,
    v4,
    clock,
    ids,
  };
}

async function createPreparedV2Run(harness: ReturnType<typeof createHarness>) {
  const validation = validateAssetManifestV1(createValidRawManifest());
  if (!validation.ok) throw new Error("fixture manifest invalid");
  const created = await harness.runService.createRun(validation.value);
  const approved = await harness.runService.approvePlan(
    created.id,
    created.revision,
    {
      planHash: created.planHash,
      approvedByWallet: TOKENIZER_ADDRESS,
      proof: createApprovalProofFixture(created, "2026-09-11T09:00:01.000Z"),
    },
  );
  const preparing = await harness.runService.beginPrepare(
    approved.id,
    approved.revision,
    "TOKENIZE",
  );
  return harness.runService.recordPrepared(
    preparing.id,
    preparing.revision,
    "TOKENIZE",
    {
      txId: "brickken-tx-1",
      unsignedTransaction: UNSIGNED_TOKENIZE_TX,
    },
  );
}

describe("ExecutionV4Orchestrator", () => {
  describe("Part B: Explicit V4 Promotion", () => {
    it("promotes a PREPARED V2 run to V4 with CAS", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      expect(runV2.schemaVersion).toBe("2.0");

      const promoted = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      expect(promoted.schemaVersion).toBe("4.0");
      expect(promoted.revision).toBe(runV2.revision + 1);
      const op = promoted.operations[0];
      expect(op.stage).toBe("PREPARED");
      expect(op.preparationAttempts).toHaveLength(1);
      expect(op.activePreparationAttemptId).toBe(op.preparationAttempts[0].attemptId);
      expect(op.preparationAttempts[0].immutableIdentity).not.toBeNull();
      expect(op.preparationAttempts[0].immutableIdentity?.nonce).toBe("0x5");
      expect(op.preparationAttempts[0].feeAuthorization).not.toBeNull();
    });

    it("rejects non-PREPARED runs from promotion", async () => {
      const h = createHarness();
      const validation = validateAssetManifestV1(createValidRawManifest());
      if (!validation.ok) throw new Error();
      const created = await h.runService.createRun(validation.value);

      // Status is AWAITING_APPROVAL, not PREPARED
      await expect(
        h.v4.promotePreparedRunToV4(created.id, created.revision),
      ).rejects.toThrow(IllegalStateTransitionError);
    });

    it("handles concurrent promotion via CAS so only one caller succeeds", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);

      const first = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      expect(first.schemaVersion).toBe("4.0");

      // Second caller with same old revision must fail with conflict
      await expect(
        h.v4.promotePreparedRunToV4(runV2.id, runV2.revision),
      ).rejects.toThrow(RepositoryRevisionConflictError);
    });

    it("does not upgrade on read", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const read = await h.repository.getById(runV2.id);
      expect(read.schemaVersion).toBe("2.0");
    });

    it("is idempotent when run is already V4 at current revision", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const promoted = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const secondCall = await h.v4.promotePreparedRunToV4(
        promoted.id,
        promoted.revision,
      );
      expect(secondCall.schemaVersion).toBe("4.0");
      expect(secondCall.revision).toBe(promoted.revision);
    });
  });

  describe("Part C: Prepared Freshness Service", () => {
    it("requires explicit promotion and cannot upgrade a V2 run through readiness", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);

      await expect(
        h.v4.evaluateAndApplyPreparedFreshness(runV2.id, runV2.revision),
      ).rejects.toThrow(IllegalStateTransitionError);
      const durable = await h.repository.getById(runV2.id);
      expect(durable.schemaVersion).toBe("2.0");
      expect(durable.revision).toBe(runV2.revision);
    });

    it("returns ELIGIBLE without mutating run or churning revision", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      const result = await h.v4.evaluateAndApplyPreparedFreshness(
        v4Run.id,
        v4Run.revision,
      );

      expect(result.evaluation.outcome).toBe("ELIGIBLE");
      expect(result.evaluation.eligible).toBe(true);
      expect(result.run.revision).toBe(v4Run.revision); // No revision churn
      expect(result.run.operations[0].stage).toBe("PREPARED");
    });

    it("transitions run to PREPARED_STALE via CAS on STALE_NONCE", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      // Simulate nonce mismatch on chain (pending nonce 0x6 != prepared 0x5)
      h.fakeRpcTransport.on("eth_getTransactionCount", () => "0x6");

      const result = await h.v4.evaluateAndApplyPreparedFreshness(
        v4Run.id,
        v4Run.revision,
      );

      expect(result.evaluation.outcome).toBe("STALE_NONCE");
      expect(result.evaluation.eligible).toBe(false);
      expect(result.run.revision).toBe(v4Run.revision + 1); // Mutated via CAS
      expect(result.run.operations[0].stage).toBe("PREPARED_STALE");
      const v4Updated = result.run as ExecutionRunV4;
      const active = v4Updated.operations[0].preparationAttempts[0];
      expect(active.state).toBe("STALE");
      expect(active.staleReason).toBe("NONCE_MISMATCH");
    });

    it("returns INSUFFICIENT_BALANCE without marking stale or churning revision", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      // Zero balance
      h.fakeRpcTransport.on("eth_getBalance", () => "0x0");

      const result = await h.v4.evaluateAndApplyPreparedFreshness(
        v4Run.id,
        v4Run.revision,
      );

      expect(result.evaluation.outcome).toBe("INSUFFICIENT_BALANCE");
      expect(result.evaluation.eligible).toBe(false);
      expect(result.run.revision).toBe(v4Run.revision); // Preserved
      expect(result.run.operations[0].stage).toBe("PREPARED");
    });

    it("returns FEE_CAP_EXCEEDED_BY_BASE_FEE without marking stale", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      // Base fee 0x50 > maxFeePerGas 0x20
      h.fakeRpcTransport.on("eth_getBlockByNumber", () => ({
        number: "0x10",
        hash: BLOCK_HASH,
        parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        baseFeePerGas: "0x50",
      }));

      const result = await h.v4.evaluateAndApplyPreparedFreshness(
        v4Run.id,
        v4Run.revision,
      );

      expect(result.evaluation.outcome).toBe("FEE_CAP_EXCEEDED_BY_BASE_FEE");
      expect(result.evaluation.eligible).toBe(false);
      expect(result.run.revision).toBe(v4Run.revision);
      expect(result.run.operations[0].stage).toBe("PREPARED");
    });

    it("fails closed on RPC_UNAVAILABLE without mutating run", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      // Break RPC transport
      h.fakeRpcTransport.on("eth_getTransactionCount", () => {
        throw new Error("RPC network failure");
      });

      const result = await h.v4.evaluateAndApplyPreparedFreshness(
        v4Run.id,
        v4Run.revision,
      );

      expect(result.evaluation.outcome).toBe("RPC_UNAVAILABLE");
      expect(result.evaluation.eligible).toBe(false);
      expect(result.run.revision).toBe(v4Run.revision);
      expect(result.run.operations[0].stage).toBe("PREPARED");
    });
  });

  describe("Part D: Explicit Repreparation Authority", () => {
    it("transitions PREPARED_STALE to REPREPARE_INTENT and records new prepared outcome", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      // Make stale
      h.fakeRpcTransport.on("eth_getTransactionCount", () => "0x6");
      const staleRes = await h.v4.evaluateAndApplyPreparedFreshness(
        v4Run.id,
        v4Run.revision,
      );
      const staleRun = staleRes.run as ExecutionRunV4;
      expect(staleRun.operations[0].stage).toBe("PREPARED_STALE");

      // Explicit begin reprepare
      const repreparedIntentRun = await h.v4.beginReprepare(
        staleRun.id,
        staleRun.revision,
        "attempt-2",
      );

      expect(repreparedIntentRun.operations[0].stage).toBe("REPREPARE_INTENT");
      expect(repreparedIntentRun.operations[0].preparationAttempts).toHaveLength(2);
      expect(repreparedIntentRun.operations[0].activePreparationAttemptId).toBe("attempt-2");

      // Prior attempt is immutably preserved
      const prior = repreparedIntentRun.operations[0].preparationAttempts[0];
      expect(prior.attemptId).toBe(
        staleRun.operations[0].preparationAttempts[0].attemptId,
      );
      expect(prior.state).toBe("STALE");

      // Record new preparation outcome
      const newTx = { ...UNSIGNED_TOKENIZE_TX, nonce: "0x6" };
      const repreparedRun = await h.v4.recordReprepared(
        repreparedIntentRun.id,
        repreparedIntentRun.revision,
        "brickken-tx-2",
        newTx,
      );

      expect(repreparedRun.operations[0].stage).toBe("PREPARED");
      expect(repreparedRun.operations[0].preparedTxId).toBe("brickken-tx-2");
      const active = repreparedRun.operations[0].preparationAttempts[1];
      expect(active.state).toBe("PREPARED");
      expect(active.immutableIdentity?.nonce).toBe("0x6");
    });

    it("blocks reprepare if wallet authority was already released", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      // Prompt and release authority
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      // Now attempt beginReprepare => must throw IllegalStateTransitionError
      await expect(
        h.v4.beginReprepare(releasedRun.id, releasedRun.revision),
      ).rejects.toThrow(IllegalStateTransitionError);
    });
  });

  describe("Part E & F: Wallet Authorization Preflight & Send Authority Release", () => {
    it("production semantic authorization is hardcoded DENY-ALL", async () => {
      const h = createHarness();
      const prodOrchestrator = new ExecutionV4Orchestrator({
        repository: h.repository,
        rpc: h.rpc,
        clock: h.clock,
        ids: h.ids,
        // Default semantic evaluator is DenyAllSemanticAuthorizationEvaluator
      });

      const runV2 = await createPreparedV2Run(h);
      const v4Run = await prodOrchestrator.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      const preflight = await prodOrchestrator.preflightWalletAuthorization(
        v4Run.id,
        v4Run.revision,
      );

      expect(preflight.authorized).toBe(false);
      if (!preflight.authorized) {
        expect(preflight.reason).toBe("AUTHORIZATION_DENIED");
      }

      // Calling releaseSendAuthority throws AUTHORIZATION_DENIED
      await expect(
        prodOrchestrator.releaseSendAuthority(
          v4Run.id,
          v4Run.revision,
        ),
      ).rejects.toThrow("Semantic authorization denied execution of the requested operation.");
    });

    it("with permissive evaluator in test: CAS occurs FIRST before envelope is released", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      // Record wallet prompt
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      expect(promptRun.operations[0].stage).toBe("WALLET_PROMPT_RECORDED");
      expect(
        promptRun.operations[0].walletPromptAuthorization?.providerInvocation,
      ).toBe("PROVEN_NOT_INVOKED");

      // Release send authority
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      // CAS wrote INVOKED_OR_UNKNOWN to repository
      expect(releasedRun.revision).toBe(promptRun.revision + 1);
      const promptAuth = releasedRun.operations[0].walletPromptAuthorization;
      expect(promptAuth?.providerInvocation).toBe("INVOKED_OR_UNKNOWN");
      expect(promptAuth?.invocationAttemptId).toBe(envelope.invocationAttemptId);
      expect(envelope.invocationAttemptId).toMatch(/^inv-attempt-\d+$/);

      // Public envelope contains only the exact provider request and durable bindings.
      expect(envelope.expectedRevision).toBe(releasedRun.revision);
      expect(envelope.walletRequest.nonce).toBe("0x5");
      expect(envelope.walletRequest.from).toBe(TOKENIZER_ADDRESS);
      expect(envelope.walletRequest.to).toBe(TO);
      expect(envelope).not.toHaveProperty("walletIntent");

      // Once INVOKED_OR_UNKNOWN is set, it cannot be re-released
      await expect(
        h.v4.releaseSendAuthority(
          releasedRun.id,
          releasedRun.revision,
        ),
      ).rejects.toThrow(IllegalStateTransitionError);
    });

    it("two concurrent authorization attempts yield one authority winner and loser receives no envelope", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );

      const promise1 = h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );
      const promise2 = h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      const results = await Promise.allSettled([promise1, promise2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        RepositoryRevisionConflictError,
      );

      const winner = (
        fulfilled[0] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof h.v4.releaseSendAuthority>>
        >
      ).value;
      expect(winner.envelope.invocationAttemptId).toMatch(/^inv-attempt-\d+$/);

      const updatedRun = await h.repository.getById(promptRun.id);
      await expect(
        h.v4.releaseSendAuthority(
          updatedRun.id,
          updatedRun.revision,
        ),
      ).rejects.toThrow(IllegalStateTransitionError);
    });

    it("two distinct authority releases obtain distinct server-generated invocationAttemptIds", async () => {
      const hA = createHarness();
      const runV2A = await createPreparedV2Run(hA);
      const v4RunA = await hA.v4.promotePreparedRunToV4(runV2A.id, runV2A.revision);
      const { envelope: envA } = await hA.v4.releaseSendAuthority(v4RunA.id, v4RunA.revision);

      const hB = createHarness();
      const runV2B = await createPreparedV2Run(hB);
      const v4RunB = await hB.v4.promotePreparedRunToV4(runV2B.id, runV2B.revision);
      const { envelope: envB } = await hB.v4.releaseSendAuthority(v4RunB.id, v4RunB.revision);

      expect(envA.invocationAttemptId).toBeDefined();
      expect(envB.invocationAttemptId).toBeDefined();
      expect(envA.invocationAttemptId).not.toBe(envB.invocationAttemptId);
    });

    it("wallet rejection is strictly impossible after authority release", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      await expect(
        h.v4.recordWalletRejected(
          releasedRun.id,
          releasedRun.revision,
        ),
      ).rejects.toThrow(IllegalStateTransitionError);
    });

    it("final authority CAS failure returns no envelope and creates no authority", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );

      await expect(
        h.v4.releaseSendAuthority(
          promptRun.id,
          promptRun.revision - 1,
        ),
      ).rejects.toThrow(RepositoryRevisionConflictError);

      const unchangedRun = await h.repository.getById(promptRun.id);
      assertV4(unchangedRun);
      expect(unchangedRun.revision).toBe(promptRun.revision);
      expect(
        unchangedRun.operations[0].walletPromptAuthorization?.providerInvocation,
      ).toBe("PROVEN_NOT_INVOKED");
    });

    it("supports atomic/sequential releaseSendAuthority directly from PREPARED state", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      expect(v4Run.operations[0].stage).toBe("PREPARED");
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        v4Run.id,
        v4Run.revision,
      );

      expect(releasedRun.operations[0].stage).toBe("WALLET_PROMPT_RECORDED");
      const promptAuth = releasedRun.operations[0].walletPromptAuthorization;
      expect(promptAuth?.providerInvocation).toBe("INVOKED_OR_UNKNOWN");
      expect(promptAuth?.invocationAttemptId).toBe(envelope.invocationAttemptId);
      expect(envelope.invocationAttemptId).toMatch(/^inv-attempt-\d+$/);
      expect(releasedRun.revision).toBe(v4Run.revision + 2);
    });

    it("allows only one concurrent authority release directly from PREPARED", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(runV2.id, runV2.revision);

      const results = await Promise.allSettled([
        h.v4.releaseSendAuthority(v4Run.id, v4Run.revision),
        h.v4.releaseSendAuthority(v4Run.id, v4Run.revision),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);

      const durable = await h.repository.getById(v4Run.id);
      assertV4(durable);
      expect(durable.operations[0].walletPromptAuthorization?.providerInvocation)
        .toBe("INVOKED_OR_UNKNOWN");
    });

    it("keeps authority consumed when the successful CAS response is lost", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(runV2.id, runV2.revision);

      await h.v4.releaseSendAuthority(v4Run.id, v4Run.revision);
      const durable = await h.repository.getById(v4Run.id);
      assertV4(durable);
      expect(durable.operations[0].walletPromptAuthorization?.providerInvocation)
        .toBe("INVOKED_OR_UNKNOWN");
      await expect(h.v4.releaseSendAuthority(durable.id, durable.revision))
        .rejects.toThrow(IllegalStateTransitionError);
    });

    it("rejects an old wallet intent hash after a newer preparation revision is authorized", async () => {
      const oldHarness = createHarness();
      const oldV2 = await createPreparedV2Run(oldHarness);
      const oldV4 = await oldHarness.v4.promotePreparedRunToV4(oldV2.id, oldV2.revision);
      const { envelope: oldEnvelope } = await oldHarness.v4.releaseSendAuthority(
        oldV4.id,
        oldV4.revision,
      );

      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const initial = await h.v4.promotePreparedRunToV4(runV2.id, runV2.revision);
      h.fakeRpcTransport.on("eth_getTransactionCount", () => "0x6");
      const stale = await h.v4.evaluateAndApplyPreparedFreshness(initial.id, initial.revision);
      const intent = await h.v4.beginReprepare(stale.run.id, stale.run.revision, "attempt-2");
      const reprepared = await h.v4.recordReprepared(
        intent.id,
        intent.revision,
        "brickken-tx-2",
        { ...UNSIGNED_TOKENIZE_TX, nonce: "0x6" },
      );
      const { envelope, run: released } = await h.v4.releaseSendAuthority(
        reprepared.id,
        reprepared.revision,
      );
      expect(envelope.walletIntentHash).not.toBe(oldEnvelope.walletIntentHash);
      await expect(h.v4.ingestBroadcastHash(released.id, {
        expectedRevision: released.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: oldEnvelope.walletIntentHash,
        txHash: TX_HASH,
      })).rejects.toThrow(IllegalStateTransitionError);
    });

    it("records ambiguous broadcast outcomes and forces RECONCILIATION_REQUIRED", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      const unknownRun = await h.v4.recordBroadcastUnknown(
        releasedRun.id,
        releasedRun.revision,
        "PROVIDER_TIMEOUT",
      );

      expect(unknownRun.status).toBe("RECONCILIATION_REQUIRED");
      expect(unknownRun.operations[0].stage).toBe("BROADCAST_UNKNOWN");
      expect(
        unknownRun.operations[0].walletPromptAuthorization?.unresolvedOutcome,
      ).toBe("PROVIDER_TIMEOUT");
    });

    it("binds browser ambiguity reports to the released invocation and intent", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(runV2.id, runV2.revision);
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        v4Run.id,
        v4Run.revision,
      );
      const base = {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        reason: "PROVIDER_4001" as const,
      };

      await expect(h.v4.recordBrowserBroadcastUnknown(releasedRun.id, {
        ...base,
        invocationAttemptId: "altered",
      })).rejects.toThrow(IllegalStateTransitionError);
      await expect(h.v4.recordBrowserBroadcastUnknown(releasedRun.id, {
        ...base,
        walletIntentHash: `sha256:${"0".repeat(64)}`,
      })).rejects.toThrow(IllegalStateTransitionError);

      const unknown = await h.v4.recordBrowserBroadcastUnknown(releasedRun.id, base);
      expect(unknown.status).toBe("RECONCILIATION_REQUIRED");
      expect(unknown.operations[0]).toMatchObject({ stage: "BROADCAST_UNKNOWN" });
    });

    it("records pre-invocation user rejection as WALLET_REJECTED", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );

      const rejectedRun = await h.v4.recordWalletRejected(
        promptRun.id,
        promptRun.revision,
      );

      expect(rejectedRun.operations[0].stage).toBe("WALLET_REJECTED");
    });
  });

  describe("Part G: Broadcast Hash Ingestion", () => {
    it("ingests canonical 32-byte txHash and binds to run", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      const broadcastRun = await h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });

      expect(broadcastRun.status).toBe("BROADCAST_RECORDED");
      expect(broadcastRun.operations[0].stage).toBe("BROADCAST_HASH_PERSISTED");
      expect(broadcastRun.operations[0].blockchainTxHash).toBe(TX_HASH);
    });

    it("golden test: canonical WalletExecutionIntentV1 -> canonical walletIntentHash -> envelope -> ingestion echo -> exact equality", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      // 1. Verify canonical sha256: format from source of truth
      expect(envelope.walletIntentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(envelope.walletIntentHash.startsWith("sha256:")).toBe(true);
      expect(envelope.walletIntentHash.startsWith("0x")).toBe(false);

      // 2. Canonical server-generated hash matches hashWalletExecutionIntentV1 over the intent
      const durableIntent = releasedRun.operations[0].walletPromptAuthorization?.walletIntent;
      expect(durableIntent).toBeDefined();
      const recalculated = await hashWalletExecutionIntentV1(durableIntent);
      expect(envelope.walletIntentHash).toBe(recalculated.hash);

      // 3. Durable persisted walletPromptAuthorization matches exactly
      const durablePrompt = releasedRun.operations[0].walletPromptAuthorization;
      expect(durablePrompt?.walletIntentHash).toBe(envelope.walletIntentHash);

      // 4. Ingestion echo of the exact canonical hash succeeds
      const broadcastRun = await h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });
      expect(broadcastRun.operations[0].stage).toBe("BROADCAST_HASH_PERSISTED");
    });

    it("rejects malformed walletIntentHash formats (0x prefix, invalid length, uppercase)", async () => {
      // 0x prefix rejected
      expect(() =>
        ingestBroadcastHashInputSchema.parse({
          expectedRevision: 1,
          invocationAttemptId: "inv-1",
          walletIntentHash: `0x${"a".repeat(64)}`,
          txHash: TX_HASH,
        }),
      ).toThrow();

      // Wrong length (63 hex instead of 64)
      expect(() =>
        ingestBroadcastHashInputSchema.parse({
          expectedRevision: 1,
          invocationAttemptId: "inv-1",
          walletIntentHash: `sha256:${"a".repeat(63)}`,
          txHash: TX_HASH,
        }),
      ).toThrow();

      // Uppercase hex rejected
      expect(() =>
        ingestBroadcastHashInputSchema.parse({
          expectedRevision: 1,
          invocationAttemptId: "inv-1",
          walletIntentHash: `sha256:${"A".repeat(64)}`,
          txHash: TX_HASH,
        }),
      ).toThrow();
    });

    it("rejects caller-provided kind in payload via strict schema", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      await expect(
        h.v4.ingestBroadcastHash(
          releasedRun.id,
          {
            expectedRevision: releasedRun.revision,
            kind: "TOKENIZE",
            invocationAttemptId: envelope.invocationAttemptId,
            walletIntentHash: envelope.walletIntentHash,
            txHash: TX_HASH,
          } as unknown as IngestBroadcastHashInput,
        ),
      ).rejects.toThrow();
    });

    it("rejects mismatched or altered invocationAttemptId", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      await expect(
        h.v4.ingestBroadcastHash(releasedRun.id, {
          expectedRevision: releasedRun.revision,
          invocationAttemptId: "altered-attempt-id",
          walletIntentHash: envelope.walletIntentHash,
          txHash: TX_HASH,
        }),
      ).rejects.toThrow(IllegalStateTransitionError);
    });

    it("rejects oversized invocationAttemptId (> 1024 chars) via schema validation", async () => {
      expect(() =>
        ingestBroadcastHashInputSchema.parse({
          expectedRevision: 1,
          invocationAttemptId: "x".repeat(1025),
          walletIntentHash: `sha256:${"a".repeat(64)}`,
          txHash: TX_HASH,
        }),
      ).toThrow();
    });

    it("rejects non-canonical / invalid transaction hash", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      await expect(
        h.v4.ingestBroadcastHash(releasedRun.id, {
          expectedRevision: releasedRun.revision,
          invocationAttemptId: envelope.invocationAttemptId,
          walletIntentHash: envelope.walletIntentHash,
          txHash: "not-a-tx-hash" as `0x${string}`,
        }),
      ).rejects.toThrow();
    });

    it("rejects caller-injected transaction fields via strict schema", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      const injectedInput = {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
        to: TO,
        from: TOKENIZER_ADDRESS,
        gas: "0x100",
        preparedTxId: "brickken-tx-1",
      };

      await expect(
        h.v4.ingestBroadcastHash(
          releasedRun.id,
          injectedInput as unknown as IngestBroadcastHashInput,
        ),
      ).rejects.toThrow();
    });

    it("canonicalizes mixed-case txHash to lowercase 32-byte hex", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );

      const mixedCaseHash = `0x${"A1B2C3D4".repeat(8)}`;
      const broadcastRun = await h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: mixedCaseHash,
      });

      expect(broadcastRun.operations[0].blockchainTxHash).toBe(mixedCaseHash.toLowerCase());
    });
  });

  describe("Part H: Trusted RPC Verification", () => {
    async function setupBroadcastRun(h: ReturnType<typeof createHarness>) {
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );
      return h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });
    }

    it("handles NOT_FOUND by preserving hash without advancing state or resending", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => null);

      const { evaluation, run } = await h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );

      expect(evaluation.presence).toBe("NOT_FOUND");
      expect(run.operations[0].stage).toBe("BROADCAST_HASH_PERSISTED");
      expect(run.operations[0].blockchainTxHash).toBe(TX_HASH);
      expect(run.revision).toBe(broadcastRun.revision); // No mutation
    });

    it("verifies UNMINED transaction in mempool", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: null,
        blockNumber: null,
        transactionIndex: null,
      }));

      const { evaluation, run } = await h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );

      expect(evaluation.presence).toBe("UNMINED");
      expect(evaluation.outcome).toBe("IMMUTABLE_MATCH + FEE_COMPLIANT");
      expect(run.operations[0].stage).toBe("RPC_TRANSACTION_VERIFIED");
      expect(run.status).toBe("BROADCAST_RECORDED");
    });

    it("verifies MINED transaction and transitions to RPC_TRANSACTION_VERIFIED", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      const { evaluation, run } = await h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );

      expect(evaluation.presence).toBe("MINED");
      expect(evaluation.outcome).toBe("IMMUTABLE_MATCH + FEE_COMPLIANT");
      expect(run.operations[0].stage).toBe("RPC_TRANSACTION_VERIFIED");
    });

    it("detects on-chain fee policy violation and sets RECONCILIATION_REQUIRED", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      // maxFeePerGas 0x30 exceeds authorized cap 0x20
      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x30",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      const { evaluation, run } = await h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );

      expect(evaluation.outcome).toBe(
        "IMMUTABLE_MATCH + POLICY_VIOLATION_ONCHAIN",
      );
      expect(run.status).toBe("RECONCILIATION_REQUIRED");
      expect(run.operations[0].stage).toBe("POLICY_VIOLATION_ONCHAIN");
    });

    it("detects immutable identity mismatch and sets RECONCILIATION_REQUIRED", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      // destination address differs
      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: "0x5555555555555555555555555555555555555555",
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      const { evaluation, run } = await h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );

      expect(evaluation.outcome).toBe("IMMUTABLE_MISMATCH");
      expect(run.status).toBe("RECONCILIATION_REQUIRED");
      expect(run.operations[0].stage).toBe(
        "RPC_TRANSACTION_RECONCILIATION_REQUIRED",
      );
    });

    it("does not churn revision on duplicate verification of verified run", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      const first = await h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );
      const second = await h.v4.verifyOnchainTransaction(
        first.run.id,
        first.run.revision,
      );

      expect(second.run.revision).toBe(first.run.revision);
    });
  });

  describe("Part I: Receipt & Finality Service", () => {
    async function setupVerifiedRun(h: ReturnType<typeof createHarness>) {
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );
      const broadcastRun = await h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      return h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );
    }

    it("evaluates pending/unmined receipt as NOT_FOUND without revision churn", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      h.fakeRpcTransport.on("eth_getTransactionReceipt", () => null);

      const { evaluation, run } = await h.v4.evaluateAndRecordReceiptFinality(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(evaluation.receiptStatus).toBe("NOT_FOUND");
      expect(run.revision).toBe(verifiedRun.revision);
      expect(run.operations[0].transactionReceiptEvidence).toBeNull();
    });

    it("records INCLUDED receipt when block is canonical but not yet finalized", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      h.fakeRpcTransport.on("eth_getTransactionReceipt", () => ({
        transactionHash: TX_HASH,
        transactionIndex: "0x0",
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        from: TOKENIZER_ADDRESS,
        to: TO,
        cumulativeGasUsed: "0x50",
        gasUsed: "0x50",
        effectiveGasPrice: "0x15",
        contractAddress: null,
        type: "0x2",
        status: "0x1",
        logs: [],
      }));

      // Finalized block is lower than receipt blockNumber 0x10
      h.fakeRpcTransport.on("eth_getBlockByNumber", (params) => {
        const tag = params?.[0];
        if (tag === "finalized") {
          return {
            number: "0x8",
            hash: FINALIZED_BLOCK_HASH,
            parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
            baseFeePerGas: "0x10",
          };
        }
        return {
          number: "0x10",
          hash: BLOCK_HASH,
          parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          baseFeePerGas: "0x10",
        };
      });

      const { evaluation, run } = await h.v4.evaluateAndRecordReceiptFinality(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(evaluation.receiptStatus).toBe("SUCCESS");
      expect(evaluation.canonicality).toBe("CANONICAL");
      expect(evaluation.finality).toBe("INCLUDED");
      expect(run.operations[0].transactionReceiptEvidence?.finalityStatus).toBe(
        "INCLUDED",
      );
    });

    it("records FINALIZED receipt when finalized head exceeds receipt block", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      h.fakeRpcTransport.on("eth_getTransactionReceipt", () => ({
        transactionHash: TX_HASH,
        transactionIndex: "0x0",
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        from: TOKENIZER_ADDRESS,
        to: TO,
        cumulativeGasUsed: "0x50",
        gasUsed: "0x50",
        effectiveGasPrice: "0x15",
        contractAddress: null,
        type: "0x2",
        status: "0x1",
        logs: [],
      }));

      // Finalized block is 0x20 >= 0x10
      h.fakeRpcTransport.on("eth_getBlockByNumber", (params) => {
        const tag = params?.[0];
        if (tag === "finalized") {
          return {
            number: "0x20",
            hash: FINALIZED_BLOCK_HASH,
            parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
            baseFeePerGas: "0x10",
          };
        }
        return {
          number: "0x10",
          hash: BLOCK_HASH,
          parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          baseFeePerGas: "0x10",
        };
      });

      const { evaluation, run } = await h.v4.evaluateAndRecordReceiptFinality(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(evaluation.receiptStatus).toBe("SUCCESS");
      expect(evaluation.finality).toBe("FINALIZED");
      expect(run.operations[0].transactionReceiptEvidence?.finalityStatus).toBe(
        "FINALIZED",
      );

      // Duplication test: calling again on already finalized does not churn revision
      const secondCall = await h.v4.evaluateAndRecordReceiptFinality(
        run.id,
        run.revision,
      );
      expect(secondCall.run.revision).toBe(run.revision);
    });

    it("marks run FAILED when receipt is reverted", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      h.fakeRpcTransport.on("eth_getTransactionReceipt", () => ({
        transactionHash: TX_HASH,
        transactionIndex: "0x0",
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        from: TOKENIZER_ADDRESS,
        to: TO,
        cumulativeGasUsed: "0x50",
        gasUsed: "0x50",
        effectiveGasPrice: "0x15",
        contractAddress: null,
        type: "0x2",
        status: "0x0", // Reverted
        logs: [],
      }));

      const { evaluation, run } = await h.v4.evaluateAndRecordReceiptFinality(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(evaluation.receiptStatus).toBe("REVERTED");
      expect(run.status).toBe("FAILED");
      expect(run.terminalOutcome).toBe("FAILED");
    });
  });

  describe("Part J: Brickken Correlation Service", () => {
    async function setupVerifiedRun(h: ReturnType<typeof createHarness>) {
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );
      const broadcastRun = await h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      return h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );
    }

    it("successfully correlates with Brickken on HTTP 202 response", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      h.correlationSender.response = {
        status: 202,
        data: CORRELATION_SUCCESS_DATA,
      };

      const { result, run: correlatedRun } = await h.v4.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(result.outcome).toBe("CORRELATED_PENDING");
      expect(correlatedRun.operations[0].stage).toBe("BRICKKEN_CORRELATED");
      expect(correlatedRun.operations[0].brickkenStatus).toBe("pending");
      expect(correlatedRun.operations[0].brickkenCorrelation?.lifecycle).toBe(
        "CORRELATED",
      );
    });

    it("records TEMPORARILY_NOT_FOUND and authorizes retry within budget", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      // Attempt 1: Brickken hasn't seen tx yet
      h.correlationSender.response = {
        status: 404,
        data: {
          message: "Broadcast transaction was not found on the prepared chain",
        },
      };

      const firstAttempt = await h.v4.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(firstAttempt.result.outcome).toBe("TEMPORARILY_NOT_FOUND");
      expect(firstAttempt.run.operations[0].stage).toBe(
        "BRICKKEN_CORRELATION_PENDING",
      );
      const attempts1 =
        firstAttempt.run.operations[0].brickkenCorrelation?.attempts;
      expect(attempts1).toHaveLength(1);
      expect(attempts1?.[0].result).toBe("TEMPORARILY_NOT_FOUND");

      // Attempt 2: Brickken now confirms tx
      h.correlationSender.response = {
        status: 202,
        data: CORRELATION_SUCCESS_DATA,
      };

      const secondAttempt = await h.v4.correlateWithBrickken(
        firstAttempt.run.id,
        firstAttempt.run.revision,
      );

      expect(secondAttempt.result.outcome).toBe("CORRELATED_PENDING");
      expect(secondAttempt.run.operations[0].stage).toBe("BRICKKEN_CORRELATED");
      expect(
        secondAttempt.run.operations[0].brickkenCorrelation?.attempts,
      ).toHaveLength(2);
    });

    it("enforces max 3 correlation attempts for the exact same pair and handles retry exhaustion without refusal", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      let sendCalls = 0;
      const customSender: BrickkenCorrelationSender = {
        async send() {
          sendCalls += 1;
          return {
            status: 404,
            data: {
              message: "Broadcast transaction was not found on the prepared chain",
            },
          };
        },
      };

      const orchestrator = new ExecutionV4Orchestrator({
        repository: h.repository,
        rpc: h.rpc,
        clock: h.clock,
        ids: h.ids,
        semanticAuthorization: h.semanticAuth,
        brickkenCorrelationSender: customSender,
      });

      // Attempt 1: consumes 1
      const att1 = await orchestrator.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );
      expect(att1.result.outcome).toBe("TEMPORARILY_NOT_FOUND");
      expect(sendCalls).toBe(1);

      // Attempt 2: consumes 2
      const att2 = await orchestrator.correlateWithBrickken(
        att1.run.id,
        att1.run.revision,
      );
      expect(att2.result.outcome).toBe("TEMPORARILY_NOT_FOUND");
      expect(sendCalls).toBe(2);

      // Attempt 3: consumes 3 (all attempts consumed)
      const att3 = await orchestrator.correlateWithBrickken(
        att2.run.id,
        att2.run.revision,
      );
      expect(att3.result.outcome).toBe("TEMPORARILY_NOT_FOUND");
      expect(sendCalls).toBe(3);
      expect(att3.run.operations[0].brickkenCorrelation?.attempts).toHaveLength(3);
      expect(att3.run.operations[0].stage).toBe("BRICKKEN_CORRELATION_PENDING");

      // Attempt 4: budget exhausted => NO 4th external call, stage remains BRICKKEN_CORRELATION_PENDING,
      // run.status = RECONCILIATION_REQUIRED, event RECORD_BRICKKEN_CORRELATION_RETRY_EXHAUSTED
      const att4 = await orchestrator.correlateWithBrickken(
        att3.run.id,
        att3.run.revision,
      );

      expect(sendCalls).toBe(3); // NO external call made!
      expect(att4.result.outcome).toBe("RETRY_BUDGET_EXHAUSTED");
      expect(att4.result.reconciliationRequired).toBe(true);
      expect(att4.result.retryable).toBe(false);
      expect(att4.run.status).toBe("RECONCILIATION_REQUIRED");
      expect(att4.run.operations[0].stage).toBe("BRICKKEN_CORRELATION_PENDING"); // NOT REFUSED
      expect(att4.run.operations[0].brickkenCorrelation?.lifecycle).toBe("PENDING");
      expect(att4.run.operations[0].brickkenCorrelation?.pair.txHash).toBe(TX_HASH);
      expect(att4.run.events.at(-1)?.type).toBe(
        "RECORD_BRICKKEN_CORRELATION_RETRY_EXHAUSTED",
      );
    });

    it("records CORRELATION_REFUSED on actual Brickken 4xx refusal response and verifies FIX 1 requirements", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      h.correlationSender.response = {
        status: 400,
        data: {
          error: "Account license revoked or invalid operation",
        },
      };

      const { result, run: refusedRun } = await h.v4.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );

      // 1. broadcast txHash + CORRELATION_REFUSED => RECONCILIATION_REQUIRED
      expect(result.outcome).toBe("CORRELATION_REFUSED");
      expect(result.reconciliationRequired).toBe(true);
      expect(refusedRun.status).toBe("RECONCILIATION_REQUIRED");
      expect(refusedRun.events.at(-1)?.type).toBe(
        "RECORD_BRICKKEN_CORRELATION_REFUSED",
      );

      // 2. terminalOutcome remains null (not FAILED, not TERMINAL_EXCEPTION)
      expect(refusedRun.terminalOutcome).toBeNull();

      // Preserved durable identities
      const activeAttempt = refusedRun.operations[0].preparationAttempts.find(
        (a) => a.attemptId === refusedRun.operations[0].activePreparationAttemptId,
      );
      expect(activeAttempt?.txId).toBe("brickken-tx-1");
      expect(refusedRun.operations[0].blockchainTxHash).toBe(TX_HASH);
      expect(refusedRun.operations[0].rpcTransactionEvidence).not.toBeNull();

      // 3. RPC receipt/finality tracking remains permitted
      h.fakeRpcTransport.on("eth_getTransactionReceipt", () => ({
        transactionHash: TX_HASH,
        transactionIndex: "0x0",
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        from: TOKENIZER_ADDRESS,
        to: TO,
        cumulativeGasUsed: "0x50",
        gasUsed: "0x50",
        effectiveGasPrice: "0x15",
        contractAddress: null,
        type: "0x2",
        status: "0x1",
        logs: [],
      }));

      const { evaluation: receiptEval, run: finalityRun } =
        await h.v4.evaluateAndRecordReceiptFinality(
          refusedRun.id,
          refusedRun.revision,
        );
      expect(receiptEval.receiptStatus).toBe("SUCCESS");
      expect(finalityRun.operations[0].transactionReceiptEvidence).not.toBeNull();
      // Status remains RECONCILIATION_REQUIRED and terminalOutcome null
      expect(finalityRun.status).toBe("RECONCILIATION_REQUIRED");
      expect(finalityRun.terminalOutcome).toBeNull();

      // 4. Wallet resend remains permanently forbidden
      await expect(
        h.v4.releaseSendAuthority(finalityRun.id, finalityRun.revision),
      ).rejects.toThrow(IllegalStateTransitionError);
      await expect(
        h.v4.recordWalletPrompt(finalityRun.id, finalityRun.revision),
      ).rejects.toThrow();

      // 5. Next operation remains forbidden (cannot advance phase or stage)
      expect(finalityRun.phase).toBe("TOKENIZATION");
      expect(finalityRun.operations[0].stage).toBe("BRICKKEN_CORRELATION_PENDING");

      // 6. Refusal never authorizes a replacement transaction/run automatically
      await expect(
        h.v4.beginReprepare(finalityRun.id, finalityRun.revision),
      ).rejects.toThrow(IllegalStateTransitionError);
      expect(finalityRun.operations[0].preparationAttempts).toHaveLength(1);

      // Further correlation call does NOT make another external call and returns non-retryable refusal
      const callCountBefore = h.correlationSender.calls.length;
      const secondCorrelation = await h.v4.correlateWithBrickken(
        finalityRun.id,
        finalityRun.revision,
      );
      expect(secondCorrelation.result.outcome).toBe("CORRELATION_REFUSED");
      expect(secondCorrelation.result.retryable).toBe(false);
      expect(h.correlationSender.calls.length).toBe(callCountBefore);
    });

    it("if fee policy was violated on chain, correlation is permitted but run remains RECONCILIATION_REQUIRED", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );
      const broadcastRun = await h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });

      // Fee policy violated on chain (maxFee 0x30 > cap 0x20)
      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x30",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      const { run: feeViolationRun } = await h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );
      expect(feeViolationRun.status).toBe("RECONCILIATION_REQUIRED");
      expect(feeViolationRun.operations[0].stage).toBe("POLICY_VIOLATION_ONCHAIN");

      // Now correlate
      h.correlationSender.response = {
        status: 202,
        data: CORRELATION_SUCCESS_DATA,
      };

      const { result, run: correlatedFeeRun } = await h.v4.correlateWithBrickken(
        feeViolationRun.id,
        feeViolationRun.revision,
      );

      expect(result.outcome).toBe("CORRELATED_PENDING");
      expect(correlatedFeeRun.operations[0].stage).toBe("BRICKKEN_CORRELATED");
      // Critical check: run status must remain RECONCILIATION_REQUIRED
      expect(correlatedFeeRun.status).toBe("RECONCILIATION_REQUIRED");

      // Automatic progression to next operation (e.g. WHITELIST) remains forbidden
      await expect(
        h.v4.releaseSendAuthority(
          correlatedFeeRun.id,
          correlatedFeeRun.revision,
        ),
      ).rejects.toThrow();
    });

    it("proves correlation attempt CAS occurs BEFORE external sender.send() is called", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      let runStateAtSendTime: ExecutionRunV4 | null = null;
      const customSender: BrickkenCorrelationSender = {
        async send() {
          runStateAtSendTime = (await h.repository.getById(verifiedRun.id)) as ExecutionRunV4;
          return {
            status: 202,
            data: CORRELATION_SUCCESS_DATA,
          };
        },
      };

      const orchestrator = new ExecutionV4Orchestrator({
        repository: h.repository,
        rpc: h.rpc,
        clock: h.clock,
        ids: h.ids,
        semanticAuthorization: h.semanticAuth,
        brickkenCorrelationSender: customSender,
      });

      await orchestrator.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(runStateAtSendTime).not.toBeNull();
      expect(runStateAtSendTime!.operations[0].stage).toBe("BRICKKEN_CORRELATION_PENDING");
      expect(runStateAtSendTime!.operations[0].brickkenCorrelation?.attempts).toHaveLength(1);
      expect(runStateAtSendTime!.operations[0].brickkenCorrelation?.attempts[0].result).toBe("AUTHORIZED");
    });

    it("records CORRELATION_UNCONFIRMED on 5xx or transport failure and exhausts budget after 3 attempts", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      let sendCount = 0;
      const customSender: BrickkenCorrelationSender = {
        async send() {
          sendCount += 1;
          return {
            status: 503,
            data: { message: "Service temporarily unavailable" },
          };
        },
      };

      const orchestrator = new ExecutionV4Orchestrator({
        repository: h.repository,
        rpc: h.rpc,
        clock: h.clock,
        ids: h.ids,
        semanticAuthorization: h.semanticAuth,
        brickkenCorrelationSender: customSender,
      });

      const att1 = await orchestrator.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );
      expect(att1.result.outcome).toBe("CORRELATION_UNCONFIRMED");
      expect(att1.run.operations[0].stage).toBe("BRICKKEN_CORRELATION_PENDING");

      const att2 = await orchestrator.correlateWithBrickken(
        att1.run.id,
        att1.run.revision,
      );
      expect(att2.result.outcome).toBe("CORRELATION_UNCONFIRMED");

      const att3 = await orchestrator.correlateWithBrickken(
        att2.run.id,
        att2.run.revision,
      );
      expect(att3.result.outcome).toBe("CORRELATION_UNCONFIRMED");
      expect(sendCount).toBe(3);

      // Attempt 4: exhausts budget, no 4th send call
      const att4 = await orchestrator.correlateWithBrickken(
        att3.run.id,
        att3.run.revision,
      );
      expect(sendCount).toBe(3);
      expect(att4.result.outcome).toBe("RETRY_BUDGET_EXHAUSTED");
      expect(att4.result.outcome).not.toBe("CORRELATION_REFUSED");
      expect(att4.run.status).toBe("RECONCILIATION_REQUIRED");
      expect(att4.run.terminalOutcome).toBeNull();
      expect(att4.run.operations[0].stage).toBe("BRICKKEN_CORRELATION_PENDING");
      expect(att4.run.operations[0].brickkenCorrelation?.pair.txId).toBe(
        verifiedRun.operations[0].preparedTxId,
      );
      expect(att4.run.operations[0].brickkenCorrelation?.pair.txHash).toBe(TX_HASH);
      expect(att4.run.events.at(-1)?.type).toBe(
        "RECORD_BRICKKEN_CORRELATION_RETRY_EXHAUSTED",
      );
    });

    it("records PREPARED_TRANSACTION_MISMATCH and sets RECONCILIATION_REQUIRED", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      h.correlationSender.response = {
        status: 409,
        data: {
          code: "PREPARED_TRANSACTION_MISMATCH",
          message: BRICKKEN_NONCE_MISMATCH_STRING,
        },
      };

      const { result, run: mismatchRun } = await h.v4.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(result.outcome).toBe("PREPARED_TRANSACTION_MISMATCH");
      expect(result.reconciliationRequired).toBe(true);
      expect(mismatchRun.status).toBe("RECONCILIATION_REQUIRED");
    });

    it("records CORRELATION_CONTRADICTION when returned hash differs and sets RECONCILIATION_REQUIRED", async () => {
      const h = createHarness();
      const { run: verifiedRun } = await setupVerifiedRun(h);

      const contradictoryHash = `0x${"88".repeat(32)}`;
      h.correlationSender.response = {
        status: 202,
        data: {
          results: [
            {
              success: true,
              result: {
                status: "pending",
                executionMode: "client-broadcast",
                transactionHash: contradictoryHash,
              },
            },
          ],
        },
      };

      const { result, run: contradictionRun } = await h.v4.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );

      expect(result.outcome).toBe("CORRELATION_CONTRADICTION");
      expect(result.reconciliationRequired).toBe(true);
      expect(contradictionRun.status).toBe("RECONCILIATION_REQUIRED");
    });
  });

  describe("Part K: Brickken Status Service", () => {
    async function setupCorrelatedRun(h: ReturnType<typeof createHarness>) {
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );
      const broadcastRun = await h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      const { run: verifiedRun } = await h.v4.verifyOnchainTransaction(
        broadcastRun.id,
        broadcastRun.revision,
      );

      h.correlationSender.response = {
        status: 202,
        data: CORRELATION_SUCCESS_DATA,
      };

      const { run: correlatedRun } = await h.v4.correlateWithBrickken(
        verifiedRun.id,
        verifiedRun.revision,
      );

      return correlatedRun;
    }

    it("records structural durable evidence and does not advance on raw 'success'", async () => {
      const h = createHarness();
      const correlatedRun = await setupCorrelatedRun(h);

      h.statusFetcher.response = {
        status: 200,
        data: {
          status: "success",
          transactionHash: TX_HASH,
        },
      };

      const { statusResult, durableEvidence, run: statusRecordedRun } =
        await h.v4.checkBrickkenStatus(
          correlatedRun.id,
          correlatedRun.revision,
        );

      expect(statusResult.rawStatusText).toBe("success");
      expect(durableEvidence.structuralClassification).toBe("HASH_CONFIRMED");
      expect(durableEvidence.confirmedTxHash).toBe(TX_HASH);
      expect(durableEvidence.rawStatusText).toBe("success");

      // Stage does NOT advance past BRICKKEN_CORRELATED
      expect(statusRecordedRun.operations[0].stage).toBe("BRICKKEN_CORRELATED");
      expect(statusRecordedRun.operations[0].brickkenStatusEvidence).toHaveLength(1);
    });

    it("detects STATUS_CONTRADICTION when returned hash differs from expectedTxHash and sets RECONCILIATION_REQUIRED", async () => {
      const h = createHarness();
      const correlatedRun = await setupCorrelatedRun(h);

      const DIFFERENT_HASH = `0x${"99".repeat(32)}`;
      h.statusFetcher.response = {
        status: 200,
        data: {
          status: "success",
          transactionHash: DIFFERENT_HASH,
        },
      };

      const { statusResult, durableEvidence, run: contradictionRun } =
        await h.v4.checkBrickkenStatus(
          correlatedRun.id,
          correlatedRun.revision,
        );

      expect(durableEvidence.structuralClassification).toBe("STRUCTURAL_ONLY");
      expect(contradictionRun.status).toBe("RECONCILIATION_REQUIRED");
      expect(statusResult.diagnosticError).toBe("STATUS_CONTRADICTION");
    });

    it("retains raw 'rejected' as evidence without granting it lifecycle authority", async () => {
      const h = createHarness();
      const correlatedRun = await setupCorrelatedRun(h);

      h.statusFetcher.response = {
        status: 200,
        data: {
          status: "rejected",
          transactionHash: TX_HASH,
        },
      };

      const { durableEvidence, run: rejectedStatusRun } =
        await h.v4.checkBrickkenStatus(
          correlatedRun.id,
          correlatedRun.revision,
        );

      expect(durableEvidence.rawStatusText).toBe("rejected");
      expect(rejectedStatusRun.status).toBe("CONFIRMING");
      expect(rejectedStatusRun.operations[0].stage).toBe("BRICKKEN_CORRELATED");
      expect(rejectedStatusRun.terminalOutcome).toBeNull();
    });
  });

  describe("Part M: Public Projection Verification", () => {
    it("projects V4 runs cleanly without leaking fee caps, raw errors, or audit traces", async () => {
      const h = createHarness();
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );

      const publicProj = await projectPublicRun(v4Run);

      expect(publicProj.schemaVersion).toBe("4.0");
      expect(publicProj.operations[0].stage).toBe("PREPARED");
      expect(publicProj.operations[0].preparedTxId).toBe("brickken-tx-1");

      // Verify no secret or internal fields are leaked
      const json = JSON.stringify(publicProj);
      expect(json).not.toContain("preparationAttempts");
      expect(json).not.toContain("authorizedCaps");
      expect(json).not.toContain("events");
      expect(json).not.toContain("privateKey");
    });
  });

  describe("Part N: Post-Broadcast Tracking Pipeline (trackExecution)", () => {
    async function setupBroadcastRun(h: ReturnType<typeof createHarness>) {
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );
      return h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });
    }

    it("returns NOT_FOUND without revision churn when tx is not observed on RPC", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => null);

      const result = await h.v4.trackExecution(
        broadcastRun.id,
        broadcastRun.revision,
      );

      expect(result.rpcEvaluation?.presence).toBe("NOT_FOUND");
      expect(result.run.revision).toBe(broadcastRun.revision); // Zero churn
      expect(result.run.operations[0].stage).toBe("BROADCAST_HASH_PERSISTED");
    });

    it("advances full post-broadcast pipeline: RPC verify -> receipt -> correlate -> status", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: FINALIZED_BLOCK_HASH,
        blockNumber: "0x20",
        transactionIndex: "0x0",
      }));

      h.fakeRpcTransport.on("eth_getBlockByNumber", (params) => {
        const tag = params?.[0];
        if (tag === "finalized" || tag === "0x20") {
          return {
            number: "0x20",
            hash: FINALIZED_BLOCK_HASH,
            parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
            baseFeePerGas: "0x10",
          };
        }
        return {
          number: "0x10",
          hash: BLOCK_HASH,
          parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          baseFeePerGas: "0x10",
        };
      });

      h.fakeRpcTransport.on("eth_getTransactionReceipt", () => ({
        transactionHash: TX_HASH,
        blockHash: FINALIZED_BLOCK_HASH,
        blockNumber: "0x20",
        transactionIndex: "0x0",
        from: TOKENIZER_ADDRESS,
        to: TO,
        cumulativeGasUsed: "0x50",
        gasUsed: "0x50",
        effectiveGasPrice: "0x15",
        contractAddress: null,
        type: "0x2",
        status: "0x1",
        logs: [],
      }));

      h.correlationSender.response = {
        status: 202,
        data: CORRELATION_SUCCESS_DATA,
      };

      h.statusFetcher.response = {
        status: 200,
        data: {
          status: "success",
          transactionHash: TX_HASH,
        },
      };

      const result = await h.v4.trackExecution(
        broadcastRun.id,
        broadcastRun.revision,
      );

      const op = result.run.operations[0];
      expect(op.stage).toBe("BRICKKEN_CORRELATED");
      expect(op.rpcTransactionEvidence?.immutableIdentityStatus).toBe("MATCH");
      expect(op.transactionReceiptEvidence?.finalityStatus).toBe("FINALIZED");
      expect(op.transactionReceiptEvidence?.executionStatus).toBe("SUCCESS");
      expect(op.brickkenCorrelation?.lifecycle).toBe("CORRELATED");
      expect(op.brickkenStatus).toBe("success");
      expect(result.run.status).toBe("CONFIRMING");
      expect(result.run.terminalOutcome).toBeNull();

      // Idempotency: subsequent tracking on already finalized/correlated run has ZERO revision churn
      const repeated = await h.v4.trackExecution(
        result.run.id,
        result.run.revision,
      );
      expect(repeated.run.revision).toBe(result.run.revision);
    });

    it("handles status contradiction during tracking and marks RECONCILIATION_REQUIRED", async () => {
      const h = createHarness();
      const broadcastRun = await setupBroadcastRun(h);

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: BLOCK_HASH,
        blockNumber: "0x10",
        transactionIndex: "0x0",
      }));

      h.fakeRpcTransport.on("eth_getTransactionReceipt", () => null);

      h.correlationSender.response = {
        status: 202,
        data: CORRELATION_SUCCESS_DATA,
      };

      // Status response returns a CONTRADICTING hash
      const CONTRADICTING_HASH = "0x" + "9".repeat(64);
      h.statusFetcher.response = {
        status: 200,
        data: {
          status: "success",
          transactionHash: CONTRADICTING_HASH,
        },
      };

      const result = await h.v4.trackExecution(
        broadcastRun.id,
        broadcastRun.revision,
      );

      expect(result.run.status).toBe("RECONCILIATION_REQUIRED");
      expect(result.run.terminalOutcome).toBeNull(); // Terminal outcome not set
      expect(
        result.run.events.some(
          (e) => e.type === "RECORD_BRICKKEN_STATUS_CONTRADICTION",
        ),
      ).toBe(true);
    });
  });

  describe("Part O: Token Read-Back and Terminal Read Protection", () => {
    async function setupFinalizedCorrelatedRun(
      h: ReturnType<typeof createHarness>,
      rawStatus: "pending" | "success" | "rejected" = "success",
    ) {
      const runV2 = await createPreparedV2Run(h);
      const v4Run = await h.v4.promotePreparedRunToV4(
        runV2.id,
        runV2.revision,
      );
      const promptRun = await h.v4.recordWalletPrompt(
        v4Run.id,
        v4Run.revision,
      );
      const { envelope, run: releasedRun } = await h.v4.releaseSendAuthority(
        promptRun.id,
        promptRun.revision,
      );
      const broadcastRun = await h.v4.ingestBroadcastHash(releasedRun.id, {
        expectedRevision: releasedRun.revision,
        invocationAttemptId: envelope.invocationAttemptId,
        walletIntentHash: envelope.walletIntentHash,
        txHash: TX_HASH,
      });

      h.fakeRpcTransport.on("eth_getTransactionByHash", () => ({
        hash: TX_HASH,
        chainId: "0xaa36a7",
        from: TOKENIZER_ADDRESS,
        to: TO,
        input: "0x12345678aabb",
        value: "0x0",
        nonce: "0x5",
        type: "0x2",
        gas: "0x100",
        gasPrice: null,
        maxFeePerGas: "0x20",
        maxPriorityFeePerGas: "0x4",
        accessList: [],
        blockHash: FINALIZED_BLOCK_HASH,
        blockNumber: "0x20",
        transactionIndex: "0x0",
      }));

      h.fakeRpcTransport.on("eth_getBlockByNumber", (params) => {
        const tag = params?.[0];
        if (tag === "finalized" || tag === "0x20") {
          return {
            number: "0x20",
            hash: FINALIZED_BLOCK_HASH,
            parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
            baseFeePerGas: "0x10",
          };
        }
        return {
          number: "0x10",
          hash: BLOCK_HASH,
          parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          baseFeePerGas: "0x10",
        };
      });

      h.fakeRpcTransport.on("eth_getTransactionReceipt", () => ({
        transactionHash: TX_HASH,
        blockHash: FINALIZED_BLOCK_HASH,
        blockNumber: "0x20",
        transactionIndex: "0x0",
        from: TOKENIZER_ADDRESS,
        to: TO,
        cumulativeGasUsed: "0x50",
        gasUsed: "0x50",
        effectiveGasPrice: "0x15",
        contractAddress: null,
        type: "0x2",
        status: "0x1",
        logs: [],
      }));

      h.correlationSender.response = {
        status: 202,
        data: CORRELATION_SUCCESS_DATA,
      };

      h.statusFetcher.response = {
        status: 200,
        data: {
          status: rawStatus,
          transactionHash: TX_HASH,
        },
      };

      const tracked = await h.v4.trackExecution(
        broadcastRun.id,
        broadcastRun.revision,
      );

      return tracked.run;
    }

    it("rejects untrusted caller-supplied token address and prevents creating TokenIdentityV1", async () => {
      const h = createHarness();
      const run = await setupFinalizedCorrelatedRun(h);

      const untrustedInput = {
        chainId: "11155111" as const,
        tokenAddress: "0x4444444444444444444444444444444444444444",
        tokenSymbol: run.manifest.asset.symbol,
        tokenizerWalletAddress: run.requiredSigner.walletAddress,
        tokenizationTxHash: TX_HASH,
        manifestHash: run.manifestHash,
        planHash: run.planHash,
        verifiedAt: "2026-09-12T12:00:00.000Z",
        readBackEvidenceHash: "sha256:" + "b".repeat(64),
      };

      await expect(
        h.v4.recordTokenIdentityFromReadBack(run.id, run.revision, untrustedInput),
      ).rejects.toThrow(OrchestrationError);

      // Verify the run has NOT advanced to WHITELIST and tokenIdentity remains null
      const current = (await h.repository.getById(run.id)) as ExecutionRunV4;
      expect(current.phase).toBe("TOKENIZATION");
      expect(current.tokenIdentity).toBeNull();
      expect(current.operations[0].stage).toBe("BRICKKEN_CORRELATED");
      expect(current.operations[1].stage).toBe("NOT_STARTED");
      expect(current.operations[2].stage).toBe("NOT_STARTED");
    });

    it("refuses candidate token identity when read-back cannot bind it to this finalized transaction", async () => {
      const h = createHarness({ readBack: true });
      await expect(setupFinalizedCorrelatedRun(h, "rejected")).rejects.toMatchObject({
        code: "READ_BACK_BINDING_UNRESOLVED",
      });
      const run = (await h.repository.getById(
        "11111111-1111-4111-8111-111111111111",
      )) as ExecutionRunV4;
      expect(run.phase).toBe("TOKENIZATION");
      expect(run.operations[0].stage).toBe("BRICKKEN_CORRELATED");
      expect(run.tokenIdentity).toBeNull();
      expect(h.readBack.tokenCalls).toBe(1);
      expect(h.readBack.tokenizerCalls).toBe(1);
    });

    it("fails closed when authoritative tokenizer identity mismatches the approved signer", async () => {
      const h = createHarness({ readBack: true });
      h.readBack.walletAddress = "0x5555555555555555555555555555555555555555";

      await expect(setupFinalizedCorrelatedRun(h)).rejects.toThrow(OrchestrationError);
      const durable = (await h.repository.getById(
        "11111111-1111-4111-8111-111111111111",
      )) as ExecutionRunV4;
      expect(durable.phase).toBe("TOKENIZATION");
      expect(durable.tokenIdentity).toBeNull();
      expect(durable.operations[0].stage).toBe("BRICKKEN_CORRELATED");
    });
  });
});
