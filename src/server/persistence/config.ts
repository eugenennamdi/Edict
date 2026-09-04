import "server-only";

import { PersistenceConfigurationError } from "../execution/errors";

export interface DatabaseConfig {
  readonly databaseUrl: string;
}

export function readDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (
    typeof databaseUrl !== "string" ||
    databaseUrl.trim().length === 0 ||
    databaseUrl !== databaseUrl.trim() ||
    (!databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://"))
  ) {
    throw new PersistenceConfigurationError();
  }
  return { databaseUrl };
}
