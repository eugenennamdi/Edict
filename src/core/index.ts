/**
 * Core domain boundary for Edict.
 *
 * This layer contains pure deterministic domain logic:
 * - Manifest validation and canonicalization
 * - Execution plan generation and hashing
 * - Persisted state machine transitions
 * - Requested vs observed verification logic
 *
 * No external network I/O, database drivers, or wallet signing logic belongs here.
 */
export {};
