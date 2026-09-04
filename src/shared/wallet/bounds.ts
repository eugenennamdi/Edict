import { WALLET_BOUNDARY_LIMITS } from "./limits";

export interface BoundedWalletValueOptions {
  readonly maxCodeUnits: number;
  readonly maxArrayLength?: number;
  readonly maxProperties?: number;
}

export function assertBoundedWalletValue(
  raw: unknown,
  options: BoundedWalletValueOptions,
): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let codeUnits = 0;

  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (
      nodes > WALLET_BOUNDARY_LIMITS.externalStructureNodes ||
      depth > WALLET_BOUNDARY_LIMITS.externalStructureDepth
    ) throw new TypeError("Wallet value exceeds structural limits.");
    if (typeof value === "string") {
      codeUnits += value.length;
      if (codeUnits > options.maxCodeUnits) throw new TypeError("Wallet value exceeds size limits.");
      return;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return;
    if (typeof value !== "object") throw new TypeError("Wallet value is not JSON data.");
    if (seen.has(value)) throw new TypeError("Wallet value is cyclic.");
    seen.add(value);

    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)) {
        throw new TypeError("Wallet array is malformed.");
      }
      const length = lengthDescriptor.value as number;
      if (length > (options.maxArrayLength ?? WALLET_BOUNDARY_LIMITS.externalStructureNodes)) {
        throw new TypeError("Wallet array exceeds limits.");
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== length + 1 ||
        keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))
      ) throw new TypeError("Wallet array is sparse or extended.");
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("Wallet array property is unsafe.");
        }
        visit(descriptor.value, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Wallet object is not plain.");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > (options.maxProperties ?? WALLET_BOUNDARY_LIMITS.externalStructureNodes)) {
      throw new TypeError("Wallet object exceeds limits.");
    }
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("Wallet object symbol is unsafe.");
      codeUnits += key.length;
      if (codeUnits > options.maxCodeUnits) throw new TypeError("Wallet value exceeds size limits.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Wallet object property is unsafe.");
      }
      visit(descriptor.value, depth + 1);
    }
  };

  try {
    visit(raw, 0);
  } catch {
    throw new TypeError("Wallet value failed bounded inspection.");
  }
}
