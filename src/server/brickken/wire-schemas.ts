import { z } from "zod";

const hexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const bigNumberSchema = z
  .object({
    type: z.literal("BigNumber"),
    hex: hexStringSchema,
  })
  .passthrough();

const quantitySchema = z.union([z.string(), z.number(), bigNumberSchema]);

export const unsignedTransactionSchema = z
  .object({
    from: addressSchema.optional(),
    to: addressSchema.optional(),
    data: hexStringSchema.optional(),
    value: quantitySchema.optional(),
    nonce: z.number().int().nonnegative().optional(),
    chainId: z.union([z.number().int(), z.string()]).optional(),
    type: z.number().int().optional(),
    gasLimit: quantitySchema.optional(),
    maxFeePerGas: quantitySchema.optional(),
    maxPriorityFeePerGas: quantitySchema.optional(),
    gasPrice: quantitySchema.optional(),
  })
  .passthrough();

export const prepareResponseSchema = z
  .object({
    txId: z.union([z.string(), z.array(z.string())]),
    transactions: z.array(z.unknown()),
    info: z.unknown().optional(),
  })
  .passthrough();

export const sendResponseSchema = z
  .object({
    txHash: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const transactionStatusSchema = z
  .object({
    status: z.enum(["pending", "success", "rejected"]),
    transactionHash: z.string().optional(),
    hash: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const tokenInfoAssetSchema = z
  .object({
    name: z.string().optional(),
    tokenName: z.string().optional(),
    tokenSymbol: z.string(),
    tokenType: z.string().optional(),
    tokenizerEmail: z.string().optional(),
    companyWalletAddress: z.string().optional(),
    maxTokenSupply: z.string().optional(),
    paymentToken: z
      .object({
        blockchain: z
          .object({
            chainId: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const tokenizerInfoSchema = z
  .object({
    companyWalletAddress: z.string(),
    tokenAddress: z.string(),
    paymentTokenAddress: z.string().optional(),
    chainId: z.union([z.string(), z.number()]),
    email: z.string().optional(),
  })
  .passthrough();

export const whitelistStatusSchema = z
  .object({
    isWhitelisted: z.boolean(),
    address: z.string(),
    tokenSymbol: z.string(),
    source: z.literal("blockchain"),
  })
  .passthrough();

export const balanceWhitelistSchema = z
  .object({
    walletAddress: z.string(),
    tokenAddress: z.string(),
    tokenDecimals: z.number().int(),
    tokenBalanceRaw: z.string(),
    isWhitelisted: z.boolean(),
    balanceSource: z.literal("blockchain"),
  })
  .passthrough();

export const networkInfoSchema = z
  .object({
    currencyName: z.string().optional(),
    blockExplorerUrl: z.string().optional(),
  })
  .passthrough();

export type UnsignedTransactionWire = z.infer<typeof unsignedTransactionSchema>;
