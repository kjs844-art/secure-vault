import { describe, expect, it, vi } from "vitest";
import { parseSyntheticConnectionEdit } from "./syntheticConnectionEdit";

const valid = () => ({ reference: 0, connectionIds: [0, 1, 2] });

describe("closed synthetic connection edit selection", () => {
  it.each([[], [0], [2, 0, 1]].map((connectionIds) => ({ connectionIds })))("copies and freezes ordered fixture IDs $connectionIds", ({ connectionIds }) => {
    const input = { reference: 127, connectionIds };
    const result = parseSyntheticConnectionEdit(input);
    expect(result).toEqual(input);
    expect(result.connectionIds).not.toBe(input.connectionIds);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.connectionIds)).toBe(true);
  });
  it.each([
    null, [], "PRIVATE_TEXT", {}, Object.create(valid()) as unknown,
    ...[-1, 128, NaN, Infinity, 0.5, 2 ** 32, "0", null].map((reference) => ({ ...valid(), reference })),
    ...[[0, 0], [3], [NaN], [0.5], [2 ** 32], [0, 1, 2, 0], new Array(1), new Uint32Array([0])]
      .map((connectionIds) => ({ ...valid(), connectionIds })),
    { ...valid(), revisionId: "private" }, { ...valid(), recordId: "private" },
    { ...valid(), secret: "private" }, { ...valid(), [Symbol("extra")]: 1 },
  ])("rejects unsupported shapes with only a fixed error", (input) => {
    expect(() => parseSyntheticConnectionEdit(input)).toThrow("INVALID_ARCHIVE");
  });
  it("rejects accessors without evaluating them", () => {
    const getter = vi.fn(() => 0);
    for (const key of ["reference", "connectionIds"]) {
      const input = Object.defineProperty(valid(), key, { get: getter });
      expect(() => parseSyntheticConnectionEdit(input)).toThrow("INVALID_ARCHIVE");
    }
    const input = valid();
    Object.defineProperty(input.connectionIds, "0", { get: getter });
    expect(() => parseSyntheticConnectionEdit(input)).toThrow("INVALID_ARCHIVE");
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects hidden fields, nested extras, and inspection failures", () => {
    const hidden = Object.defineProperty(valid(), "reference", { enumerable: false });
    const extra = { reference: 0, connectionIds: Object.assign([0], { text: "private" }) };
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("private"); } });
    for (const input of [hidden, extra, hostile]) expect(() => parseSyntheticConnectionEdit(input)).toThrow("INVALID_ARCHIVE");
  });
  it("bounds length before enumerating connection elements", () => {
    const enumerate = vi.fn(() => { throw new Error("private"); });
    const connectionIds = new Proxy(new Array(4), { ownKeys: enumerate });
    expect(() => parseSyntheticConnectionEdit({ reference: 0, connectionIds })).toThrow("INVALID_ARCHIVE");
    expect(enumerate).not.toHaveBeenCalled();
  });
});
