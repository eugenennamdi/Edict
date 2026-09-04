import type { BrickkenAdapterError } from "./errors";

export type AdapterResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BrickkenAdapterError };

export interface PrepareTokenizationInput {
  readonly signerAddress: string;
  readonly tokenizerEmail: string;
  readonly name: string;
  readonly tokenSymbol: string;
  readonly supplyCap: string;
  readonly documentationUrl: string;
}

export interface PrepareWhitelistInput {
  readonly signerAddress: string;
  readonly tokenSymbol: string;
  readonly investorAddress: string;
  readonly investorEmail: string;
}

export interface PrepareMintInput {
  readonly signerAddress: string;
  readonly tokenSymbol: string;
  readonly investorAddress: string;
  readonly investorEmail: string;
  readonly amount: string;
}

export interface ConfirmedWhitelistEvidence {
  readonly runId: string;
  readonly whitelistTxId: string;
  readonly stage: "READ_BACK_VERIFIED";
  readonly investorWalletAddress: string;
  readonly isWhitelisted: true;
  readonly source: "blockchain";
}

export interface EdictPreparedTransaction {
  readonly from: string | null;
  readonly to: string | null;
  readonly data: string | null;
  readonly value: unknown;
  readonly nonce: unknown;
  readonly chainId: unknown;
  readonly type: unknown;
  readonly gasLimit: unknown;
  readonly maxFeePerGas: unknown;
  readonly maxPriorityFeePerGas: unknown;
  readonly gasPrice: unknown;
  readonly normalizedChainId: "11155111" | null;
  readonly rawUnsigned: Record<string, unknown>;
}

export interface PreparedOperation {
  readonly txId: string;
  readonly executionMode: "client-broadcast";
  readonly transaction: EdictPreparedTransaction;
}

export interface BroadcastConfirmation {
  readonly txHash: string | null;
  readonly status: string | null;
}

export interface TransactionStatusView {
  readonly status: "pending" | "success" | "rejected";
  readonly transactionHash: string | null;
  readonly error: string | null;
}

export interface TokenInfoView {
  readonly name: string | null;
  readonly tokenName: string | null;
  readonly tokenSymbol: string;
  readonly tokenType: string | null;
  readonly tokenizerEmail: string | null;
  readonly companyWalletAddress: string | null;
  readonly maxTokenSupply: string | null;
  readonly paymentChainId: string | null;
}

export interface TokenizerInfoView {
  readonly companyWalletAddress: string;
  readonly tokenAddress: string;
  readonly paymentTokenAddress: string | null;
  readonly chainId: string;
  readonly email: string | null;
}

export interface WhitelistStatusView {
  readonly isWhitelisted: boolean;
  readonly address: string;
  readonly tokenSymbol: string;
  readonly source: "blockchain";
}

export interface BalanceWhitelistView {
  readonly walletAddress: string;
  readonly tokenAddress: string;
  readonly tokenDecimals: number;
  readonly tokenBalanceRaw: string;
  readonly isWhitelisted: boolean;
  readonly balanceSource: "blockchain";
}

export interface NetworkInfoView {
  readonly currencyName: string | null;
  readonly blockExplorerHost: string | null;
}

export interface BrickkenServerAdapter {
  prepareTokenization(input: PrepareTokenizationInput): Promise<AdapterResult<PreparedOperation>>;
  prepareWhitelist(input: PrepareWhitelistInput): Promise<AdapterResult<PreparedOperation>>;
  prepareMint(
    input: PrepareMintInput,
    evidence: ConfirmedWhitelistEvidence,
  ): Promise<AdapterResult<PreparedOperation>>;
  confirmBroadcast(input: {
    txId: string;
    txHash: string;
  }): Promise<AdapterResult<BroadcastConfirmation>>;
  getTransactionStatus(query: {
    txId?: string;
    hash?: string;
  }): Promise<AdapterResult<TransactionStatusView>>;
  getTokenInfo(query: { tokenSymbol: string }): Promise<AdapterResult<TokenInfoView>>;
  getTokenizerInfo(query: { tokenSymbol: string }): Promise<AdapterResult<TokenizerInfoView>>;
  getWhitelistStatus(query: {
    tokenSymbol: string;
    address: string;
  }): Promise<AdapterResult<WhitelistStatusView>>;
  getBalanceAndWhitelist(query: {
    tokenSymbol: string;
    investorEmail: string;
  }): Promise<AdapterResult<BalanceWhitelistView>>;
  getNetworkInfo(query: { chainId: "11155111" }): Promise<AdapterResult<NetworkInfoView>>;
}
