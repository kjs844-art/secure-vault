import { describe, expect, it, vi } from "vitest";
import { parseSyntheticRegistration } from "./syntheticRegistration";

const valid = () => ({ profileId: 0, credentialId: 0, connectionIds: [0, 1, 2] });

describe("closed synthetic registration selection", () => {
  it.each([{ connections: [] }, { connections: [0] }, { connections: [2, 0, 1] }])("copies and freezes allowed ordered connections $connections", ({ connections }) => {
    const input = { profileId: 1, credentialId: 0, connectionIds: connections };
    const result = parseSyntheticRegistration(input);
    expect(result).toEqual(input);
    expect(result.connectionIds).not.toBe(connections);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.connectionIds)).toBe(true);
  });
  it.each([
    null, [], "DEMO_VALUE_ONLY", {},
    { ...valid(), profileId: 2 }, { ...valid(), profileId: NaN },
    { ...valid(), profileId: 0.5 }, { ...valid(), profileId: 2 ** 32 },
    { ...valid(), credentialId: 1 }, { ...valid(), credentialId: "0" },
    { ...valid(), connectionIds: [0, 0] }, { ...valid(), connectionIds: [3] },
    { ...valid(), connectionIds: [0, 1, 2, 3] }, { ...valid(), connectionIds: new Array(1) },
    { ...valid(), connectionIds: new Uint32Array([0]) },
    { ...valid(), secret: "DEMO_VALUE_ONLY" }, { ...valid(), [Symbol("extra")]: 1 },
    Object.create(valid()) as unknown,
  ])("rejects unsupported inputs without reflecting their details", (input) => {
    expect(() => parseSyntheticRegistration(input)).toThrow("INVALID_ARCHIVE");
  });
  it("does not execute input accessors", () => {
    const getter = vi.fn(() => 0);
    const input = valid();
    Object.defineProperty(input, "profileId", { get: getter });
    expect(() => parseSyntheticRegistration(input)).toThrow("INVALID_ARCHIVE");
    expect(getter).not.toHaveBeenCalled();
    const nested = valid();
    Object.defineProperty(nested.connectionIds, "0", { get: getter });
    expect(() => parseSyntheticRegistration(nested)).toThrow("INVALID_ARCHIVE");
    expect(getter).not.toHaveBeenCalled();
  });
  it("contains thrown inspection errors", () => {
    const input = new Proxy({}, { getPrototypeOf() { throw new Error("private details"); } });
    expect(() => parseSyntheticRegistration(input)).toThrow("INVALID_ARCHIVE");
  });
  it("rejects oversized connection arrays before enumerating their elements", () => {
    const enumerate = vi.fn(() => { throw new Error("must not enumerate"); });
    const connections = new Proxy(new Array(4), { ownKeys: enumerate });
    expect(() => parseSyntheticRegistration({ ...valid(), connectionIds: connections })).toThrow("INVALID_ARCHIVE");
    expect(enumerate).not.toHaveBeenCalled();
  });
});
