import "server-only";

/**
 * Safe server-only environment validation and access.
 * Prevents credential exposure to client code and ensures
 * builds succeed even when runtime credentials are not provided.
 */

export interface ServerEnv {
  readonly BRICKKEN_API_KEY?: string;
  readonly BRICKKEN_BASE_URL: string;
  readonly BRICKKEN_CHAIN_ID: string;
  readonly DATABASE_URL?: string;
  readonly EDICT_RUN_SECURITY_SECRET?: string;
  readonly EDICT_RUN_API_ENABLED?: string;
  readonly EDICT_TRUSTED_ORIGIN?: string;
  readonly EDICT_TRANSACTION_PREPARATION_ENABLED?: string;
}

export function getServerEnv(): ServerEnv {
  // Guard: no NEXT_PUBLIC_ variable may contain a Brickken credential
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && (key.includes("KEY") || key.includes("SECRET"))) {
      throw new Error(
        `Security violation: Credential variable "${key}" must never use NEXT_PUBLIC_ prefix.`
      );
    }
  }

  return {
    BRICKKEN_API_KEY: process.env.BRICKKEN_API_KEY || undefined,
    BRICKKEN_BASE_URL: process.env.BRICKKEN_BASE_URL || "https://api.sandbox.brickken.com",
    BRICKKEN_CHAIN_ID: process.env.BRICKKEN_CHAIN_ID || "11155111",
    DATABASE_URL: process.env.DATABASE_URL || undefined,
    EDICT_RUN_SECURITY_SECRET: process.env.EDICT_RUN_SECURITY_SECRET || undefined,
    EDICT_RUN_API_ENABLED: process.env.EDICT_RUN_API_ENABLED || undefined,
    EDICT_TRUSTED_ORIGIN: process.env.EDICT_TRUSTED_ORIGIN || undefined,
    EDICT_TRANSACTION_PREPARATION_ENABLED:
      process.env.EDICT_TRANSACTION_PREPARATION_ENABLED || undefined,
  };
}
