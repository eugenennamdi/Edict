import "server-only";

/**
 * Server-only boundary for Edict.
 *
 * This layer contains server runtime operations:
 * - Brickken server adapter (wrapping brickken-sdk with runtime validation)
 * - Safe environment variable access
 * - Application-owned repository interface for persistence
 */
export * from "./env";
export * from "./brickken";
export * from "./execution";
export * from "./persistence";
