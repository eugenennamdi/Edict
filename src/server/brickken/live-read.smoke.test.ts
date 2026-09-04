import { describe, expect, it } from "vitest";
import { createBrickkenServerAdapter } from "./adapter";

describe("opt-in Brickken sandbox network-info read", () => {
  it("performs exactly one authenticated Sepolia network-info read", async () => {
    if (process.env.BRICKKEN_LIVE_READS !== "1") {
      throw new Error("Refusing to run without BRICKKEN_LIVE_READS=1.");
    }

    let requests = 0;
    const adapter = createBrickkenServerAdapter({
      fetch: async (input, init) => {
        requests += 1;
        const url = String(input);
        if (url.includes("/prepare-transactions") || url.includes("/send-transactions")) {
          throw new Error("Write endpoints are forbidden in the live read smoke test.");
        }
        return globalThis.fetch(input, init);
      },
    });

    const result = await adapter.getNetworkInfo({ chainId: "11155111" });
    expect(requests).toBe(1);
    if (!result.ok) {
      console.log(
        JSON.stringify({
          ok: false,
          category: result.error.code,
        }),
      );
      expect(result.error.message).not.toMatch(/x-api-key|authorization/i);
      throw result.error;
    }

    console.log(
      JSON.stringify({
        ok: true,
        category: "NETWORK_INFO",
        currencyName: result.value.currencyName,
        blockExplorerHost: result.value.blockExplorerHost,
      }),
    );
    expect(result.value.currencyName === null || result.value.currencyName.length > 0).toBe(true);
  });
});
