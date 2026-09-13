import "server-only";

import { pathToFileURL } from "node:url";
import { sha256Utf8 } from "@/core";
import { publicRunIdSchema } from "@/shared/run";
import { projectPreparedTransactionV1 } from "@/shared/wallet";
import type { ExecutionRun } from "@/server/execution";
import { createNeonExecutionRunRepository } from "@/server/persistence";

export interface TokenizeCalldataReview {
  readonly runId: string;
  readonly revision: number;
  readonly txId: string;
  readonly destination: string;
  readonly selector: string;
  readonly calldataCommitment: string;
}

export async function projectTokenizeCalldataReview(
  run: ExecutionRun,
): Promise<TokenizeCalldataReview> {
  const operation = run.operations[0];
  if (
    run.phase !== "TOKENIZATION" ||
    operation.kind !== "TOKENIZE" ||
    operation.stage !== "PREPARED" ||
    operation.preparedTxId === null ||
    operation.unsignedTransaction === null
  ) {
    throw new Error("TOKENIZE_REVIEW_UNAVAILABLE");
  }
  const prepared = projectPreparedTransactionV1(operation.unsignedTransaction);
  const destination = prepared.walletRequest.to;
  const calldata = prepared.walletRequest.data;
  if (destination === undefined || calldata === undefined || calldata.length < 10) {
    throw new Error("TOKENIZE_REVIEW_UNAVAILABLE");
  }
  return Object.freeze({
    runId: run.id,
    revision: run.revision,
    txId: operation.preparedTxId,
    destination,
    selector: calldata.slice(0, 10),
    calldataCommitment: await sha256Utf8(calldata),
  });
}

export async function runTokenizeCalldataReviewMain(
  argv: readonly string[] = process.argv,
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<number> {
  const parsedRunId = publicRunIdSchema.safeParse(argv[2]);
  if (argv.length !== 3 || !parsedRunId.success) return 1;
  try {
    const repository = createNeonExecutionRunRepository();
    const run = await repository.getById(parsedRunId.data);
    const review = await projectTokenizeCalldataReview(run);
    write(`${JSON.stringify(review)}\n`);
    return 0;
  } catch {
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runTokenizeCalldataReviewMain().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
