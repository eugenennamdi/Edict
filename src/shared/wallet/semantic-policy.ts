import type { WalletTransactionRequestV1 } from "./transaction";

export type WalletOperationKind = "TOKENIZE" | "WHITELIST" | "MINT";

export interface WalletSemanticPolicyInput {
  readonly operationKind: WalletOperationKind;
  readonly chainId: "11155111";
  readonly walletRequest: WalletTransactionRequestV1;
}

export type WalletSemanticPolicyResult =
  | Readonly<{ allowed: true; policyVersion: string; authorizationId: string }>
  | Readonly<{
      allowed: false;
      code:
        | "SEMANTIC_POLICY_UNVERIFIED"
        | "DESTINATION_MISMATCH"
        | "SELECTOR_MISMATCH"
        | "VALUE_MISMATCH"
        | "CALLDATA_COMMITMENT_MISMATCH";
    }>;

export interface WalletSemanticPolicy {
  authorize(input: WalletSemanticPolicyInput): WalletSemanticPolicyResult;
}

export const denyAllWalletSemanticPolicy: WalletSemanticPolicy = Object.freeze({
  authorize: () => Object.freeze({ allowed: false as const, code: "SEMANTIC_POLICY_UNVERIFIED" as const }),
});
