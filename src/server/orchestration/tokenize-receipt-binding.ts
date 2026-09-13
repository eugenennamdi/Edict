import "server-only";

import { toEventSelector, toFunctionSelector } from "viem";
import { z } from "zod";
import type { NormalizedRpcReceipt } from "../rpc";

export const REVIEWED_SEPOLIA_FACTORY =
  "0x23b04b6410d72fa66a77a9e0146df6634ad4c462" as const;
export const REVIEWED_SEPOLIA_IMPLEMENTATION =
  "0x2c24f3fe7665ea83b2280bb5a7e66072c869ad89" as const;
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export const REVIEWED_TOKENIZE_FUNCTION_SIGNATURE =
  "newTokenization((string,string,string,uint224,address,address,bool,uint256[],address[]),(address,uint256,address,address,uint256,uint256,bytes),(uint256,address,address,uint256,uint8,bytes32,bytes32))" as const;
export const REVIEWED_TOKENIZE_SELECTOR = "0xf3d02cfd" as const;

export const NEW_TOKENIZATION_EVENT_ABI =
  "event NewTokenization(uint256 indexed id,address indexed token,address indexed escrow)" as const;
export const NEW_TOKENIZATION_EVENT_SIGNATURE =
  "NewTokenization(uint256,address,address)" as const;
export const NEW_TOKENIZATION_EVENT_TOPIC =
  "0xf3891eaa15d438132be54582fa326e471227aacade9ebed32006b0ba9d63254c" as const;

export interface TokenizationEventEvidenceV1 {
  readonly evidenceVersion: "1.0";
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly transactionIndex: string;
  readonly logIndex: string;
  readonly factoryAddress: typeof REVIEWED_SEPOLIA_FACTORY;
  readonly implementationAddress: typeof REVIEWED_SEPOLIA_IMPLEMENTATION;
  readonly eventTopic: typeof NEW_TOKENIZATION_EVENT_TOPIC;
  readonly tokenizationId: string;
  readonly tokenAddress: string;
  readonly escrowAddress: string;
}

const lowerAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/);

export const tokenizationEventEvidenceV1Schema = z.strictObject({
  evidenceVersion: z.literal("1.0"),
  transactionHash: hash32,
  blockHash: hash32,
  blockNumber: quantity,
  transactionIndex: quantity,
  logIndex: quantity,
  factoryAddress: z.literal(REVIEWED_SEPOLIA_FACTORY),
  implementationAddress: z.literal(REVIEWED_SEPOLIA_IMPLEMENTATION),
  eventTopic: z.literal(NEW_TOKENIZATION_EVENT_TOPIC),
  tokenizationId: z.string().regex(/^[1-9][0-9]{0,77}$/),
  tokenAddress: lowerAddress,
  escrowAddress: lowerAddress,
});

export class TokenizeReceiptBindingError extends Error {
  readonly code = "READ_BACK_BINDING_UNRESOLVED";

  constructor() {
    super("READ_BACK_BINDING_UNRESOLVED");
    this.name = "TokenizeReceiptBindingError";
  }
}

function fail(): never {
  throw new TokenizeReceiptBindingError();
}

function addressFromIndexedTopic(topic: string): string {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(topic)) fail();
  const address = `0x${topic.slice(26)}`;
  if (address === "0x0000000000000000000000000000000000000000") fail();
  return address;
}

export function implementationAddressFromErc1967Slot(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const normalized = raw.toLowerCase();
  if (!/^0x0{24}/.test(normalized)) return null;
  const address = `0x${normalized.slice(26)}`;
  return address === "0x0000000000000000000000000000000000000000" ? null : address;
}

export function assertReviewedTokenizeAbiConstants(): void {
  if (
    toFunctionSelector(REVIEWED_TOKENIZE_FUNCTION_SIGNATURE).toLowerCase() !==
      REVIEWED_TOKENIZE_SELECTOR ||
    toEventSelector(NEW_TOKENIZATION_EVENT_SIGNATURE).toLowerCase() !==
      NEW_TOKENIZATION_EVENT_TOPIC
  ) fail();
}

export function deriveTokenizationEventEvidence(input: {
  readonly receipt: NormalizedRpcReceipt;
  readonly expectedTransactionHash: string;
  readonly implementationAddress: string;
}): TokenizationEventEvidenceV1 {
  assertReviewedTokenizeAbiConstants();
  const receipt = input.receipt;
  if (
    receipt.status !== "0x1" ||
    receipt.transactionHash !== input.expectedTransactionHash.toLowerCase() ||
    receipt.to !== REVIEWED_SEPOLIA_FACTORY ||
    input.implementationAddress.toLowerCase() !== REVIEWED_SEPOLIA_IMPLEMENTATION
  ) fail();

  const candidates = receipt.logs.filter(
    (log) =>
      log.address === REVIEWED_SEPOLIA_FACTORY &&
      log.topics[0] === NEW_TOKENIZATION_EVENT_TOPIC,
  );
  if (candidates.length !== 1) fail();

  const log = candidates[0];
  if (
    log.topics.length !== 4 ||
    log.data !== "0x" ||
    log.transactionHash !== receipt.transactionHash ||
    log.transactionIndex !== receipt.transactionIndex ||
    log.blockHash !== receipt.blockHash ||
    log.blockNumber !== receipt.blockNumber
  ) fail();

  let id: bigint;
  try {
    id = BigInt(log.topics[1]);
  } catch {
    fail();
  }
  if (id <= 0n) fail();
  const tokenAddress = addressFromIndexedTopic(log.topics[2]);
  const escrowAddress = addressFromIndexedTopic(log.topics[3]);
  if (
    tokenAddress === escrowAddress ||
    tokenAddress === REVIEWED_SEPOLIA_FACTORY ||
    escrowAddress === REVIEWED_SEPOLIA_FACTORY
  ) fail();

  return Object.freeze(tokenizationEventEvidenceV1Schema.parse({
    evidenceVersion: "1.0",
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    transactionIndex: receipt.transactionIndex,
    logIndex: log.logIndex,
    factoryAddress: REVIEWED_SEPOLIA_FACTORY,
    implementationAddress: REVIEWED_SEPOLIA_IMPLEMENTATION,
    eventTopic: NEW_TOKENIZATION_EVENT_TOPIC,
    tokenizationId: id.toString(10),
    tokenAddress,
    escrowAddress,
  }));
}
