export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value);
    }
  }

  return Object.freeze(value) as DeepReadonly<T>;
}

export function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !Object.isFrozen(value)) {
    return value === null || typeof value !== "object";
  }

  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !("value" in descriptor) || isDeepFrozen(descriptor.value);
  });
}
