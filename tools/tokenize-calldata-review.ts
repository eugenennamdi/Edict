import "server-only";

import { pathToFileURL } from "node:url";
import { sha256Utf8 } from "@/core";
import { publicRunIdSchema } from "@/shared/run";
import { projectPreparedTransactionV1 } from "@/shared/wallet";
import { ExecutionError, type ExecutionRun, type ExecutionRunRepository } from "@/server/execution";
import { createNeonExecutionRunRepository } from "@/server/persistence";

export type TokenizeCalldataReviewErrorCode =
  | "INVALID_RUN_ID"
  | "RUN_NOT_FOUND"
  | "TOKENIZE_NOT_PREPARED"
  | "PREPARATION_UNCERTAIN"
  | "PREPARATION_FAILED"
  | "UNSIGNED_TRANSACTION_MISSING"
  | "DATABASE_CONFIG_MISSING"
  | "DATABASE_UNAVAILABLE"
  | "UNSUPPORTED_RUN_SCHEMA"
  | "MALFORMED_PREPARED_TRANSACTION";

class TokenizeCalldataReviewError extends Error {
  readonly code: TokenizeCalldataReviewErrorCode;

  constructor(code: TokenizeCalldataReviewErrorCode) {
    super(code);
    this.name = "TokenizeCalldataReviewError";
    this.code = code;
  }
}

export interface TokenizeCalldataReview {
  readonly runId: string;
  readonly schemaVersion: "2.0" | "4.0";
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
  if (run.schemaVersion !== "2.0" && run.schemaVersion !== "4.0") {
    throw new TokenizeCalldataReviewError("UNSUPPORTED_RUN_SCHEMA");
  }
  if (
    run.phase !== "TOKENIZATION" ||
    operation.kind !== "TOKENIZE"
  ) {
    throw new TokenizeCalldataReviewError("TOKENIZE_NOT_PREPARED");
  }
  if (
    run.status === "FAILED" &&
    run.terminalOutcome === "FAILED" &&
    operation.preparedTxId === null
  ) {
    throw new TokenizeCalldataReviewError("PREPARATION_FAILED");
  }
  if (
    run.status === "RECONCILIATION_REQUIRED" ||
    operation.stage === "PREPARE_UNKNOWN"
  ) {
    throw new TokenizeCalldataReviewError("PREPARATION_UNCERTAIN");
  }
  if (operation.stage !== "PREPARED") {
    throw new TokenizeCalldataReviewError("TOKENIZE_NOT_PREPARED");
  }
  if (operation.preparedTxId === null) {
    throw new TokenizeCalldataReviewError("MALFORMED_PREPARED_TRANSACTION");
  }
  if (operation.unsignedTransaction === null) {
    throw new TokenizeCalldataReviewError("UNSIGNED_TRANSACTION_MISSING");
  }
  let prepared: ReturnType<typeof projectPreparedTransactionV1>;
  try {
    prepared = projectPreparedTransactionV1(operation.unsignedTransaction);
  } catch {
    throw new TokenizeCalldataReviewError("MALFORMED_PREPARED_TRANSACTION");
  }
  const destination = prepared.walletRequest.to;
  const calldata = prepared.walletRequest.data;
  if (destination === undefined || calldata === undefined || calldata.length < 10) {
    throw new TokenizeCalldataReviewError("MALFORMED_PREPARED_TRANSACTION");
  }
  return Object.freeze({
    runId: run.id,
    schemaVersion: run.schemaVersion,
    revision: run.revision,
    txId: operation.preparedTxId,
    destination,
    selector: calldata.slice(0, 10),
    calldataCommitment: await sha256Utf8(calldata),
  });
}

function safeDiagnostic(error: unknown): TokenizeCalldataReviewErrorCode {
  if (error instanceof TokenizeCalldataReviewError) return error.code;
  if (error instanceof ExecutionError) {
    if (error.code === "CONFIGURATION_MISSING") return "DATABASE_CONFIG_MISSING";
    if (error.code === "REPOSITORY_NOT_FOUND") return "RUN_NOT_FOUND";
    if (error.code === "PERSISTENCE_UNAVAILABLE") return "DATABASE_UNAVAILABLE";
    if (error.code === "PERSISTENCE_DATA_INVALID" || error.code === "INVALID_RUN_SNAPSHOT") {
      return "MALFORMED_PREPARED_TRANSACTION";
    }
  }
  return "MALFORMED_PREPARED_TRANSACTION";
}

export async function runTokenizeCalldataReviewMain(
  argv: readonly string[] = process.argv,
  write: (value: string) => void = (value) => process.stdout.write(value),
  writeError: (value: string) => void = (value) => process.stderr.write(value),
  repository?: Pick<ExecutionRunRepository, "getById">,
): Promise<number> {
  const parsedRunId = publicRunIdSchema.safeParse(argv[2]);
  if (argv.length !== 3 || !parsedRunId.success) {
    writeError("INVALID_RUN_ID\n");
    return 1;
  }
  try {
    const runs = repository ?? createNeonExecutionRunRepository();
    const run = await runs.getById(parsedRunId.data);
    const review = await projectTokenizeCalldataReview(run);
    write(`${JSON.stringify(review)}\n`);
    return 0;
  } catch (error) {
    writeError(`${safeDiagnostic(error)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runTokenizeCalldataReviewMain().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
