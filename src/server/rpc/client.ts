import "server-only";

import {
  normalizeRpcBlock,
  normalizeRpcReceipt,
  normalizeRpcTransaction,
  parseSepoliaChainId,
  rpcAddressSchema,
  rpcHash32Schema,
  rpcQuantitySchema,
} from "./contracts";
import {
  SEPOLIA_DECIMAL_CHAIN_ID,
  type NormalizedRpcBlock,
  type NormalizedRpcReceipt,
  type NormalizedRpcTransaction,
  type RpcTransport,
  type TrustedSepoliaRpcClient,
} from "./types";

/**
 * Server-only Trusted Sepolia RPC client.
 *
 * Enforces session chain verification (asserting Sepolia 11155111 / 0xaa36a7) and
 * validates all node responses through strict runtime contracts.
 *
 * Note: Delegates raw network communication to an injected `RpcTransport`. The client
 * does not independently prove or claim that an arbitrary injected transport implements
 * stream byte limiting.
 */
export class TrustedSepoliaRpcClientImpl implements TrustedSepoliaRpcClient {
  readonly chainId = SEPOLIA_DECIMAL_CHAIN_ID;
  readonly #transport: RpcTransport;
  #chainVerified = false;

  constructor(transport: RpcTransport) {
    this.#transport = transport;
  }

  async verifyChain(): Promise<void> {
    if (this.#chainVerified) return;
    const rawChainId = await this.#transport.request("eth_chainId");
    parseSepoliaChainId(rawChainId);
    this.#chainVerified = true;
  }

  async getPendingNonce(address: string): Promise<string> {
    await this.verifyChain();
    const normalizedAddress = rpcAddressSchema.parse(address);
    const raw = await this.#transport.request("eth_getTransactionCount", [
      normalizedAddress,
      "pending",
    ]);
    return rpcQuantitySchema.parse(raw);
  }

  async getBalance(
    address: string,
    blockTag: "pending" | "latest" = "pending",
  ): Promise<string> {
    await this.verifyChain();
    const normalizedAddress = rpcAddressSchema.parse(address);
    const raw = await this.#transport.request("eth_getBalance", [
      normalizedAddress,
      blockTag,
    ]);
    return rpcQuantitySchema.parse(raw);
  }

  async getLatestBlock(): Promise<NormalizedRpcBlock> {
    await this.verifyChain();
    const raw = await this.#transport.request("eth_getBlockByNumber", ["latest", false]);
    if (raw === null || raw === undefined) {
      throw new Error("RPC returned null for canonical latest block.");
    }
    return normalizeRpcBlock(raw);
  }

  async getFinalizedBlock(): Promise<NormalizedRpcBlock | null> {
    await this.verifyChain();
    try {
      const raw = await this.#transport.request("eth_getBlockByNumber", ["finalized", false]);
      if (raw === null || raw === undefined) return null;
      return normalizeRpcBlock(raw);
    } catch {
      // If finalized tag is not supported by the node or fails, return null (finality unavailable)
      return null;
    }
  }

  async getTransaction(txHash: string): Promise<NormalizedRpcTransaction | null> {
    await this.verifyChain();
    const normalizedHash = rpcHash32Schema.parse(txHash);
    const raw = await this.#transport.request("eth_getTransactionByHash", [normalizedHash]);
    if (raw === null || raw === undefined) return null;
    return normalizeRpcTransaction(raw);
  }

  async getTransactionReceipt(txHash: string): Promise<NormalizedRpcReceipt | null> {
    await this.verifyChain();
    const normalizedHash = rpcHash32Schema.parse(txHash);
    const raw = await this.#transport.request("eth_getTransactionReceipt", [normalizedHash]);
    if (raw === null || raw === undefined) return null;
    return normalizeRpcReceipt(raw);
  }

  async getStorageAt(address: string, slot: string, blockNumber: string): Promise<string> {
    await this.verifyChain();
    const normalizedAddress = rpcAddressSchema.parse(address);
    const normalizedSlot = rpcHash32Schema.parse(slot);
    const normalizedBlockNumber = rpcQuantitySchema.parse(blockNumber);
    const raw = await this.#transport.request("eth_getStorageAt", [
      normalizedAddress,
      normalizedSlot,
      normalizedBlockNumber,
    ]);
    return rpcHash32Schema.parse(raw);
  }

  async getBlockByNumber(blockNumber: string): Promise<NormalizedRpcBlock | null> {
    await this.verifyChain();
    const normalizedNumber = rpcQuantitySchema.parse(blockNumber);
    const raw = await this.#transport.request("eth_getBlockByNumber", [normalizedNumber, false]);
    if (raw === null || raw === undefined) return null;
    return normalizeRpcBlock(raw);
  }

  async getBlockByHash(blockHash: string): Promise<NormalizedRpcBlock | null> {
    await this.verifyChain();
    const normalizedHash = rpcHash32Schema.parse(blockHash);
    const raw = await this.#transport.request("eth_getBlockByHash", [normalizedHash, false]);
    if (raw === null || raw === undefined) return null;
    return normalizeRpcBlock(raw);
  }
}

export function createTrustedSepoliaRpcClient(transport: RpcTransport): TrustedSepoliaRpcClient {
  return new TrustedSepoliaRpcClientImpl(transport);
}
