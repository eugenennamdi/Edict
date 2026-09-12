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
  readonly EDICT_TOKENIZE_EXECUTION_ENABLED?: string;
  readonly EDICT_TOKENIZE_ALLOWED_DESTINATION?: string;
  readonly EDICT_TOKENIZE_FUNCTION_SIGNATURE?: string;
  readonly EDICT_TOKENIZE_CALLDATA_COMMITMENT?: string;
  readonly EDICT_SEPOLIA_RPC_URL?: string;
}

export function getServerEnv(): ServerEnv {
  // Guard: no NEXT_PUBLIC_ variable may contain a Brickken credential or private RPC configuration
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("NEXT_PUBLIC_") &&
      (key.includes("KEY") || key.includes("SECRET") || key.includes("RPC"))
    ) {
      throw new Error(
        `Security violation: Credential variable "${key}" must never use NEXT_PUBLIC_ prefix.`
      );
    }
    if (key.startsWith("NEXT_PUBLIC_EDICT_TOKENIZE_")) {
      throw new Error("Security violation: TOKENIZE execution policy must remain server-only.");
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
    EDICT_TOKENIZE_EXECUTION_ENABLED:
      process.env.EDICT_TOKENIZE_EXECUTION_ENABLED || undefined,
    EDICT_TOKENIZE_ALLOWED_DESTINATION:
      process.env.EDICT_TOKENIZE_ALLOWED_DESTINATION || undefined,
    EDICT_TOKENIZE_FUNCTION_SIGNATURE:
      process.env.EDICT_TOKENIZE_FUNCTION_SIGNATURE || undefined,
    EDICT_TOKENIZE_CALLDATA_COMMITMENT:
      process.env.EDICT_TOKENIZE_CALLDATA_COMMITMENT || undefined,
    EDICT_SEPOLIA_RPC_URL: process.env.EDICT_SEPOLIA_RPC_URL || undefined,
  };
}
