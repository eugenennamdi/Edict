import {
  InvalidRunSnapshotError,
  RepositoryNotFoundError,
  RepositoryRevisionConflictError,
} from "./errors";
import { decodeExecutionRunV1, encodeExecutionRunV1 } from "../persistence/codec";
import type { ExecutionRunV1 } from "./types";

export interface ExecutionRunRepository {
  create(run: ExecutionRunV1): Promise<ExecutionRunV1>;
  getById(id: string): Promise<ExecutionRunV1>;
  update(
    id: string,
    expectedRevision: number,
    next: ExecutionRunV1,
  ): Promise<ExecutionRunV1>;
}

/**
 * In-memory repository for tests and local demos only.
 * It is not durable across process restarts and is not a production store.
 * Live write execution cannot ship until an application-owned durable
 * managed repository implementation exists.
 */
export class InMemoryExecutionRunRepository implements ExecutionRunRepository {
  readonly #runs = new Map<string, string>();

  async create(run: ExecutionRunV1): Promise<ExecutionRunV1> {
    const row = encodeExecutionRunV1(run);
    if (this.#runs.has(row.runId)) {
      throw new RepositoryRevisionConflictError();
    }
    this.#runs.set(row.runId, JSON.stringify(row));
    return this.getById(row.runId);
  }

  async getById(id: string): Promise<ExecutionRunV1> {
    const raw = this.#runs.get(id);
    if (raw === undefined) {
      throw new RepositoryNotFoundError();
    }
    return decodeExecutionRunV1(JSON.parse(raw));
  }

  async update(
    id: string,
    expectedRevision: number,
    next: ExecutionRunV1,
  ): Promise<ExecutionRunV1> {
    const current = await this.getById(id);
    if (current.revision !== expectedRevision || next.revision !== expectedRevision) {
      throw new RepositoryRevisionConflictError();
    }
    if (next.id !== id) {
      throw new InvalidRunSnapshotError();
    }
    const row = encodeExecutionRunV1({ ...next, revision: expectedRevision + 1 });
    this.#runs.set(id, JSON.stringify(row));
    return this.getById(id);
  }
}
