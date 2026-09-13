import "server-only";

import {
  buildExecutionPlanV1,
  canonicalizeJson,
  hashAssetManifestV1,
  hashCanonicalJson,
  sha256Utf8,
  validateAssetManifestV1,
} from "@/core";
import {
  evaluateFeeAuthorizationV1,
  feeAuthorizationV1Schema,
  projectPreparedTransactionV1,
} from "@/shared/wallet";
import { getAddress, isAddress, parseAbiItem, toFunctionSelector } from "viem";
import { formatAbiItem } from "viem/utils";
import type { ExecutionRunV4, OperationKind, PreparationAttemptV1 } from "../execution/types";
import { calculatePreparationFingerprintV1 } from "../execution/v4-transitions";
import { deriveExecutionPreparationProjection } from "./preparation-review";
import {
  DenyAllSemanticAuthorizationEvaluator,
  type SemanticAuthorizationEvaluator,
} from "./v4-service";
import {
  REVIEWED_SEPOLIA_FACTORY,
  REVIEWED_TOKENIZE_FUNCTION_SIGNATURE,
  REVIEWED_TOKENIZE_SELECTOR,
} from "./tokenize-receipt-binding";

export const TOKENIZE_EXECUTION_GATE = "EDICT_TOKENIZE_EXECUTION_ENABLED" as const;
export const TOKENIZE_ALLOWED_DESTINATION = "EDICT_TOKENIZE_ALLOWED_DESTINATION" as const;
export const TOKENIZE_FUNCTION_SIGNATURE = "EDICT_TOKENIZE_FUNCTION_SIGNATURE" as const;
export const TOKENIZE_CALLDATA_COMMITMENT = "EDICT_TOKENIZE_CALLDATA_COMMITMENT" as const;
export const TOKENIZE_POLICY_VERSION = "edict-tokenize-semantic-v1" as const;

export type TokenizeAuthorizationDenialReason =
  | "TOKENIZE_GATE_DISABLED"
  | "POLICY_CONFIG_INVALID"
  | "WRONG_OPERATION"
  | "WRONG_CHAIN"
  | "SIGNER_MISMATCH"
  | "APPROVAL_MISMATCH"
  | "MANIFEST_MISMATCH"
  | "PLAN_MISMATCH"
  | "PREPARATION_MISMATCH"
  | "DESTINATION_NOT_ALLOWED"
  | "SELECTOR_NOT_ALLOWED"
  | "CALLDATA_COMMITMENT_MISMATCH"
  | "FEE_AUTHORIZATION_INVALID"
  | "MALFORMED_DURABLE_STATE";

export interface TokenizeSemanticAuthorizationPolicy {
  readonly policyVersion: typeof TOKENIZE_POLICY_VERSION;
  readonly allowedDestination: `0x${string}`;
  readonly reviewedFunctionSignature: string;
  readonly allowedSelector: `0x${string}`;
  readonly allowedCalldataCommitment: `sha256:${string}`;
  readonly brickkenMethod: "newTokenization";
  readonly executionMode: "client-broadcast";
}

export class TokenizePolicyConfigurationError extends Error {
  readonly code = "TOKENIZE_POLICY_CONFIGURATION_INVALID";

  constructor() {
    super("TOKENIZE_POLICY_CONFIGURATION_INVALID");
    this.name = "TokenizePolicyConfigurationError";
  }
}

function privateGateExposed(environment: Readonly<Record<string, string | undefined>>): boolean {
  return Object.keys(environment).some((key) => key.startsWith("NEXT_PUBLIC_EDICT_TOKENIZE_"));
}

export function deriveTokenizeSelectorFromCanonicalSignature(
  signature: string,
): `0x${string}` {
  try {
    const item = parseAbiItem(`function ${signature}`);
    if (
      item.type !== "function" ||
      formatAbiItem(item) !== signature ||
      signature.length > 512
    ) {
      throw new TokenizePolicyConfigurationError();
    }
    return toFunctionSelector(item).toLowerCase() as `0x${string}`;
  } catch (error) {
    if (error instanceof TokenizePolicyConfigurationError) throw error;
    throw new TokenizePolicyConfigurationError();
  }
}

function readPolicy(environment: Readonly<Record<string, string | undefined>>): TokenizeSemanticAuthorizationPolicy | null {
  const destination = environment[TOKENIZE_ALLOWED_DESTINATION];
  const signature = environment[TOKENIZE_FUNCTION_SIGNATURE];
  const calldataCommitment = environment[TOKENIZE_CALLDATA_COMMITMENT];
  if (
    !destination || !signature || !isAddress(destination) ||
    destination === "0x0000000000000000000000000000000000000000" ||
    !calldataCommitment || !/^sha256:[0-9a-f]{64}$/.test(calldataCommitment)
  ) {
    return null;
  }
  try {
    const allowedDestination = getAddress(destination).toLowerCase() as `0x${string}`;
    const allowedSelector = deriveTokenizeSelectorFromCanonicalSignature(signature);
    if (
      allowedDestination !== REVIEWED_SEPOLIA_FACTORY ||
      signature !== REVIEWED_TOKENIZE_FUNCTION_SIGNATURE ||
      allowedSelector !== REVIEWED_TOKENIZE_SELECTOR
    ) return null;
    return Object.freeze({
      policyVersion: TOKENIZE_POLICY_VERSION,
      allowedDestination,
      reviewedFunctionSignature: signature,
      allowedSelector,
      allowedCalldataCommitment: calldataCommitment as `sha256:${string}`,
      brickkenMethod: "newTokenization",
      executionMode: "client-broadcast",
    });
  } catch {
    return null;
  }
}

export function readTokenizeSemanticAuthorizationPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<
  | { enabled: true; policy: TokenizeSemanticAuthorizationPolicy }
  | { enabled: false; reason: "TOKENIZE_GATE_DISABLED" | "POLICY_CONFIG_INVALID" }
> {
  if (privateGateExposed(environment)) throw new TokenizePolicyConfigurationError();
  if (environment[TOKENIZE_EXECUTION_GATE] !== "1") {
    return Object.freeze({ enabled: false, reason: "TOKENIZE_GATE_DISABLED" });
  }
  const policy = readPolicy(environment);
  return policy === null
    ? Object.freeze({ enabled: false, reason: "POLICY_CONFIG_INVALID" })
    : Object.freeze({ enabled: true, policy });
}

function denied(reason: TokenizeAuthorizationDenialReason) {
  return Object.freeze({ authorized: false as const, reason });
}

export class TokenizeOnlySemanticAuthorizationEvaluator implements SemanticAuthorizationEvaluator {
  readonly isProductionDenyAll = false;
  readonly policy: TokenizeSemanticAuthorizationPolicy;

  constructor(policy: TokenizeSemanticAuthorizationPolicy) {
    const validated = readPolicy({
      [TOKENIZE_ALLOWED_DESTINATION]: policy.allowedDestination,
      [TOKENIZE_FUNCTION_SIGNATURE]: policy.reviewedFunctionSignature,
      [TOKENIZE_CALLDATA_COMMITMENT]: policy.allowedCalldataCommitment,
    });
    if (
      validated === null || validated.policyVersion !== policy.policyVersion ||
      validated.allowedSelector !== policy.allowedSelector ||
      policy.brickkenMethod !== "newTokenization" || policy.executionMode !== "client-broadcast"
    ) throw new TokenizePolicyConfigurationError();
    this.policy = validated;
  }

  async evaluate(input: {
    readonly run: ExecutionRunV4;
    readonly kind: OperationKind;
    readonly attempt: PreparationAttemptV1;
  }) {
    const { run, kind, attempt } = input;
    if (kind !== "TOKENIZE") return denied("WRONG_OPERATION");
    if (run.environment !== "sandbox" || run.chainId !== "11155111") return denied("WRONG_CHAIN");

    const operation = run.operations[0];
    const active = operation.preparationAttempts.find(
      (candidate) => candidate.attemptId === operation.activePreparationAttemptId,
    );
    if (
      operation.kind !== "TOKENIZE" || operation.stage !== "PREPARED" ||
      active === undefined || active !== attempt || attempt.state !== "PREPARED" ||
      operation.preparedTxId !== attempt.txId ||
      canonicalizeJson(operation.unsignedTransaction) !== canonicalizeJson(attempt.unsignedTransaction)
    ) return denied("PREPARATION_MISMATCH");

    const approval = run.approval;
    const proof = approval.proof;
    if (
      approval.planHash !== run.planHash || approval.approvedByWallet !== run.requiredSigner.walletAddress ||
      approval.approvalRevision > run.revision || proof.runId !== run.id ||
      proof.approvalRevision !== approval.approvalRevision || proof.typedDataDigest.length !== 66 ||
      proof.manifestHash !== run.manifestHash || proof.planHash !== run.planHash ||
      proof.environment !== run.environment || proof.chainId !== run.chainId ||
      proof.requiredSigner !== run.requiredSigner.walletAddress ||
      proof.recoveredSigner !== approval.approvedByWallet
    ) return denied("APPROVAL_MISMATCH");

    if (
      run.manifest.environment !== run.environment || run.manifest.chainId !== run.chainId ||
      run.manifest.tokenizer.walletAddress !== run.requiredSigner.walletAddress
    ) return denied("MANIFEST_MISMATCH");
    const manifest = validateAssetManifestV1(run.manifest);
    if (!manifest.ok || (await hashAssetManifestV1(manifest.value)).hash !== run.manifestHash) {
      return denied("MANIFEST_MISMATCH");
    }
    const plan = await buildExecutionPlanV1(manifest.value);
    if (
      plan.planHash !== run.planHash || run.plan.planHash !== run.planHash ||
      run.plan.manifestHash !== run.manifestHash || run.plan.environment !== run.environment ||
      run.plan.chainId !== run.chainId ||
      run.plan.requiredSigner.walletAddress !== run.requiredSigner.walletAddress ||
      plan.operations[0].kind !== "TOKENIZE"
    ) return denied("PLAN_MISMATCH");

    if (
      attempt.txId === null || attempt.preparedAt === null || attempt.preparedRunRevision === null ||
      attempt.preparationFingerprint === null || attempt.immutableIdentity === null ||
      attempt.feeAuthorization === null || attempt.unsignedTransaction === null
    ) return denied("PREPARATION_MISMATCH");
    if (
      attempt.attemptId !== operation.activePreparationAttemptId ||
      attempt.preparedRunRevision > run.revision ||
      attempt.preparationFingerprint !== await calculatePreparationFingerprintV1({
        run,
        kind,
        attemptId: attempt.attemptId,
        txId: attempt.txId,
        preparedAt: attempt.preparedAt,
        preparedRunRevision: attempt.preparedRunRevision,
        immutableIdentity: attempt.immutableIdentity,
        feeAuthorization: attempt.feeAuthorization,
      })
    ) return denied("PREPARATION_MISMATCH");

    let prepared: ReturnType<typeof projectPreparedTransactionV1>;
    try {
      prepared = projectPreparedTransactionV1(attempt.unsignedTransaction);
    } catch {
      return denied("MALFORMED_DURABLE_STATE");
    }
    const request = prepared.walletRequest;
    const identity = attempt.immutableIdentity;
    if (prepared.chainId !== "0xaa36a7" || identity.chainId !== "11155111") return denied("WRONG_CHAIN");
    if (run.requiredSigner.walletAddress !== identity.from || request.from !== identity.from) {
      return denied("SIGNER_MISMATCH");
    }
    if (
      request.to !== identity.to || request.data !== identity.data ||
      request.value !== identity.value || request.nonce !== identity.nonce
    ) return denied("PREPARATION_MISMATCH");
    if (identity.to !== this.policy.allowedDestination) return denied("DESTINATION_NOT_ALLOWED");
    if (identity.data.slice(0, 10) !== this.policy.allowedSelector) return denied("SELECTOR_NOT_ALLOWED");
    const calldataCommitment = await sha256Utf8(identity.data);
    if (
      calldataCommitment !== this.policy.allowedCalldataCommitment ||
      calldataCommitment !== await sha256Utf8(request.data ?? "")
    ) {
      return denied("CALLDATA_COMMITMENT_MISMATCH");
    }

    try {
      feeAuthorizationV1Schema.parse(attempt.feeAuthorization);
      if (
        request.type !== attempt.feeAuthorization.transactionType ||
        request.gas !== attempt.feeAuthorization.preparedDefaults.gasLimit ||
        request.maxFeePerGas !== attempt.feeAuthorization.preparedDefaults.maxFeePerGas ||
        request.maxPriorityFeePerGas !==
          attempt.feeAuthorization.preparedDefaults.maxPriorityFeePerGas ||
        request.gasPrice !== undefined ||
        canonicalizeJson(request.accessList ?? []) !==
          canonicalizeJson(attempt.feeAuthorization.preparedAccessList)
      ) return denied("FEE_AUTHORIZATION_INVALID");
      const feeDecision = evaluateFeeAuthorizationV1(attempt.feeAuthorization, {
        transactionType: request.type,
        gasLimit: request.gas,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
        gasPrice: request.gasPrice,
        accessList: request.accessList ?? [],
      });
      if (!feeDecision.accepted) return denied("FEE_AUTHORIZATION_INVALID");
    } catch {
      return denied("FEE_AUTHORIZATION_INVALID");
    }

    const review = await deriveExecutionPreparationProjection(run);
    if (
      review?.preparationStatus !== "PREPARED_FOR_REVIEW" || review.transactionReview === null ||
      review.transactionReview.runRevision !== run.revision ||
      review.transactionReview.preparedTransactionId !== attempt.txId ||
      review.transactionReview.requiredSigner !== identity.from ||
      canonicalizeJson(review.transactionReview.walletRequest) !== canonicalizeJson(request)
    ) return denied("PREPARATION_MISMATCH");

    const authorizationId = (await hashCanonicalJson({
      domain: "edict.tokenize-semantic-authorization.v1",
      policyVersion: this.policy.policyVersion,
      runId: run.id,
      runRevision: run.revision,
      approvalIdentity: {
        approvalRevision: approval.approvalRevision,
        typedDataDigest: proof.typedDataDigest,
      },
      manifestHash: run.manifestHash,
      planHash: run.planHash,
      operation: { id: operation.id, kind, sequence: 1 },
      preparationAttemptId: attempt.attemptId,
      preparedTxId: attempt.txId,
      preparationFingerprint: attempt.preparationFingerprint,
      preparedTransactionReviewFingerprint:
        review.transactionReview.integrity.preparedTransactionFingerprint,
      immutableIdentity: identity,
      feeAuthorization: attempt.feeAuthorization,
      destination: this.policy.allowedDestination,
      selector: this.policy.allowedSelector,
      calldataCommitment,
      brickkenMethod: this.policy.brickkenMethod,
      executionMode: this.policy.executionMode,
    })).hash;

    return Object.freeze({
      authorized: true as const,
      semanticAuthorization: Object.freeze({
        authorizationVersion: "1.0" as const,
        policyVersion: this.policy.policyVersion,
        authorizationId,
        environment: "sandbox" as const,
        brickkenMethod: "newTokenization" as const,
        executionMode: "client-broadcast" as const,
        destinationPolicy: Object.freeze({
          policyId: "edict-tokenize-destination-v1",
          reviewedDestination: this.policy.allowedDestination,
        }),
        selectorPolicy: Object.freeze({
          policyId: "edict-tokenize-selector-v1",
          reviewedSelector: this.policy.allowedSelector,
        }),
        calldataCommitment,
        decision: "ALLOW" as const,
      }),
    });
  }
}

export function createProductionSemanticAuthorizationEvaluator(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SemanticAuthorizationEvaluator {
  const config = readTokenizeSemanticAuthorizationPolicy(environment);
  if (!config.enabled) {
    return new DenyAllSemanticAuthorizationEvaluator(config.reason);
  }
  return new TokenizeOnlySemanticAuthorizationEvaluator(config.policy);
}
