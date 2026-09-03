export type CanonicalJsonErrorCode =
  | "ACCESSOR_PROPERTY"
  | "CYCLIC_REFERENCE"
  | "NON_FINITE_NUMBER"
  | "NON_PLAIN_OBJECT"
  | "SPARSE_ARRAY"
  | "SYMBOL_KEY"
  | "UNEXPECTED_ARRAY_PROPERTY"
  | "UNEXPECTED_NON_ENUMERABLE_PROPERTY"
  | "UNSAFE_NUMBER"
  | "UNSUPPORTED_TYPE";

const canonicalErrorMessages: Readonly<Record<CanonicalJsonErrorCode, string>> = {
  ACCESSOR_PROPERTY: "Accessor-backed properties are not canonicalizable.",
  CYCLIC_REFERENCE: "Cyclic references are not canonicalizable.",
  NON_FINITE_NUMBER: "Non-finite numbers are not canonicalizable.",
  NON_PLAIN_OBJECT: "Only plain objects and arrays are canonicalizable.",
  SPARSE_ARRAY: "Sparse arrays are not canonicalizable.",
  SYMBOL_KEY: "Symbol-keyed properties are not canonicalizable.",
  UNEXPECTED_ARRAY_PROPERTY: "Arrays may contain only indexed elements and length.",
  UNEXPECTED_NON_ENUMERABLE_PROPERTY: "Non-enumerable object properties are not canonicalizable.",
  UNSAFE_NUMBER: "Only safe integers are canonicalizable.",
  UNSUPPORTED_TYPE: "The value type is not canonicalizable.",
};

export class CanonicalJsonError extends Error {
  readonly code: CanonicalJsonErrorCode;
  readonly path: string;

  constructor(code: CanonicalJsonErrorCode, path: string) {
    super(canonicalErrorMessages[code]);
    this.name = "CanonicalJsonError";
    this.code = code;
    this.path = path;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function serializeArray(
  value: unknown[],
  path: string,
  activeAncestors: WeakSet<object>,
): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT", path);
  }

  const indexedDescriptors = new Map<number, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new CanonicalJsonError("SYMBOL_KEY", path);
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    const propertyPath = key === "length" ? path : childPath(path, key);
    if (!("value" in descriptor)) {
      throw new CanonicalJsonError("ACCESSOR_PROPERTY", propertyPath);
    }

    if (key === "length") {
      if (descriptor.enumerable) {
        throw new CanonicalJsonError("UNEXPECTED_ARRAY_PROPERTY", propertyPath);
      }
      continue;
    }

    if (!descriptor.enumerable || !isCanonicalArrayIndex(key, value.length)) {
      throw new CanonicalJsonError("UNEXPECTED_ARRAY_PROPERTY", propertyPath);
    }
    indexedDescriptors.set(Number(key), descriptor);
  }

  const serialized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = indexedDescriptors.get(index);
    if (!descriptor) {
      throw new CanonicalJsonError("SPARSE_ARRAY", `${path}[${index}]`);
    }
    serialized.push(serializeValue(descriptor.value, `${path}[${index}]`, activeAncestors));
  }

  return `[${serialized.join(",")}]`;
}

function serializePlainObject(
  value: object,
  path: string,
  activeAncestors: WeakSet<object>,
): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT", path);
  }

  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new CanonicalJsonError("SYMBOL_KEY", path);
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    const propertyPath = childPath(path, key);
    if (!("value" in descriptor)) {
      throw new CanonicalJsonError("ACCESSOR_PROPERTY", propertyPath);
    }
    if (!descriptor.enumerable) {
      throw new CanonicalJsonError("UNEXPECTED_NON_ENUMERABLE_PROPERTY", propertyPath);
    }
    descriptors.set(key, descriptor);
  }

  const entries = [...descriptors.keys()].sort(compareCodeUnits).map((key) => {
    const descriptor = descriptors.get(key)!;
    return `${JSON.stringify(key)}:${serializeValue(descriptor.value, childPath(path, key), activeAncestors)}`;
  });
  return `{${entries.join(",")}}`;
}

function serializeValue(value: unknown, path: string, activeAncestors: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError("NON_FINITE_NUMBER", path);
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError("UNSAFE_NUMBER", path);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new CanonicalJsonError("UNSUPPORTED_TYPE", path);
    case "object":
      if (activeAncestors.has(value)) {
        throw new CanonicalJsonError("CYCLIC_REFERENCE", path);
      }
      activeAncestors.add(value);
      try {
        return Array.isArray(value)
          ? serializeArray(value, path, activeAncestors)
          : serializePlainObject(value, path, activeAncestors);
      } finally {
        activeAncestors.delete(value);
      }
  }

  throw new CanonicalJsonError("UNSUPPORTED_TYPE", path);
}

export function canonicalizeJson(value: unknown): string {
  return serializeValue(value, "$", new WeakSet<object>());
}
