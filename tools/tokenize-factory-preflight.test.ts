import { describe, expect, it } from "vitest";
import {
  ERC1967_IMPLEMENTATION_SLOT,
  REVIEWED_SEPOLIA_FACTORY,
  REVIEWED_SEPOLIA_IMPLEMENTATION,
  REVIEWED_TOKENIZE_SELECTOR,
  runTokenizeFactoryPreflight,
} from "./tokenize-factory-preflight";

const SIGNATURE = "function createTokenization(bytes)";

function dependencies(input: {
  readonly factoryAddress?: string | null;
  readonly implementationAddress?: string;
  readonly chainId?: string;
} = {}) {
  const factoryAddress = input.factoryAddress === undefined
    ? REVIEWED_SEPOLIA_FACTORY
    : input.factoryAddress;
  const implementation = input.implementationAddress ?? REVIEWED_SEPOLIA_IMPLEMENTATION;
  const storage = `0x${"0".repeat(24)}${implementation.slice(2)}`;
  const calls: Array<{ method: string; params?: readonly unknown[] }> = [];
  return {
    calls,
    value: {
      brickken: {
        async getNetworkInfo() {
          return {
            ok: true as const,
            value: {
              currencyName: "Sepolia ETH",
              blockExplorerHost: "sepolia.etherscan.io",
              factoryAddress,
            },
          };
        },
      },
      rpc: {
        async request(method: string, params?: readonly unknown[]) {
          calls.push({ method, params });
          return method === "eth_chainId" ? input.chainId ?? "0xaa36a7" : storage;
        },
      },
    },
  };
}

describe("TOKENIZE factory preflight", () => {
  it("binds the authenticated factory, exact ERC-1967 slot, and derived selector", async () => {
    const deps = dependencies();
    const result = await runTokenizeFactoryPreflight(
      { EDICT_TOKENIZE_FUNCTION_SIGNATURE: SIGNATURE },
      deps.value,
    );

    expect(result).toEqual({
      ok: false,
      factoryAddress: REVIEWED_SEPOLIA_FACTORY,
      implementationAddress: REVIEWED_SEPOLIA_IMPLEMENTATION,
      selector: "0x3404e0ee",
      checks: {
        sandboxFactory: true,
        sepoliaRpc: true,
        erc1967Implementation: true,
        configuredSelector: false,
      },
      reason: "SELECTOR_MISMATCH",
    });
    expect(deps.calls).toEqual([
      { method: "eth_chainId", params: undefined },
      {
        method: "eth_getStorageAt",
        params: [REVIEWED_SEPOLIA_FACTORY, ERC1967_IMPLEMENTATION_SLOT, "finalized"],
      },
    ]);
    expect(REVIEWED_TOKENIZE_SELECTOR).toBe("0xf3d02cfd");
  });

  it("fails closed before RPC when network-info omits the factory", async () => {
    const deps = dependencies({ factoryAddress: null });
    const result = await runTokenizeFactoryPreflight(
      { EDICT_TOKENIZE_FUNCTION_SIGNATURE: SIGNATURE },
      deps.value,
    );
    expect(result.reason).toBe("FACTORY_ADDRESS_MISSING");
    expect(deps.calls).toHaveLength(0);
  });
});
