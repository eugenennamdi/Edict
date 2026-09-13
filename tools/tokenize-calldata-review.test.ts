import { readFileSync } from "node:fs";
import { sha256Utf8, validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionRunService,
  RepositoryNotFoundError,
  upgradePreparedRunToV4,
  type Clock,
  type ExecutionRun,
  type IdGenerator,
} from "@/server/execution";
import { InMemoryExecutionRunRepository } from "@/server/execution/repository";
import { createApprovalProofFixture } from "@/server/execution/test-fixtures";
import {
  projectTokenizeCalldataReview,
  runTokenizeCalldataReviewMain,
} from "./tokenize-calldata-review";

const DATA = "0xf3d02cfd" + "00".repeat(32);
const TO = "0x23b04b6410d72fa66a77a9e0146df6634ad4c462";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

async function preparedV2(): Promise<ExecutionRun> {
  const repository = new InMemoryExecutionRunRepository();
  let sequence = 0;
  const ids: IdGenerator = {
    runId: () => RUN_ID,
    operationId: () => `operation-${++sequence}`,
    eventId: () => `event-${++sequence}`,
    invocationAttemptId: () => `invocation-${++sequence}`,
  };
  const clock: Clock = { nowIso: () => "2026-09-12T12:00:00.000Z" };
  const service = new ExecutionRunService({ repository, ids, clock });
  const validated = validateAssetManifestV1(createValidRawManifest());
  if (!validated.ok) throw new Error("fixture");
  const created = await service.createRun(validated.value);
  const proof = createApprovalProofFixture(created, "2026-09-12T12:00:00.000Z");
  const approved = await service.approvePlan(created.id, created.revision, {
    planHash: created.planHash,
    approvedByWallet: created.requiredSigner.walletAddress,
    proof,
  });
  const intent = await service.beginPrepare(approved.id, approved.revision, "TOKENIZE");
  return service.recordPrepared(intent.id, intent.revision, "TOKENIZE", {
    txId: "brickken-tx-1",
    unsignedTransaction: {
      from: approved.requiredSigner.walletAddress,
      to: TO,
      data: DATA,
      value: "0x0",
      nonce: "0x1",
      chainId: "0xaa36a7",
      type: "0x2",
      gasLimit: "0x5208",
      maxFeePerGas: "0x20",
      maxPriorityFeePerGas: "0x2",
    },
  });
}

describe("TOKENIZE calldata review", () => {
  it("projects only the operator-safe durable V2 identifiers and commitment", async () => {
    const prepared = await preparedV2();
    await expect(projectTokenizeCalldataReview(prepared)).resolves.toEqual({
      runId: prepared.id,
      schemaVersion: "2.0",
      revision: prepared.revision,
      txId: "brickken-tx-1",
      destination: TO,
      selector: "0xf3d02cfd",
      calldataCommitment: await sha256Utf8(DATA),
    });
  });

  it("supports the canonical promoted V4 PREPARED shape", async () => {
    const prepared = await preparedV2();
    const v4 = await upgradePreparedRunToV4(prepared, "TOKENIZE", {
      attemptId: "attempt-1",
      freshnessPolicyVersion: "edict-freshness-v1",
    });
    await expect(projectTokenizeCalldataReview(v4)).resolves.toMatchObject({
      runId: RUN_ID,
      schemaVersion: "4.0",
      revision: 4,
      txId: "brickken-tx-1",
      destination: TO,
      selector: "0xf3d02cfd",
    });
  });

  it("distinguishes terminal failure from uncertain preparation", async () => {
    const prepared = await preparedV2();
    const terminal = {
      ...prepared,
      status: "FAILED",
      terminalOutcome: "FAILED",
      operations: [
        { ...prepared.operations[0], stage: "PREPARE_UNKNOWN", preparedTxId: null, unsignedTransaction: null },
        prepared.operations[1],
        prepared.operations[2],
      ],
    } as ExecutionRun;
    const uncertain = {
      ...terminal,
      status: "RECONCILIATION_REQUIRED",
      terminalOutcome: null,
    } as ExecutionRun;
    await expect(projectTokenizeCalldataReview(terminal)).rejects.toMatchObject({
      code: "PREPARATION_FAILED",
    });
    await expect(projectTokenizeCalldataReview(uncertain)).rejects.toMatchObject({
      code: "PREPARATION_UNCERTAIN",
    });
  });

  it("CLI emits bounded stderr, hides caught details, and calls only getById", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const secret = "postgres://operator:secret@example.invalid/database";
    const repository = {
      getById: vi.fn(async () => {
        const error = new RepositoryNotFoundError();
        Object.defineProperty(error, "detail", { value: secret });
        throw error;
      }),
      create: vi.fn(),
      update: vi.fn(),
    };
    await expect(runTokenizeCalldataReviewMain(
      ["node", "tool", RUN_ID],
      stdout,
      stderr,
      repository,
    )).resolves.toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("RUN_NOT_FOUND\n");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(secret);
    expect(repository.getById).toHaveBeenCalledExactlyOnceWith(RUN_ID);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("CLI prints valid V2 review and its package script loads .env.local", async () => {
    const prepared = await preparedV2();
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runTokenizeCalldataReviewMain(
      ["node", "tool", RUN_ID],
      stdout,
      stderr,
      { getById: vi.fn(async () => prepared) },
    )).resolves.toBe(0);
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      runId: RUN_ID,
      schemaVersion: "2.0",
      revision: 4,
      txId: "brickken-tx-1",
      destination: TO,
      selector: "0xf3d02cfd",
    });
    expect(stderr).not.toHaveBeenCalled();
    const scripts = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).scripts;
    expect(scripts["review:tokenize-calldata"]).toContain("--env-file-if-exists=.env.local");
  });

  it("CLI reports missing database configuration without attempting any external adapter", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    vi.stubEnv("DATABASE_URL", "");
    try {
      await expect(runTokenizeCalldataReviewMain(
        ["node", "tool", RUN_ID],
        stdout,
        stderr,
      )).resolves.toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("DATABASE_CONFIG_MISSING\n");
    const source = readFileSync(new URL("tokenize-calldata-review.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createBrickken|eth_sendTransaction|send-transactions|prepareTokenization|EDICT_SEPOLIA_RPC_URL/u);
  });
});
