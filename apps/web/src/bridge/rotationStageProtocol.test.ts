import { describe, expect, it, vi } from "vitest";
import { projectRotationStageV1, ROTATION_STAGE_EVIDENCE_V1 } from "./rotationStageProtocol";

function stage(overrides: Record<string, unknown> = {}) {
  return {
    baseGeneration: "initial_0001", targetGeneration: "rotated_0002",
    entries: [
      { fixture: "mcp", requiredForCutover: true, completion: "pending" },
      { fixture: "cli", requiredForCutover: false, completion: "pending" },
    ],
    revocation: "pending", remainingRequired: 1, remainingOptional: 1, readyForCutover: false,
    ...overrides,
  };
}

describe("exact saved-stage projection", () => {
  it("rebuilds a fresh deeply frozen projection and no arbitrary fields", () => {
    const input = stage();
    const projected = projectRotationStageV1(input);
    expect(projected).toEqual(input);
    expect(projected).not.toBe(input);
    expect(projected.entries).not.toBe(input.entries);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.entries)).toBe(true);
    expect(projected.entries.every(Object.isFrozen)).toBe(true);
    expect(Object.keys(projected.entries[0]!)).toEqual(["fixture", "requiredForCutover", "completion"]);
  });
  it("validates every closed evidence/required combination against actual pending counts", () => {
    for (const first of ROTATION_STAGE_EVIDENCE_V1) for (const second of ROTATION_STAGE_EVIDENCE_V1) {
      for (const third of ROTATION_STAGE_EVIDENCE_V1) for (const revocation of ROTATION_STAGE_EVIDENCE_V1) {
        for (let mask = 0; mask < 8; mask += 1) {
          const entries = [first, second, third].map((completion, index) => ({
            fixture: ["mcp", "cli", "ci"][index]!, requiredForCutover: (mask & (1 << index)) !== 0, completion,
          }));
          const remainingRequired = entries.filter((entry) => entry.requiredForCutover && entry.completion === "pending").length;
          const remainingOptional = entries.filter((entry) => !entry.requiredForCutover && entry.completion === "pending").length;
          const input = stage({ entries, revocation, remainingRequired, remainingOptional,
            readyForCutover: remainingRequired === 0 && revocation !== "pending" });
          if (remainingRequired > 0 && revocation !== "pending") {
            expect(() => projectRotationStageV1(input)).toThrow();
          } else expect(projectRotationStageV1(input)).toEqual(input);
        }
      }
    }
  });
  it("accepts zero active entries, second generation, and null-prototype data", () => {
    const input = stage({ baseGeneration: "rotated_0002", targetGeneration: "terminal_0003", entries: [], remainingRequired: 0, remainingOptional: 0 });
    expect(projectRotationStageV1(Object.assign(Object.create(null), input))).toEqual(input);
    expect(projectRotationStageV1(stage({ entries: stage().entries.map((entry) => Object.assign(Object.create(null), entry)) }))).toEqual(stage());
  });
  it.each([
    { baseGeneration: "terminal_0003" }, { baseGeneration: "future" }, { targetGeneration: "terminal_0003" },
    { targetGeneration: "initial_0001" }, { revocation: "complete" }, { revocation: "user_confirmed" },
    { remainingRequired: 0 }, { remainingOptional: 0 }, { remainingRequired: -0 }, { remainingOptional: "1" },
    { readyForCutover: true }, { readyForCutover: 0 }, { recordId: "private" },
    { entries: [{ fixture: "future", requiredForCutover: true, completion: "pending" }] },
    { entries: [{ fixture: "mcp", requiredForCutover: 1, completion: "pending" }] },
    { entries: [{ fixture: "mcp", requiredForCutover: true, completion: "complete" }] },
    { entries: [stage().entries[0], stage().entries[0]] },
    { entries: [{ ...stage().entries[0], revisionId: "private" }] },
  ])("rejects invalid or inconsistent projection %#", (overrides) => {
    expect(() => projectRotationStageV1(stage(overrides))).toThrow(expect.objectContaining({ code: "INVALID_CATALOG" }));
  });
  it.each([{ remainingRequired: 4 }, { remainingOptional: 4 }, { entries: new Array(4) }])(
    "rejects over-limit shape %#", (overrides) => {
      expect(() => projectRotationStageV1(stage(overrides))).toThrow(expect.objectContaining({ code: "LIMITS_EXCEEDED" }));
    },
  );
  it("requires revocation before readiness, even after every required connection is complete", () => {
    const source = stage({ entries: [], remainingRequired: 0, remainingOptional: 0 });
    expect(() => projectRotationStageV1({ ...source, readyForCutover: true })).toThrow();
    expect(projectRotationStageV1({ ...source, revocation: "user_confirmed", readyForCutover: true }).readyForCutover).toBe(true);
    expect(() => projectRotationStageV1({ ...source, revocation: "user_confirmed" })).toThrow();
  });
  it("rejects hidden fields, getters, prototypes, sparse/extended arrays and hostile proxies", () => {
    const getter = vi.fn(() => "pending");
    const accessor = Object.defineProperty(stage(), "revocation", { get: getter, enumerable: true });
    const hidden = Object.defineProperty(stage(), "revocation", { value: "pending", enumerable: false });
    const missing = stage() as Record<string, unknown>; delete missing.revocation;
    const entry = Object.defineProperty({ ...stage().entries[0] }, "completion", { get: getter, enumerable: true });
    const arrayGetter = Object.defineProperty([stage().entries[0]], "0", { get: getter, enumerable: true });
    const thrown = Proxy.revocable({}, {}); thrown.revoke();
    const inputs = [
      accessor, hidden, missing, { ...stage(), [Symbol("private")]: true },
      Object.assign(new (class Stage {})(), stage()), Object.assign(Object.create({ other: true }), stage()),
      stage({ entries: [entry] }), stage({ entries: arrayGetter }), stage({ entries: new Array(1) }),
      stage({ entries: Object.assign([...stage().entries], { extra: true }) }),
      stage({ entries: Object.assign([...stage().entries], { [Symbol("extra")]: true }) }),
      new Proxy(stage(), { getPrototypeOf() { throw thrown.proxy; } }),
    ];
    for (const input of inputs) expect(() => projectRotationStageV1(input))
      .toThrow(expect.objectContaining({ code: "INVALID_CATALOG", message: "INVALID_CATALOG" }));
    expect(getter).not.toHaveBeenCalled();
  });
});
