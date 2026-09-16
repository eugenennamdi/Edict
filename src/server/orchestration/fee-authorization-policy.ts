import "server-only";

import { feeAuthorizationV1Schema, type FeeAuthorizationV1 } from "@/shared/wallet/execution-authorization";

const MAX_UINT256 = (1n << 256n) - 1n;

/** Private deployment policy. Browser requests and manifests cannot supply these limits. */
export const SERVER_FEE_AUTHORIZATION_POLICY_V1 = Object.freeze({
  gasLimitHeadroomBps: 15_000n,
  maxFeeHeadroomBps: 30_000n,
  priorityFeeHeadroomBps: 30_000n,
  gasLimitAbsoluteCeiling: 8_000_000n,
  maxFeePerGasFloor: 3_000_000_000n,
  maxFeePerGasAbsoluteCeiling: 10_000_000_000n,
  maxPriorityFeePerGasFloor: 3_000_000_000n,
  maxPriorityFeePerGasAbsoluteCeiling: 3_000_000_000n,
  maximumNetworkFeeAbsoluteCeiling: 100_000_000_000_000_000n,
});

const ceilBps = (value: bigint, bps: bigint) => (value * bps + 9_999n) / 10_000n;
const min = (left: bigint, right: bigint) => left < right ? left : right;
const max = (left: bigint, right: bigint) => left > right ? left : right;

export function createServerBoundedFeeAuthorizationV1(input: {
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly preparedAccessList?: readonly Readonly<{ address: string; storageKeys: readonly string[] }>[];
}): FeeAuthorizationV1 {
  const preparedDefaults = { gasLimit: input.gasLimit, maxFeePerGas: input.maxFeePerGas, maxPriorityFeePerGas: input.maxPriorityFeePerGas };
  const policy = SERVER_FEE_AUTHORIZATION_POLICY_V1;
  const preparedGas = BigInt(input.gasLimit);
  const preparedMaxFee = BigInt(input.maxFeePerGas);
  const preparedPriority = BigInt(input.maxPriorityFeePerGas);
  const gasLimit = min(ceilBps(preparedGas, policy.gasLimitHeadroomBps), policy.gasLimitAbsoluteCeiling);
  const maxFeePerGas = min(max(ceilBps(preparedMaxFee, policy.maxFeeHeadroomBps), policy.maxFeePerGasFloor), policy.maxFeePerGasAbsoluteCeiling);
  const maxPriorityFeePerGas = min(min(max(ceilBps(preparedPriority, policy.priorityFeeHeadroomBps), policy.maxPriorityFeePerGasFloor), policy.maxPriorityFeePerGasAbsoluteCeiling), maxFeePerGas);
  const maximumNetworkFee = gasLimit * maxFeePerGas;
  if (preparedGas > gasLimit || preparedMaxFee > maxFeePerGas || preparedPriority > maxPriorityFeePerGas || maximumNetworkFee > MAX_UINT256 || maximumNetworkFee > policy.maximumNetworkFeeAbsoluteCeiling)
    throw new TypeError("INVALID_FEE_AUTHORIZATION");
  return feeAuthorizationV1Schema.parse({
    authorizationVersion: "1.0", feeModel: "EIP1559", transactionType: "0x2",
    preparedDefaults,
    authorizedCaps: {
      gasLimit: `0x${gasLimit.toString(16)}`,
      maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
      maximumNetworkFeeWei: `0x${maximumNetworkFee.toString(16)}`,
    },
    preparedAccessList: (input.preparedAccessList ?? []).map((entry) => ({ address: entry.address, storageKeys: [...entry.storageKeys] })),
    adjustmentPolicy: "SERVER_BOUNDED_HEADROOM",
  });
}
