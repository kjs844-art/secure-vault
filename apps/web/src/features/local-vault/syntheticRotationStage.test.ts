import { describe, expect, it, vi } from "vitest";
import { ROTATION_STAGE_EVIDENCE_V1 } from "../../bridge/rotationStageProtocol";
import { parseSyntheticRotationSelection } from "./syntheticRotation";
import { parseSyntheticRotationStageReference, parseSyntheticRotationStageSelection } from "./syntheticRotationStage";

const selection = { reference: 0, mcp: "pending", cli: "user_confirmed", ci: "provider_verified", supersededRevocation: "pending" };

describe("closed synthetic saved-stage selection", () => {
  it("accepts each closed evidence combination and returns a frozen fresh snapshot", () => {
    for (const mcp of ROTATION_STAGE_EVIDENCE_V1) for (const cli of ROTATION_STAGE_EVIDENCE_V1) {
      for (const ci of ROTATION_STAGE_EVIDENCE_V1) for (const supersededRevocation of ROTATION_STAGE_EVIDENCE_V1) {
        const source = { reference: 127, mcp, cli, ci, supersededRevocation };
        const parsed = parseSyntheticRotationStageSelection(source);
        expect(parsed).toEqual(source);
        expect(parsed).not.toBe(source);
        expect(Object.isFrozen(parsed)).toBe(true);
      }
    }
  });
  it("does not loosen the existing one-shot revocation parser", () => {
    expect(parseSyntheticRotationStageSelection(selection).supersededRevocation).toBe("pending");
    expect(() => parseSyntheticRotationSelection(selection)).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
  });
  it("accepts a plain null-prototype container", () => {
    expect(parseSyntheticRotationStageSelection(Object.assign(Object.create(null), selection))).toEqual(selection);
  });
  it.each([-1, -0, 128, 1.1, NaN, Infinity, "0", true, null, undefined, { valueOf: () => 0 }])(
    "rejects nonprimitive/out-of-bound reference %#", (reference) => {
      expect(() => parseSyntheticRotationStageReference(reference)).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
      expect(() => parseSyntheticRotationStageSelection({ ...selection, reference })).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
    },
  );
  it.each(["mcp", "cli", "ci", "supersededRevocation"])("rejects non-enum evidence for %s", (key) => {
    for (const value of ["complete", 0, false, undefined, null, new String("pending")]) {
      expect(() => parseSyntheticRotationStageSelection({ ...selection, [key]: value }))
        .toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }));
    }
  });
  it("rejects extras, missing/inherited/accessor/non-enumerable fields without reading getters", () => {
    const getter = vi.fn(() => 0);
    const accessor = Object.defineProperty({ ...selection }, "reference", { enumerable: true, get: getter });
    const hidden = Object.defineProperty({ ...selection }, "reference", { enumerable: false, value: 0 });
    const missing = { ...selection } as Record<string, unknown>; delete missing.cli;
    const values = [
      { ...selection, recordId: "private" }, { ...selection, [Symbol("private")]: true },
      accessor, hidden, missing, Object.assign(Object.create({ reference: 0 }), selection),
      Object.assign(new (class Selection {})(), selection), null, [],
      new Proxy(selection, { ownKeys() { throw new Error("PRIVATE_DETAIL"); } }),
    ];
    for (const value of values) expect(() => parseSyntheticRotationStageSelection(value))
      .toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE", message: "INVALID_ARCHIVE" }));
    expect(getter).not.toHaveBeenCalled();
  });
});
