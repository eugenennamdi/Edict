import "server-only";

import { getServerEnv } from "../env";
import { decodeSecuritySecret, DomainSeparatedTokenMac } from "./tokens";

export function createSecurityTokenMac(): DomainSeparatedTokenMac {
  const environment = getServerEnv();
  return new DomainSeparatedTokenMac(decodeSecuritySecret(environment.EDICT_RUN_SECURITY_SECRET));
}
