import { validateAssetManifestV1 } from "@/core/manifest";
import { creationRequest, type PlanningIssue, type PlanningView } from "./run-planning";

export const fields = [
  { name: "assetName", path: "asset.name", label: "Asset name", section: "asset", hint: "Up to 120 characters after normalization.", placeholder: "Name the asset", type: "text", wide: true },
  { name: "symbol", path: "asset.symbol", label: "Token symbol", section: "asset", hint: "3–5 letters or digits. Normalized to uppercase.", placeholder: "e.g. RWA", type: "text" },
  { name: "supplyCap", path: "asset.supplyCap", label: "Supply cap", section: "asset", hint: "Maximum supply, in whole tokens.", placeholder: "0", type: "text", numeric: true },
  { name: "documentationUrl", path: "asset.documentationUrl", label: "Documentation URL", section: "asset", hint: "An HTTPS document URL without embedded credentials.", placeholder: "https://", type: "url", wide: true },
  { name: "tokenizerEmail", path: "tokenizer.email", label: "Tokenizer email", section: "authority", placeholder: "name@company.com", type: "email", wide: true },
  { name: "tokenizerWallet", path: "tokenizer.walletAddress", label: "Required signer address", section: "authority", hint: "The tokenizer’s public Ethereum address. No wallet connection needed to plan.", placeholder: "0x…", type: "text", wide: true, mono: true },
  { name: "investorEmail", path: "investor.email", label: "Investor email", section: "allocation", hint: "Must differ from the tokenizer email.", placeholder: "name@company.com", type: "email", wide: true },
  { name: "investorWallet", path: "investor.walletAddress", label: "Recipient address", section: "allocation", hint: "The investor’s public Ethereum address.", placeholder: "0x…", type: "text", wide: true, mono: true },
  { name: "mintAmount", path: "investor.mintAmount", label: "Planned mint amount", section: "allocation", hint: "Whole tokens, no greater than the supply cap.", placeholder: "0", type: "text", numeric: true },
] as const;

export type FieldName = typeof fields[number]["name"];
export type Draft = Record<FieldName, string>;
export const emptyDraft: Draft = { assetName: "", symbol: "", supplyCap: "", documentationUrl: "", tokenizerEmail: "", tokenizerWallet: "", investorEmail: "", investorWallet: "", mintAmount: "" };
export function draftForm(draft: Draft) { return { get: (name: string) => draft[name as FieldName] ?? "" }; }
export function draftIssues(draft: Draft): readonly PlanningIssue[] {
  const result = validateAssetManifestV1(creationRequest(draftForm(draft)).manifest);
  return result.ok ? [] : result.errors;
}
export function issueMessage(issue: PlanningIssue) {
  switch (issue.code) {
    case "EMAILS_MUST_DIFFER": return "Use an email different from the tokenizer email.";
    case "INVALID_ASSET_NAME": return "Enter an asset name of 1–120 characters after normalization.";
    case "INVALID_DOCUMENTATION_URL": return "Use a full HTTPS URL without a username or password.";
    case "INVALID_INVESTOR_EMAIL":
    case "INVALID_TOKENIZER_EMAIL": return "Enter a valid email address.";
    case "INVALID_POSITIVE_INTEGER": return "Enter a positive whole-token amount, using digits only.";
    case "INVALID_TOKEN_SYMBOL": return "Use 3–5 letters or digits.";
    case "INVALID_WALLET_ADDRESS": return "Use 0x followed by 40 hexadecimal characters.";
    case "MINT_EXCEEDS_SUPPLY": return "The mint amount must not exceed the supply cap.";
    case "REQUIRED_FIELD": return "Complete this field.";
    default: return "Check this field and try again.";
  }
}

export const operationLabels: Record<PlanningView["plan"]["operations"][number]["kind"], string> = {
  TOKENIZE: "Create tokenization", CONFIRM_TOKENIZATION: "Confirm tokenization & read back",
  WHITELIST_INVESTOR: "Whitelist investor", CONFIRM_WHITELIST: "Confirm whitelist",
  MINT: "Mint allocation", CONFIRM_MINT: "Confirm mint & balance", VERIFY_DEPLOYMENT: "Verify deployment",
};

export function recordStatus(run: PlanningView["run"]) {
  if (run.terminalOutcome === "CANCELLED") return "Run canceled";
  if (run.terminalOutcome === "VERIFICATION_FAILED") return "Verification failed";
  if (run.terminalOutcome === "FAILED") return "Run failed";
  const labels: Record<PlanningView["run"]["status"], string> = {
    AWAITING_APPROVAL: "Awaiting approval", PREPARING: "Preparation stage", AWAITING_WALLET: "Awaiting wallet",
    BROADCAST_RECORDED: "Transaction hash recorded", CONFIRMING: "Confirmation stage", SUCCEEDED: "Run reports success",
    TIMED_OUT: "Confirmation timed out", FAILED: "Run failed", RECONCILIATION_REQUIRED: "Reconciliation required",
  };
  return labels[run.status];
}

export function displayUtc(value: string) { return value.replace("T", " · ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC"); }
