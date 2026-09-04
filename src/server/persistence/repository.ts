import "server-only";

import {
  InvalidRunSnapshotError,
  PersistenceDataError,
  PersistenceUnavailableError,
  RepositoryNotFoundError,
  RepositoryRevisionConflictError,
} from "../execution/errors";
import type { ExecutionRunRepository } from "../execution/repository";
import type { ExecutionRun } from "../execution/types";
import { decodeExecutionRunV1, encodeExecutionRunV1 } from "./codec";
import { readDatabaseConfig } from "./config";
import { createDrizzleExecutionRunStore, type ExecutionRunStore } from "./store";

function persistenceFailure(error: unknown): never {
  if (
    error instanceof InvalidRunSnapshotError ||
    error instanceof PersistenceDataError ||
    error instanceof RepositoryNotFoundError ||
    error instanceof RepositoryRevisionConflictError
  ) {
    throw error;
  }
  throw new PersistenceUnavailableError();
}

export class NeonExecutionRunRepository implements ExecutionRunRepository {
  readonly #store: ExecutionRunStore;

  constructor(store: ExecutionRunStore) {
    this.#store = store;
  }

  async create(run: ExecutionRun): Promise<ExecutionRun> {
    const row = encodeExecutionRunV1(run);
    try {
      const created = await this.#store.insert(row);
      if (created === null) throw new RepositoryRevisionConflictError();
      return decodeExecutionRunV1(created);
    } catch (error) {
      return persistenceFailure(error);
    }
  }

  async getById(id: string): Promise<ExecutionRun> {
    try {
      const row = await this.#store.selectById(id);
      if (row === null) throw new RepositoryNotFoundError();
      return decodeExecutionRunV1(row);
    } catch (error) {
      return persistenceFailure(error);
    }
  }

  async update(
    id: string,
    expectedRevision: number,
    next: ExecutionRun,
  ): Promise<ExecutionRun> {
    if (
      id !== next.id ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      next.revision !== expectedRevision
    ) {
      throw new InvalidRunSnapshotError();
    }

    const row = encodeExecutionRunV1({ ...next, revision: expectedRevision + 1 });
    try {
      const updated = await this.#store.compareAndSwap(row, expectedRevision);
      if (updated !== null) return decodeExecutionRunV1(updated);

      const current = await this.#store.selectById(id);
      if (current === null) throw new RepositoryNotFoundError();
      throw new RepositoryRevisionConflictError();
    } catch (error) {
      return persistenceFailure(error);
    }
  }
}

export function createNeonExecutionRunRepository(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NeonExecutionRunRepository {
  const config = readDatabaseConfig(environment);
  return new NeonExecutionRunRepository(createDrizzleExecutionRunStore(config.databaseUrl));
}
