export type BrickkenAdapterErrorCode =
  | "CONFIGURATION_MISSING"
  | "AUTHENTICATION_REJECTED"
  | "ENTITLEMENT_REJECTED"
  | "CREDITS_EXHAUSTED"
  | "INVALID_REQUEST"
  | "INVALID_EXTERNAL_RESPONSE"
  | "UNSUPPORTED_TRANSACTION_BATCH"
  | "UNSUPPORTED_CHAIN"
  | "PREPARED_TRANSACTION_INCOMPLETE"
  | "MINT_POLICY_VIOLATION";

export class BrickkenAdapterError extends Error {
  readonly code: BrickkenAdapterErrorCode;

  constructor(code: BrickkenAdapterErrorCode, message: string) {
    super(message);
    this.name = "BrickkenAdapterError";
    this.code = code;
  }
}

const SENSITIVE_HEADER = /^(x-api-key|authorization|cookie|x-payment|payment-signature)$/i;

export function containsSecret(value: string, secret: string | undefined): boolean {
  return Boolean(secret && secret.length > 0 && value.includes(secret));
}

export function redactValue(value: unknown, secret?: string): unknown {
  if (typeof value === "string") {
    if (containsSecret(value, secret)) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, secret));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SENSITIVE_HEADER.test(key) ? "[redacted]" : redactValue(entry, secret);
    }
    return result;
  }
  return value;
}

export function safeErrorMessage(
  code: BrickkenAdapterErrorCode,
  secret?: string,
): BrickkenAdapterError {
  const messages: Record<BrickkenAdapterErrorCode, string> = {
    CONFIGURATION_MISSING: "Brickken sandbox configuration is missing or not allowlisted.",
    AUTHENTICATION_REJECTED: "Brickken rejected the sandbox credential.",
    ENTITLEMENT_REJECTED: "The sandbox credential is not entitled for this token or signer.",
    CREDITS_EXHAUSTED: "The sandbox credential has no remaining credits for this method.",
    INVALID_REQUEST: "The Brickken request was rejected as invalid.",
    INVALID_EXTERNAL_RESPONSE: "The Brickken response could not be trusted.",
    UNSUPPORTED_TRANSACTION_BATCH: "client-broadcast requires exactly one prepared transaction.",
    UNSUPPORTED_CHAIN: "Only Ethereum Sepolia is supported.",
    PREPARED_TRANSACTION_INCOMPLETE:
      "The prepared transaction is missing fields required for a later wallet step.",
    MINT_POLICY_VIOLATION:
      "Mint requires confirmed standalone whitelist evidence and needWhitelist false.",
  };
  const error = new BrickkenAdapterError(code, messages[code]);
  if (containsSecret(error.message, secret)) {
    return new BrickkenAdapterError(code, messages.CONFIGURATION_MISSING);
  }
  return error;
}
