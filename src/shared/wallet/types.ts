export type WalletCapabilityState =
  | "UNVERIFIED"
  | "STRUCTURALLY_ELIGIBLE"
  | "APPROVAL_CAPABLE"
  | "EXECUTION_CAPABLE";

export interface EdictEip1193Provider {
  request(input: {
    readonly method: string;
    readonly params?: readonly unknown[] | Record<string, unknown>;
  }): Promise<unknown>;
  on?(event: string, listener: (...args: readonly unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: readonly unknown[]) => void): void;
}

export type WalletSource = "EIP6963" | "LEGACY";

export interface DiscoveredWallet {
  readonly selectionId: string;
  readonly source: WalletSource;
  readonly displayName: string;
  readonly rdns: string | null;
  readonly iconDataUri: string | null;
  readonly metadataTrusted: false;
  readonly status: "AVAILABLE" | "COLLISION";
  readonly capability: WalletCapabilityState;
}

export interface AuthorizedRunProjection {
  readonly id: string;
  readonly manifestHash: `sha256:${string}`;
  readonly planHash: `sha256:${string}`;
  readonly environment: "sandbox";
  readonly chainId: "11155111";
  readonly requiredSigner: {
    readonly role: "tokenizer";
    readonly walletAddress: string;
  };
  readonly phase: string;
  readonly status: string;
  readonly approved: boolean;
  readonly revision: number;
}

export interface AuthorizedExecutionRunProjection extends AuthorizedRunProjection {
  readonly operations: readonly {
    readonly id: string;
    readonly kind: "TOKENIZE" | "WHITELIST" | "MINT";
    readonly stage: string;
    readonly preparedTxId: string | null;
    readonly blockchainTxHash: string | null;
  }[];
}

export type WalletReadiness = Readonly<{
  state:
    | "PROVIDER_UNAVAILABLE"
    | "DISCONNECTED"
    | "UNAUTHORIZED"
    | "REQUIRED_ACCOUNT_UNAVAILABLE"
    | "WRONG_CHAIN"
    | "READY"
    | "INVALIDATED";
  accounts: readonly string[];
  chainId: string | null;
  requiredSigner: string;
  generation: number;
}>;
