import {
  InvalidRunSnapshotError,
  RepositoryNotFoundError,
  RepositoryRevisionConflictError,
} from "./errors";
import { assertJsonSnapshot, jsonClone } from "./infrastructure";
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

function snapshot(run: ExecutionRunV1): ExecutionRunV1 {
  try {
    assertJsonSnapshot(run);
    return jsonClone(run);
  } catch {
    throw new InvalidRunSnapshotError();
  }
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
    const stored = snapshot(run);
    if (this.#runs.has(stored.id)) {
      throw new RepositoryRevisionConflictError();
    }
    this.#runs.set(stored.id, JSON.stringify(stored));
    return this.getById(stored.id);
  }

  async getById(id: string): Promise<ExecutionRunV1> {
    const raw = this.#runs.get(id);
    if (raw === undefined) {
      throw new RepositoryNotFoundError();
    }
    return JSON.parse(raw) as ExecutionRunV1;
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
    const stored = snapshot({ ...next, revision: expectedRevision + 1 });
    this.#runs.set(id, JSON.stringify(stored));
    return this.getById(id);
  }
}
