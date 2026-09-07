import { describe, expect, it } from "vitest";
import { readRunApiDeploymentConfig } from "./config";

describe("run API deployment gate", () => {
  it("is deny-by-default", () => {
    expect(readRunApiDeploymentConfig({})).toEqual({ enabled: false, trustedOrigin: null });
    expect(readRunApiDeploymentConfig({ EDICT_RUN_API_ENABLED: "true", EDICT_TRUSTED_ORIGIN: "https://edict.example" })).toEqual({ enabled: false, trustedOrigin: null });
  });

  it("accepts only an exact safe origin", () => {
    expect(readRunApiDeploymentConfig({ EDICT_RUN_API_ENABLED: "1", EDICT_TRUSTED_ORIGIN: "https://edict.example" })).toEqual({ enabled: true, trustedOrigin: "https://edict.example" });
    for (const origin of ["https://user:pass@edict.example", "https://edict.example/path", "http://edict.example", "https://edict.example/"]) {
      expect(readRunApiDeploymentConfig({ EDICT_RUN_API_ENABLED: "1", EDICT_TRUSTED_ORIGIN: origin }).enabled).toBe(false);
    }
  });

  it("permits an exact localhost origin for the separately selected cookie policy", () => {
    expect(readRunApiDeploymentConfig({ EDICT_RUN_API_ENABLED: "1", EDICT_TRUSTED_ORIGIN: "http://localhost:3000" })).toEqual({ enabled: true, trustedOrigin: "http://localhost:3000" });
  });
});
