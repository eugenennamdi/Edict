import "server-only";

import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress, zeroHash } from "viem";
import type { ExecutionRun } from "../execution/types";
import type { TrustedSepoliaRpcClient } from "../rpc/types";
import { getPriceReportSafetyBufferSeconds } from "../rpc/freshness";
import { ERC1967_IMPLEMENTATION_SLOT, REVIEWED_SEPOLIA_FACTORY, REVIEWED_SEPOLIA_IMPLEMENTATION, REVIEWED_TOKENIZE_FUNCTION_SIGNATURE, implementationAddressFromErc1967Slot } from "./tokenize-receipt-binding";

export const TOKENIZE_ABI = parseAbi([`function ${REVIEWED_TOKENIZE_FUNCTION_SIGNATURE}`]);
const TOKEN_UNITS_ABI = parseAbi(["function stoBeaconToken() view returns (address)", "function implementation() view returns (address)", "function decimals() view returns (uint8)"]);
const FEES_ABI = parseAbi(["function getFees((address,uint256,address,address,uint256,uint256,bytes)) view returns (uint256,address)", "function nonces(address) view returns (uint256)"]);

function refuse(): never { throw new Error("TOKENIZE_CANONICAL_SEMANTICS_INVALID"); }

/** All comparisons use the persisted approved plan. Protocol fields remain
 * exact decoded values; this function does not grant them external validity. */
export function canonicalTokenizeCall(run: ExecutionRun, data: string) {
  try {
    const decoded = decodeFunctionData({ abi: TOKENIZE_ABI, data: data.toLowerCase() as `0x${string}` });
    const [config, report, permit] = decoded.args;
    const intent = run.manifest;
    const signer = run.requiredSigner.walletAddress;
    const feeIsZero = report[1] === 0n;
    // ponytail: Brickken sandbox populates signer and factory addresses in permit even when fee is 0 and signatures are zeroed
    const permitIsEmpty = permit[0] === 0n &&
      (permit[1] === zeroAddress || permit[1].toLowerCase() === signer.toLowerCase()) &&
      (permit[2] === zeroAddress || permit[2].toLowerCase() === REVIEWED_SEPOLIA_FACTORY.toLowerCase()) &&
      permit[3] === 0n && permit[4] === 0 &&
      permit[5] === zeroHash && permit[6] === zeroHash;
    const permitIsBound = permit[0] >= report[4] &&
      permit[1].toLowerCase() === signer &&
      permit[2].toLowerCase() === REVIEWED_SEPOLIA_FACTORY &&
      permit[3] >= report[1] && [27, 28].includes(permit[4]) &&
      permit[5] !== zeroHash && permit[6] !== zeroHash;
    if (decoded.functionName !== "newTokenization" ||
      report[2].toLowerCase() !== signer || report[3].toLowerCase() !== signer ||
      config[4] === zeroAddress || (config[5] === zeroAddress) !== config[6] ||
      report[0] === zeroAddress || report[4] <= 0n ||
      !/^0x[0-9a-fA-F]{130}$/.test(report[6]) ||
      ![27, 28].includes(Number.parseInt(report[6].slice(-2), 16)) ||
      BigInt(`0x${report[6].slice(2, 66)}`) === 0n ||
      BigInt(`0x${report[6].slice(66, 130)}`) === 0n ||
      BigInt(`0x${report[6].slice(66, 130)}`) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n ||
      (!feeIsZero && !permitIsBound) || (feeIsZero && !permitIsEmpty)) refuse();
    const canonical = encodeFunctionData({ abi: TOKENIZE_ABI, functionName: "newTokenization", args: [
      [intent.asset.documentationUrl, intent.asset.name, intent.asset.symbol,
        BigInt(intent.asset.supplyCap) * 10n ** 18n, config[4], config[5], config[6], [], []],
      [report[0], report[1], signer as `0x${string}`, signer as `0x${string}`, report[4], report[5], report[6]],
      [permit[0], permit[1], permit[2], permit[3], permit[4], permit[5], permit[6]],
    ] });
    if (canonical !== data.toLowerCase()) refuse();
    return { calldata: canonical, config, report };
  } catch { return refuse(); }
}

/** Only read RPCs. getFees validates the exact report signature, EIP-712
 * chain/factory domain and current FACTORY_OFFCHAIN_REPORTER_ROLE. */
export async function validateTokenizeProtocol(run: ExecutionRun, data: string, rpc: TrustedSepoliaRpcClient): Promise<void> {
  const { config, report } = canonicalTokenizeCall(run, data);
  if (!rpc.call || !rpc.getCode) refuse();
  await rpc.verifyChain();
  const block = await rpc.getLatestBlock();
  if (block.timestamp === null || BigInt(block.timestamp) + BigInt(getPriceReportSafetyBufferSeconds()) >= report[4]) refuse();
  const slot = await rpc.getStorageAt(REVIEWED_SEPOLIA_FACTORY, ERC1967_IMPLEMENTATION_SLOT, block.number);
  if (implementationAddressFromErc1967Slot(slot) !== REVIEWED_SEPOLIA_IMPLEMENTATION) refuse();
  for (const address of [REVIEWED_SEPOLIA_FACTORY, REVIEWED_SEPOLIA_IMPLEMENTATION, config[4], ...(config[6] ? [] : [config[5]])]) {
    if (await rpc.getCode(address, block.number) === "0x") refuse();
  }
  const beacon = decodeFunctionResult({ abi: TOKEN_UNITS_ABI, functionName: "stoBeaconToken", data: await rpc.call({ to: REVIEWED_SEPOLIA_FACTORY, data: encodeFunctionData({ abi: TOKEN_UNITS_ABI, functionName: "stoBeaconToken" }) }, block.number) as `0x${string}` });
  const tokenImplementation = decodeFunctionResult({ abi: TOKEN_UNITS_ABI, functionName: "implementation", data: await rpc.call({ to: beacon, data: encodeFunctionData({ abi: TOKEN_UNITS_ABI, functionName: "implementation" }) }, block.number) as `0x${string}` });
  const decimals = decodeFunctionResult({ abi: TOKEN_UNITS_ABI, functionName: "decimals", data: await rpc.call({ to: tokenImplementation, data: encodeFunctionData({ abi: TOKEN_UNITS_ABI, functionName: "decimals" }) }, block.number) as `0x${string}` });
  if (beacon === zeroAddress || tokenImplementation === zeroAddress || decimals !== 18) refuse();
  const result = await rpc.call({ to: REVIEWED_SEPOLIA_FACTORY, data: encodeFunctionData({ abi: FEES_ABI, functionName: "getFees", args: [report] }) }, block.number);
  const [amount, reporter] = decodeFunctionResult({ abi: FEES_ABI, functionName: "getFees", data: result as `0x${string}` });
  if (amount !== report[1] || reporter === zeroAddress) refuse();
  const nonce = decodeFunctionResult({ abi: FEES_ABI, functionName: "nonces", data: await rpc.call({ to: REVIEWED_SEPOLIA_FACTORY, data: encodeFunctionData({ abi: FEES_ABI, functionName: "nonces", args: [reporter] }) }, block.number) as `0x${string}` });
  if (nonce !== report[5]) refuse();
  // Execute only a read-only simulation against the reviewed implementation.
  // This validates the generated configuration through the actual initializer
  // and protocol rules, without signing, broadcasting or persisting chain state.
  if (await rpc.call({ to: REVIEWED_SEPOLIA_FACTORY, from: run.requiredSigner.walletAddress, data }, block.number) !== "0x") refuse();
}
