import { describe, expect, it, vi } from "vitest";
import { parseSyntheticRotationSelection } from "./syntheticRotation";

function valid() {
  return {
    reference: 2,
    mcp: "provider_verified",
    cli: "user_confirmed",
    ci: "pending",
    supersededRevocation: "provider_verified",
  };
}

describe("parseSyntheticRotationSelection", () => {
  it("returns an exact frozen copy containing only closed fixture evidence", () => {
    const source = valid();
    const parsed = parseSyntheticRotationSelection(source);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(Object.keys(parsed)).toEqual([
      "reference", "mcp", "cli", "ci", "supersededRevocation",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    source.reference = 1;
    source.mcp = "pending";
    expect(parsed.reference).toBe(2);
    expect(parsed.mcp).toBe("provider_verified");
  });

  it("accepts an exact null-prototype structured-data container", () => {
    const source = Object.assign(Object.create(null), valid());
    const parsed = parseSyntheticRotationSelection(source);
    expect(parsed).toEqual(valid());
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it.each([-0, -1, 128, 0.5, NaN, Infinity, -Infinity, "2", 2n, new Number(2)])(
    "rejects noncanonical reference %s without coercion", (reference) => {
      const coercion = vi.fn(() => 2);
      const value = typeof reference === "object" && reference !== null
        ? Object.assign(reference, { valueOf: coercion, toString: coercion }) : reference;
      expect(() => parseSyntheticRotationSelection({ ...valid(), reference: value }))
        .toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
      expect(coercion).not.toHaveBeenCalled();
    },
  );

  it.each(["", "true", "complete", false, 1, null, undefined, {}, []])(
    "rejects non-closed completion evidence %j", (evidence) => {
      expect(() => parseSyntheticRotationSelection({ ...valid(), mcp: evidence }))
        .toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
    },
  );

  it.each(["pending", "", "verified", false, 0, 1, null, undefined, {}])(
    "rejects non-closed revocation evidence %j", (evidence) => {
      expect(() => parseSyntheticRotationSelection({ ...valid(), supersededRevocation: evidence }))
        .toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
    },
  );

  it("rejects missing, extra, symbol and non-enumerable fields", () => {
    const missing = valid() as Record<string, unknown>;
    delete missing.cli;
    const extra = { ...valid(), recordId: "private" };
    const symbolic = Object.assign(valid(), { [Symbol("private")]: true });
    const hidden = Object.defineProperty(valid(), "reference", { enumerable: false });
    for (const input of [missing, extra, symbolic, hidden]) {
      expect(() => parseSyntheticRotationSelection(input))
        .toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
    }
  });

  it("never invokes accessors, inherited values or coercion hooks", () => {
    const getter = vi.fn(() => "provider_verified");
    const accessor = valid();
    Object.defineProperty(accessor, "mcp", { enumerable: true, get: getter });
    const inherited = Object.create({ reference: 2 });
    Object.assign(inherited, valid());
    delete inherited.reference;
    const coercion = vi.fn(() => "provider_verified");
    const boxedEvidence = { valueOf: coercion, toString: coercion };
    for (const input of [accessor, inherited, { ...valid(), cli: boxedEvidence }]) {
      expect(() => parseSyntheticRotationSelection(input))
        .toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
    }
    expect(getter).not.toHaveBeenCalled();
    expect(coercion).not.toHaveBeenCalled();
  });

  it.each([[], new Date(), new (class Selection { reference = 2; })(), null, "selection"])(
    "rejects exotic/non-object input %#", (input) => {
      expect(() => parseSyntheticRotationSelection(input))
        .toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
    },
  );

  it("normalizes hostile proxy traps and does not retain private diagnostics", () => {
    const proxy = new Proxy(valid(), {
      ownKeys() { throw new Error("PRIVATE_SELECTION_DETAIL"); },
    });
    try {
      parseSyntheticRotationSelection(proxy);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_ARCHIVE", message: "INVALID_ARCHIVE" });
      expect(String(error)).not.toContain("PRIVATE_SELECTION_DETAIL");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("does not invoke a transparent proxy get trap", () => {
    const get = vi.fn(() => { throw new Error("unused get trap"); });
    const parsed = parseSyntheticRotationSelection(new Proxy(valid(), { get }));
    expect(parsed).toEqual(valid());
    expect(get).not.toHaveBeenCalled();
  });
});
