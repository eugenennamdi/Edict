import { canonicalizeJson } from "@/core";
import type { IsoUtcTimestamp } from "./types";

export interface Clock {
  nowIso(): IsoUtcTimestamp;
}

export interface IdGenerator {
  runId(): string;
  operationId(): string;
  eventId(): string;
  invocationAttemptId?(): string;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoUtcTimestamp(value: string): value is IsoUtcTimestamp {
  return ISO_UTC.test(value);
}

export function systemClock(): Clock {
  return {
    nowIso() {
      return new Date().toISOString();
    },
  };
}

export function cryptoIdGenerator(): IdGenerator {
  return {
    runId: () => globalThis.crypto.randomUUID(),
    operationId: () => globalThis.crypto.randomUUID(),
    eventId: () => globalThis.crypto.randomUUID(),
    invocationAttemptId: () => `inv-${globalThis.crypto.randomUUID()}`,
  };
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value)) as T;
}

export function assertJsonSnapshot(value: unknown): void {
  canonicalizeJson(value);
}
