import { sha256Utf8, validateAssetManifestV1 } from "@/core";
import { createValidRawManifest } from "@/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { ExecutionRunService, type Clock, type IdGenerator } from "@/server/execution";
import { InMemoryExecutionRunRepository } from "@/server/execution/repository";
import { createApprovalProofFixture } from "@/server/execution/test-fixtures";
import { projectTokenizeCalldataReview } from "./tokenize-calldata-review";

const DATA = "0xf3d02cfd" + "00".repeat(32);
const TO = "0x23b04b6410d72fa66a77a9e0146df6634ad4c462";

describe("TOKENIZE calldata review", () => {
  it("projects only the operator-safe durable identifiers and commitment", async () => {
    const repository = new InMemoryExecutionRunRepository();
    let sequence = 0;
    const ids: IdGenerator = {
      runId: () => "11111111-1111-4111-8111-111111111111",
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
    const prepared = await service.recordPrepared(intent.id, intent.revision, "TOKENIZE", {
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

    await expect(projectTokenizeCalldataReview(prepared)).resolves.toEqual({
      runId: prepared.id,
      revision: prepared.revision,
      txId: "brickken-tx-1",
      destination: TO,
      selector: "0xf3d02cfd",
      calldataCommitment: await sha256Utf8(DATA),
    });
  });
});
