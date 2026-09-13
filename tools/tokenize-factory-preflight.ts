import "server-only";

import { pathToFileURL } from "node:url";
import {
  createBrickkenServerAdapter,
  type BrickkenServerAdapter,
} from "@/server/brickken";
import { getServerEnv } from "@/server/env";
import {
  deriveTokenizeSelectorFromCanonicalSignature,
  TOKENIZE_FUNCTION_SIGNATURE,
} from "@/server/orchestration";
import {
  createProductionSepoliaRpcTransport,
  type RpcTransport,
} from "@/server/rpc";

export const REVIEWED_SEPOLIA_FACTORY =
  "0x23b04b6410d72fa66a77a9e0146df6634ad4c462" as const;
export const REVIEWED_SEPOLIA_IMPLEMENTATION =
  "0x2c24f3fe7665ea83b2280bb5a7e66072c869ad89" as const;
export const REVIEWED_TOKENIZE_SELECTOR = "0xf3d02cfd" as const;
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export type TokenizeFactoryPreflightResult = Readonly<{
  ok: boolean;
  factoryAddress: string | null;
  implementationAddress: string | null;
  selector: string | null;
  checks: Readonly<{
    sandboxFactory: boolean;
    sepoliaRpc: boolean;
    erc1967Implementation: boolean;
    configuredSelector: boolean;
  }>;
  reason:
    | null
    | "NETWORK_INFO_UNAVAILABLE"
    | "FACTORY_ADDRESS_MISSING"
    | "FACTORY_ADDRESS_MISMATCH"
    | "RPC_UNAVAILABLE"
    | "RPC_CHAIN_MISMATCH"
    | "IMPLEMENTATION_SLOT_INVALID"
    | "IMPLEMENTATION_MISMATCH"
    | "SIGNATURE_UNAVAILABLE_OR_INVALID"
    | "SELECTOR_MISMATCH";
}>;

export interface TokenizeFactoryPreflightDependencies {
  readonly brickken?: Pick<BrickkenServerAdapter, "getNetworkInfo">;
  readonly rpc?: RpcTransport;
}

function result(input: Omit<TokenizeFactoryPreflightResult, "ok">): TokenizeFactoryPreflightResult {
  return Object.freeze({
    ok: Object.values(input.checks).every(Boolean),
    ...input,
    checks: Object.freeze({ ...input.checks }),
  });
}

function implementationFromSlot(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  if (!/^0{24}$/i.test(raw.slice(2, 26))) return null;
  const address = `0x${raw.slice(26).toLowerCase()}`;
  return address === "0x0000000000000000000000000000000000000000" ? null : address;
}

export async function runTokenizeFactoryPreflight(
  environment: Readonly<{ EDICT_TOKENIZE_FUNCTION_SIGNATURE?: string }> = {
    EDICT_TOKENIZE_FUNCTION_SIGNATURE: process.env.EDICT_TOKENIZE_FUNCTION_SIGNATURE,
  },
  dependencies: TokenizeFactoryPreflightDependencies = {},
): Promise<TokenizeFactoryPreflightResult> {
  const emptyChecks = {
    sandboxFactory: false,
    sepoliaRpc: false,
    erc1967Implementation: false,
    configuredSelector: false,
  };
  const network = await (dependencies.brickken ?? createBrickkenServerAdapter())
    .getNetworkInfo({ chainId: "11155111" });
  if (!network.ok) {
    return result({
      factoryAddress: null,
      implementationAddress: null,
      selector: null,
      checks: emptyChecks,
      reason: "NETWORK_INFO_UNAVAILABLE",
    });
  }
  const factoryAddress = network.value.factoryAddress;
  if (factoryAddress === null) {
    return result({
      factoryAddress,
      implementationAddress: null,
      selector: null,
      checks: emptyChecks,
      reason: "FACTORY_ADDRESS_MISSING",
    });
  }
  const factoryMatches = factoryAddress === REVIEWED_SEPOLIA_FACTORY;
  if (!factoryMatches) {
    return result({
      factoryAddress,
      implementationAddress: null,
      selector: null,
      checks: { ...emptyChecks, sandboxFactory: false },
      reason: "FACTORY_ADDRESS_MISMATCH",
    });
  }

  const rpc = dependencies.rpc ?? createProductionSepoliaRpcTransport();
  let chain: unknown;
  let storage: unknown;
  try {
    chain = await rpc.request("eth_chainId");
    storage = await rpc.request("eth_getStorageAt", [
      factoryAddress,
      ERC1967_IMPLEMENTATION_SLOT,
      "finalized",
    ]);
  } catch {
    return result({
      factoryAddress,
      implementationAddress: null,
      selector: null,
      checks: { ...emptyChecks, sandboxFactory: true },
      reason: "RPC_UNAVAILABLE",
    });
  }
  if (chain !== "0xaa36a7") {
    return result({
      factoryAddress,
      implementationAddress: null,
      selector: null,
      checks: { ...emptyChecks, sandboxFactory: true },
      reason: "RPC_CHAIN_MISMATCH",
    });
  }
  const implementationAddress = implementationFromSlot(storage);
  if (implementationAddress === null) {
    return result({
      factoryAddress,
      implementationAddress,
      selector: null,
      checks: { ...emptyChecks, sandboxFactory: true, sepoliaRpc: true },
      reason: "IMPLEMENTATION_SLOT_INVALID",
    });
  }
  const implementationMatches = implementationAddress === REVIEWED_SEPOLIA_IMPLEMENTATION;
  if (!implementationMatches) {
    return result({
      factoryAddress,
      implementationAddress,
      selector: null,
      checks: { ...emptyChecks, sandboxFactory: true, sepoliaRpc: true },
      reason: "IMPLEMENTATION_MISMATCH",
    });
  }

  let selector: string;
  try {
    const signature = environment[TOKENIZE_FUNCTION_SIGNATURE];
    if (signature === undefined) throw new Error("missing");
    selector = deriveTokenizeSelectorFromCanonicalSignature(signature);
  } catch {
    return result({
      factoryAddress,
      implementationAddress,
      selector: null,
      checks: {
        sandboxFactory: true,
        sepoliaRpc: true,
        erc1967Implementation: true,
        configuredSelector: false,
      },
      reason: "SIGNATURE_UNAVAILABLE_OR_INVALID",
    });
  }
  const selectorMatches = selector === REVIEWED_TOKENIZE_SELECTOR;
  return result({
    factoryAddress,
    implementationAddress,
    selector,
    checks: {
      sandboxFactory: true,
      sepoliaRpc: true,
      erc1967Implementation: true,
      configuredSelector: selectorMatches,
    },
    reason: selectorMatches ? null : "SELECTOR_MISMATCH",
  });
}

export async function runTokenizeFactoryPreflightMain(): Promise<number> {
  try {
    const output = await runTokenizeFactoryPreflight(getServerEnv());
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return output.ok ? 0 : 1;
  } catch {
    process.stdout.write('{"ok":false,"reason":"NETWORK_INFO_UNAVAILABLE"}\n');
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runTokenizeFactoryPreflightMain().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
