export const PHASE8_ACTIONS = [
  "BRICKKEN_READ",
  "BRICKKEN_PREPARE",
  "WALLET_APPROVAL",
  "WALLET_SEND",
  "RPC_TRANSACTION_COMPARE",
  "BRICKKEN_CONFIRM",
  "BRICKKEN_POLL",
  "RPC_FINALITY",
  "BRICKKEN_READ_BACK",
] as const;

export const PHASE8_OPERATIONS = ["TOKENIZE", "WHITELIST", "MINT"] as const;

export type Phase8Action = (typeof PHASE8_ACTIONS)[number];
export type Phase8Operation = (typeof PHASE8_OPERATIONS)[number];

export interface Phase8PublicTarget {
  readonly action: Phase8Action;
  readonly runId: string;
  readonly operation: Phase8Operation;
  readonly walletRequestHash: `sha256:${string}` | null;
}

export interface Phase8HarnessConfig {
  readonly mode: "sandbox";
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly target: Phase8PublicTarget;
  readonly allowedEnvironment: Readonly<Record<string, string>>;
}

export interface Phase8ActionContext {
  readonly target: Phase8PublicTarget;
  readonly allowedEnvironment: Readonly<Record<string, string>>;
}

export interface Phase8ActionExecutor {
  execute(context: Phase8ActionContext): Promise<import("./evidence").Phase8ActionEvidenceV1>;
  cleanup?(): Promise<void>;
}
