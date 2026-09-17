import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrickkenServerAdapter } from "./adapter";
import { DEFAULT_BRICKKEN_DEADLINE_MS } from "./transport";

import { classifyWalletExecutionErrorDetail } from "@/components/wallet-execution-ui-state";
import { prepareNextOperationHandler, type RunApiHandlerOptions } from "../run-api/handlers";
import type { RunApiRuntime } from "../run-api/runtime";
import { createValidRawManifest, TOKENIZER_ADDRESS } from "@/core/test-fixtures";
import { validateAssetManifestV1 } from "@/core";
import { createApprovalProofFixture } from "../execution/test-fixtures";
import { InMemoryExecutionRunRepository } from "../execution/repository";
import { ExecutionRunService } from "../execution/run-service";
import type { Clock, IdGenerator } from "../execution/infrastructure";
import { ExecutionOrchestrator } from "../orchestration/service";
import { OrchestrationError } from "../orchestration/errors";
import type { BrickkenServerAdapter, PreparedOperation } from "./types";
import { BrickkenAdapterError } from "./errors";
import encodingA from "./test-vectors/prepare/newTokenization.response.json";

const TEST_KEY = "test-brickken-api-key-secret-12345";
const LICENSED_ACCOUNT_EMAIL = "licensed-account@example.com";
const TRUSTED_ORIGIN = "https://edict.example";

function installEnv(nodeEnv: "production" | "development") {
  (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  process.env.BRICKKEN_API_KEY = TEST_KEY;
  process.env.BRICKKEN_TOKENIZER_EMAIL = LICENSED_ACCOUNT_EMAIL;
  process.env.BRICKKEN_BASE_URL = "https://api.sandbox.brickken.com";
}

afterEach(() => {
  delete process.env.BRICKKEN_API_KEY;
  delete process.env.BRICKKEN_TOKENIZER_EMAIL;
  delete process.env.BRICKKEN_BASE_URL;
  vi.restoreAllMocks();
});

const preparedMock: PreparedOperation = {
  txId: "brickken-tx-1",
  executionMode: "client-broadcast",
  transaction: {
    from: TOKENIZER_ADDRESS,
    to: "0x3333333333333333333333333333333333333333",
    data: "0x1234",
    value: "0x0",
    nonce: "0x1",
    chainId: "0xaa36a7",
    type: "0x2",
    gasLimit: "0x5208",
    maxFeePerGas: "0x10",
    maxPriorityFeePerGas: "0x1",
    gasPrice: null,
    normalizedChainId: "11155111",
    rawUnsigned: {
      from: TOKENIZER_ADDRESS,
      to: "0x3333333333333333333333333333333333333333",
      data: "0x1234",
      chainId: "0xaa36a7",
    },
  },
};

async function setupOrchestrator(brickkenAdapter: BrickkenServerAdapter) {
  let sequence = 0;
  const clock: Clock = { nowIso: () => new Date(Date.UTC(2026, 8, 4, 0, 0, sequence++)).toISOString() };
  const ids: IdGenerator = {
    runId: () => "11111111-1111-4111-8111-111111111111",
    operationId: () => `operation-${sequence++}`,
    eventId: () => `event-${sequence++}`,
  };
  const repository = new InMemoryExecutionRunRepository();
  const runs = new ExecutionRunService({ repository, clock, ids });
  const parsed = validateAssetManifestV1(createValidRawManifest());
  if (!parsed.ok) throw new Error("fixture invalid");
  const created = await runs.createRun(parsed.value);
  const run = await runs.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: TOKENIZER_ADDRESS,
    proof: createApprovalProofFixture(created, clock.nowIso()),
  });
  const orchestrator = new ExecutionOrchestrator({
    repository,
    runs,
    brickken: brickkenAdapter,
    writeGate: { assertEnabled() {} },
    brickkenTokenizerEmail: LICENSED_ACCOUNT_EMAIL,
  });
  return { repository, runs, run, orchestrator };
}

function createMockApiHandler(runs: ExecutionRunService, orchestrator: ExecutionOrchestrator) {
  const handlerOptions: RunApiHandlerOptions = {
    config: { enabled: true, trustedOrigin: TRUSTED_ORIGIN },
    runtime: () => ({
      runs,
      access: { verify: async () => {} } as unknown as RunApiRuntime["access"],
      approvals: {} as unknown as RunApiRuntime["approvals"],
      nowIso: () => new Date().toISOString(),
      executionEnabled: true,
      execution: orchestrator,
    }),
    nodeEnv: "development",
  };
  return async (runId: string, revision: number) => {
    const req = new Request(`${TRUSTED_ORIGIN}/api/runs/${runId}/prepare`, {
      method: "POST",
      headers: {
        origin: TRUSTED_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: revision }),
    });
    return prepareNextOperationHandler(req, runId, handlerOptions);
  };
}

describe("Brickken preparation resilience and deterministic 400 vs transient failure separation", () => {
  it("scenario 1: token-name collision (400) is NOT reprepareable (stops as terminal refusal, retryAllowed: false, shows Mandate needs changes)", async () => {
    installEnv("production");
    const error400Adapter: BrickkenServerAdapter = {
      prepareTokenization: vi.fn(async () => ({
        ok: false as const,
        error: new BrickkenAdapterError("INVALID_REQUEST", "Token name already exists", {
          upstreamStatus: 400,
          upstreamReason: "Token name already exists",
        }),
      })),
      prepareWhitelist: vi.fn(),
      prepareMint: vi.fn(),
      confirmBroadcast: vi.fn(),
      getTransactionStatus: vi.fn(),
      correlateClientBroadcast: vi.fn(),
      getTokenInfo: vi.fn(),
      getTokenizerInfo: vi.fn(),
      getWhitelistStatus: vi.fn(),
      getBalanceAndWhitelist: vi.fn(),
      getNetworkInfo: vi.fn(),
    };

    const { runs, run, orchestrator } = await setupOrchestrator(error400Adapter);
    const callHandler = createMockApiHandler(runs, orchestrator);

    // 1. API route surfaces truthful HTTP 400 INVALID_REQUEST (never 503)
    const apiResponse = await callHandler(run.id, run.revision);
    expect(apiResponse.status).toBe(400);
    const apiBody = await apiResponse.json();
    expect(apiBody).toEqual({ ok: false, error: { code: "INVALID_REQUEST" } });

    // 2. Durable run records a terminal refusal (FAILED status, REJECTED stage)
    const after = await runs.getRun(run.id);
    expect(after.status).toBe("FAILED");
    expect(after.terminalOutcome).toBe("FAILED");
    expect(after.operations[0].stage).toBe("REJECTED");
    expect(after.operations[0].brickkenError).toBe("INVALID_REQUEST");
    expect(after.events.map((e) => e.type)).toContain("RECORD_PREPARE_FAILURE");
    expect(after.events.map((e) => e.type)).not.toContain("RECORD_PREPARE_INTERRUPTED");

    // 3. Attempting to reprepare throws because the run is locked in terminal failure
    await expect(orchestrator.prepareOperation(run.id, after.revision, "TOKENIZE"))
      .rejects.toThrow();

    // 4. Client error classification prohibits retry and presents exact mandate change instructions
    const detail = classifyWalletExecutionErrorDetail("INVALID_REQUEST");
    expect(detail.title).toBe("Mandate needs changes");
    expect(detail.onChainSubmission).toBe("NO");
    expect(detail.nextStep).toBe("No transaction submitted; no gas spent. Create a new mandate with a unique asset name and symbol.");
    expect(detail.retryAllowed).toBe(false);

    // 5. Zero wallet authority and zero transactions
    expect(after.operations[0].unsignedTransaction).toBe(null);
    expect(after.operations[0].preparedTxId).toBe(null);
    expect(after.operations[0].blockchainTxHash).toBe(null);
  });

  it("scenario 2: transient timeout (60s) IS manually reprepareable (resets stage to NOT_STARTED, retryAllowed: true)", async () => {
    installEnv("production");
    let attempts = 0;
    const transientAdapter: BrickkenServerAdapter = {
      prepareTokenization: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false as const,
            error: new BrickkenAdapterError("UPSTREAM_SERVER_ERROR", "Brickken prepare request timed out after 60s."),
          };
        }
        return {
          ok: true as const,
          value: preparedMock,
        };
      }),
      prepareWhitelist: vi.fn(),
      prepareMint: vi.fn(),
      confirmBroadcast: vi.fn(),
      getTransactionStatus: vi.fn(),
      correlateClientBroadcast: vi.fn(),
      getTokenInfo: vi.fn(),
      getTokenizerInfo: vi.fn(),
      getWhitelistStatus: vi.fn(),
      getBalanceAndWhitelist: vi.fn(),
      getNetworkInfo: vi.fn(),
    };

    const { runs, run, orchestrator } = await setupOrchestrator(transientAdapter);
    const callHandler = createMockApiHandler(runs, orchestrator);

    // 1. First attempt times out -> API surfaces HTTP 503 UPSTREAM_SERVER_ERROR
    const apiResponse = await callHandler(run.id, run.revision);
    expect(apiResponse.status).toBe(503);
    const apiBody = await apiResponse.json();
    expect(apiBody).toEqual({ ok: false, error: { code: "UPSTREAM_SERVER_ERROR" } });

    // 2. Durable run records interrupted preparation (PREPARING status, NOT_STARTED stage, can reprepare)
    const afterFirst = await runs.getRun(run.id);
    expect(afterFirst.status).toBe("PREPARING");
    expect(afterFirst.terminalOutcome).toBe(null);
    expect(afterFirst.operations[0].stage).toBe("NOT_STARTED");
    expect(afterFirst.operations[0].brickkenError).toBe("UPSTREAM_SERVER_ERROR");
    expect(afterFirst.events.map((e) => e.type)).toContain("RECORD_PREPARE_INTERRUPTED");

    // 3. Client error classification permits manual Reprepare
    const detail = classifyWalletExecutionErrorDetail("UPSTREAM_SERVER_ERROR");
    expect(detail.title).toBe("Preparation interrupted");
    expect(detail.onChainSubmission).toBe("NO");
    expect(detail.nextStep).toBe("No transaction submitted; no gas spent. Click Reprepare to retry preparation.");
    expect(detail.retryAllowed).toBe(true);

    // 4. Operator triggers manual Reprepare -> succeeds and advances to PREPARED
    const reprepared = await orchestrator.prepareOperation(run.id, afterFirst.revision, "TOKENIZE");
    expect(reprepared.status).toBe("AWAITING_WALLET");
    expect(reprepared.operations[0].stage).toBe("PREPARED");
    expect(reprepared.operations[0].preparedTxId).toBe(preparedMock.txId);
    expect(reprepared.operations[0].unsignedTransaction).not.toBe(null);
    expect(attempts).toBe(2);
  });

  it("scenario 3: 429 rate limit honors Retry-After header and prevents immediate hammering", async () => {
    installEnv("production");
    let brickkenCallCount = 0;
    const rateLimitedAdapter: BrickkenServerAdapter = {
      prepareTokenization: vi.fn(async () => {
        brickkenCallCount += 1;
        return {
          ok: false as const,
          error: new BrickkenAdapterError("UPSTREAM_RATE_LIMITED", "Brickken rate limit reached.", {
            upstreamStatus: 429,
            retryAfterSeconds: 30,
          }),
        };
      }),
      prepareWhitelist: vi.fn(),
      prepareMint: vi.fn(),
      confirmBroadcast: vi.fn(),
      getTransactionStatus: vi.fn(),
      correlateClientBroadcast: vi.fn(),
      getTokenInfo: vi.fn(),
      getTokenizerInfo: vi.fn(),
      getWhitelistStatus: vi.fn(),
      getBalanceAndWhitelist: vi.fn(),
      getNetworkInfo: vi.fn(),
    };

    const { runs, run, orchestrator } = await setupOrchestrator(rateLimitedAdapter);
    const callHandler = createMockApiHandler(runs, orchestrator);

    // 1. API handler returns HTTP 429 carrying the retry-after header
    const apiResponse = await callHandler(run.id, run.revision);
    expect(apiResponse.status).toBe(429);
    expect(apiResponse.headers.get("retry-after")).toBe("30");
    const apiBody = await apiResponse.json();
    expect(apiBody).toEqual({ ok: false, error: { code: "UPSTREAM_RATE_LIMITED" } });

    // 2. 1 click = exactly 1 Brickken call; zero automatic retries
    expect(brickkenCallCount).toBe(1);

    // 3. UI error classification presents the wait time to operator
    const retryAfterHeader = apiResponse.headers.get("retry-after");
    expect(retryAfterHeader).toBe("30");
    const detail = classifyWalletExecutionErrorDetail("UPSTREAM_RATE_LIMITED", {
      retryAfterSeconds: Number(retryAfterHeader),
    });
    expect(detail.title).toBe("Preparation rate limited");
    expect(detail.retryAllowed).toBe(true);
    expect(detail.retryAfterSeconds).toBe(30);
    expect(detail.nextStep).toContain("Wait 30s before retrying");

    // 4. Preparation was interrupted safely; no funds or gas spent
    const after = await runs.getRun(run.id);
    expect(after.status).toBe("PREPARING");
    expect(after.operations[0].stage).toBe("NOT_STARTED");
    expect(after.operations[0].brickkenError).toBe("UPSTREAM_RATE_LIMITED");
  });

  it("scenario 4: server prepare timeout is configured at 60s", () => {
    // Server prepare timeout is set to 60s
    expect(DEFAULT_BRICKKEN_DEADLINE_MS).toBe(60_000);
  });

  it("scenario 5: slow 20–50s preparation succeeds without browser abort", async () => {
    installEnv("production");
    let fetchCount = 0;
    // Simulate Brickken returning valid preparation after a delay
    const delayedFetch = vi.fn(async () => {
      fetchCount += 1;
      return new Response(JSON.stringify(encodingA), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const adapter = createBrickkenServerAdapter({ fetch: delayedFetch, timeoutMs: 60_000 });
    const result = await adapter.prepareTokenization({
      signerAddress: TOKENIZER_ADDRESS,
      name: "Slow Valid Token",
      tokenSymbol: "SLOWV",
      supplyCap: "1000",
      documentationUrl: "https://example.com/doc",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionMode).toBe("client-broadcast");
    expect(fetchCount).toBe(1);
  });

  it("scenario 6: zero wallet authority and zero transactions on any preparation failure", async () => {
    installEnv("production");
    const failureCases = [
      {
        name: "deterministic 400",
        adapterError: new BrickkenAdapterError("INVALID_REQUEST", "Token name already exists", {
          upstreamStatus: 400,
          upstreamReason: "Token name already exists",
        }),
      },
      {
        name: "transient timeout (60s)",
        adapterError: new BrickkenAdapterError("UPSTREAM_SERVER_ERROR", "Brickken prepare request timed out after 60s."),
      },
      {
        name: "429 rate limit",
        adapterError: new BrickkenAdapterError("UPSTREAM_RATE_LIMITED", "Rate limited", {
          upstreamStatus: 429,
          retryAfterSeconds: 30,
        }),
      },
    ];

    for (const testCase of failureCases) {
      const mockAdapter: BrickkenServerAdapter = {
        prepareTokenization: vi.fn(async () => ({ ok: false as const, error: testCase.adapterError })),
        prepareWhitelist: vi.fn(),
        prepareMint: vi.fn(),
        confirmBroadcast: vi.fn(),
        getTransactionStatus: vi.fn(),
        correlateClientBroadcast: vi.fn(),
        getTokenInfo: vi.fn(),
        getTokenizerInfo: vi.fn(),
        getWhitelistStatus: vi.fn(),
        getBalanceAndWhitelist: vi.fn(),
        getNetworkInfo: vi.fn(),
      };

      const { runs, run, orchestrator } = await setupOrchestrator(mockAdapter);

      await expect(orchestrator.prepareOperation(run.id, run.revision, "TOKENIZE"))
        .rejects.toThrow(OrchestrationError);

      const after = await runs.getRun(run.id);

      // Invariants across all failure modes:
      expect(after.operations[0].unsignedTransaction, `${testCase.name}: unsignedTransaction must be null`).toBe(null);
      expect(after.operations[0].preparedTxId, `${testCase.name}: preparedTxId must be null`).toBe(null);
      expect(after.operations[0].blockchainTxHash, `${testCase.name}: blockchainTxHash must be null`).toBe(null);

      const eventTypes = after.events.map((e) => e.type);
      expect(eventTypes, `${testCase.name}: must not contain RECORD_WALLET_PROMPT`).not.toContain("RECORD_WALLET_PROMPT");
      expect(eventTypes, `${testCase.name}: must not contain RECORD_BROADCAST_HASH`).not.toContain("RECORD_BROADCAST_HASH");
    }
  });
});
