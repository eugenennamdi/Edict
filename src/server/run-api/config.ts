import "server-only";

export interface RunApiDeploymentConfig {
  readonly enabled: boolean;
  readonly trustedOrigin: string | null;
}

export function readRunApiDeploymentConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RunApiDeploymentConfig {
  const enabled = environment.EDICT_RUN_API_ENABLED === "1";
  const candidate = environment.EDICT_TRUSTED_ORIGIN;
  if (!enabled || !candidate) return Object.freeze({ enabled: false, trustedOrigin: null });
  try {
    const url = new URL(candidate);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.origin !== candidate) {
      return Object.freeze({ enabled: false, trustedOrigin: null });
    }
    return Object.freeze({ enabled: true, trustedOrigin: url.origin });
  } catch {
    return Object.freeze({ enabled: false, trustedOrigin: null });
  }
}
