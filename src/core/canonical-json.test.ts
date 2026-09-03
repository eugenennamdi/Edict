import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalizeJson } from "./canonical-json";

function expectCanonicalError(
  action: () => unknown,
  code: string,
  path: string,
): void {
  try {
    action();
    throw new Error("Expected canonicalization to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalJsonError);
    expect(error).toMatchObject({ code, path });
  }
}

describe("canonicalizeJson", () => {
  it("sorts keys recursively, preserves arrays, and uses compact JSON escaping", () => {
    const input = {
      z: null,
      a: { quote: 'a"b', beta: true, alpha: -0 },
      list: [3, "é", false],
    };
    expect(canonicalizeJson(input)).toBe(
      '{"a":{"alpha":0,"beta":true,"quote":"a\\\"b"},"list":[3,"é",false],"z":null}',
    );
  });

  it("does not mutate input and permits repeated non-cyclic references", () => {
    const shared = { z: 2, a: 1 };
    const input = { right: shared, left: shared };
    const before = JSON.stringify(input);
    expect(canonicalizeJson(input)).toBe(
      '{"left":{"a":1,"z":2},"right":{"a":1,"z":2}}',
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  it("inspects descriptors and rejects a getter without executing it", () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "danger", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "classified-value";
      },
    });

    expectCanonicalError(
      () => canonicalizeJson(input),
      "ACCESSOR_PROPERTY",
      "$.danger",
    );
    expect(getterCalls).toBe(0);
    try {
      canonicalizeJson(input);
    } catch (error) {
      expect(String(error)).not.toContain("classified-value");
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects unexpected non-enumerable object properties", () => {
    const input = { visible: true };
    Object.defineProperty(input, "hidden", { enumerable: false, value: 42 });
    expectCanonicalError(
      () => canonicalizeJson(input),
      "UNEXPECTED_NON_ENUMERABLE_PROPERTY",
      "$.hidden",
    );
  });

  it("allows only array length and enumerable indexed elements", () => {
    expect(canonicalizeJson([1, 2])).toBe("[1,2]");

    const extra = [1];
    Object.defineProperty(extra, "hidden", { enumerable: false, value: 2 });
    expectCanonicalError(
      () => canonicalizeJson(extra),
      "UNEXPECTED_ARRAY_PROPERTY",
      "$.hidden",
    );

    const sparse = new Array(2);
    sparse[1] = "present";
    expectCanonicalError(() => canonicalizeJson(sparse), "SPARSE_ARRAY", "$[0]");
  });

  it("rejects an accessor array element without executing it", () => {
    let getterCalls = 0;
    const input = ["initial"];
    Object.defineProperty(input, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "classified-value";
      },
    });
    expectCanonicalError(() => canonicalizeJson(input), "ACCESSOR_PROPERTY", '$["0"]');
    expect(getterCalls).toBe(0);
  });

  it("rejects cycles at a stable path", () => {
    const input: { child?: unknown } = {};
    input.child = input;
    expectCanonicalError(() => canonicalizeJson(input), "CYCLIC_REFERENCE", "$.child");
  });

  it.each([
    [undefined, "UNSUPPORTED_TYPE"],
    [1n, "UNSUPPORTED_TYPE"],
    [Symbol("value"), "UNSUPPORTED_TYPE"],
    [() => true, "UNSUPPORTED_TYPE"],
    [Number.NaN, "NON_FINITE_NUMBER"],
    [Number.POSITIVE_INFINITY, "NON_FINITE_NUMBER"],
    [1.5, "UNSAFE_NUMBER"],
    [Number.MAX_SAFE_INTEGER + 1, "UNSAFE_NUMBER"],
  ])("rejects unsupported primitive %#", (input, code) => {
    expectCanonicalError(() => canonicalizeJson(input), code, "$");
  });

  it.each([new Date(0), new Map(), new Set(), new Uint8Array([1])])(
    "rejects non-plain object %#",
    (input) => {
      expectCanonicalError(() => canonicalizeJson(input), "NON_PLAIN_OBJECT", "$");
    },
  );

  it("rejects symbol-keyed properties without exposing their values", () => {
    const input = { safe: true, [Symbol("secret")]: "classified-value" };
    expectCanonicalError(() => canonicalizeJson(input), "SYMBOL_KEY", "$");
  });
});
