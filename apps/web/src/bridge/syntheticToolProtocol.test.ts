import { describe, expect, it } from "vitest";
import {
  getSyntheticToolQueryUtf8Length,
  isSyntheticToolQueryWithinLimit,
  isSyntheticToolQueryWellFormed,
  parseSyntheticToolAction,
  SYNTHETIC_TOOL_FILTERS_V1,
} from "./syntheticToolProtocol";

describe("synthetic local tool input contract", () => {
  it.each([
    ["ASCII", "x".repeat(128), 128],
    ["Korean", "가".repeat(42), 126],
    ["emoji", "😀".repeat(32), 128],
  ])("counts %s in UTF-8 bytes", (_label, query, expectedBytes) => {
    expect(getSyntheticToolQueryUtf8Length(query)).toBe(expectedBytes);
  });

  it.each([
    ["ASCII at the limit", "x".repeat(128), true],
    ["Korean below the byte limit", "가".repeat(42), true],
    ["Korean above the byte limit", "가".repeat(43), false],
    ["emoji at the byte limit", "😀".repeat(32), true],
    ["emoji above the byte limit", "😀".repeat(33), false],
  ])("applies the UTF-8 byte limit to %s", (_label, query, withinLimit) => {
    expect(isSyntheticToolQueryWithinLimit(query)).toBe(withinLimit);
  });

  it.each([
    ["empty", "", true],
    ["Korean", "가나다", true],
    ["emoji pair", "😀", true],
    ["isolated high surrogate", "\ud800", false],
    ["isolated low surrogate", "\udc00", false],
    ["broken pair", "\ud800x", false],
  ])("classifies %s Unicode input", (_label, query, wellFormed) => {
    expect(isSyntheticToolQueryWellFormed(query)).toBe(wellFormed);
  });

  it("snapshots an exact plain search action with a bounded default", () => {
    const input = { op: "search_catalog", query: "Example CLI" };
    const result = parseSyntheticToolAction(input);
    expect(result).toEqual({ ok: true, action: { ...input, maxResults: 500 } });
    input.query = "changed later";
    expect(result.ok && result.action.op === "search_catalog" && result.action.query).toBe("Example CLI");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.ok && Object.isFrozen(result.action)).toBe(true);
  });

  it("accepts null-prototype own data fields", () => {
    const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    input.op = "lock_vault";
    expect(parseSyntheticToolAction(input)).toEqual({ ok: true, action: { op: "lock_vault" } });
  });

  it.each(SYNTHETIC_TOOL_FILTERS_V1)("accepts the exact filter %s", (filter) => {
    expect(parseSyntheticToolAction({ op: "filter_catalog", filter })).toEqual({
      ok: true, action: { op: "filter_catalog", filter, maxResults: 500 },
    });
  });

  it.each(["unlock_vault", "open_vault", "reveal_secret", "copy_secret", "export", "fetch", "shell", "", 1, null])(
    "rejects an operation outside the local allowlist: %s", (op) => {
      expect(parseSyntheticToolAction({ op })).toEqual({ ok: false, code: "INVALID_TOOL" });
    },
  );

  it.each([null, undefined, [], "{}", 3, true, () => undefined, new String("search_catalog"), {}])(
    "rejects non-action input %s", (input) => {
      expect(parseSyntheticToolAction(input)).toEqual({ ok: false, code: "INVALID_PAYLOAD" });
    },
  );

  it.each([
    { op: "lock_vault", query: "unused" },
    { op: "lock_vault", maxResults: 0 },
    { op: "search_catalog", query: "", secret: "synthetic-only-placeholder" },
    { op: "filter_catalog", filter: "all", query: "" },
    { op: "search_catalog" },
    { op: "search_catalog", query: 123 },
    { op: "search_catalog", query: { toString: () => "not invoked" } },
    { op: "filter_catalog" },
    { op: "filter_catalog", filter: "connected" },
    { op: "filter_catalog", filter: "ALL" },
    { op: "filter_catalog", filter: [] },
  ])("rejects missing, extra, or wrongly typed fields: %j", (input) => {
    expect(parseSyntheticToolAction(input)).toEqual({ ok: false, code: "INVALID_PAYLOAD" });
  });

  it("does not read accessors, inherited actions, symbols, or hidden fields", () => {
    let calls = 0;
    const accessor = { op: "search_catalog", get query() { calls += 1; return "private"; } };
    const cases = [accessor, Object.create({ op: "lock_vault" }) as object,
      { op: "lock_vault", [Symbol("extra")]: 1 },
      Object.defineProperty({ op: "lock_vault" }, "hidden", { value: true }),
      Object.defineProperty({}, "op", { value: "lock_vault" }),
    ];
    for (const input of cases) expect(parseSyntheticToolAction(input)).toEqual({ ok: false, code: "INVALID_PAYLOAD" });
    expect(calls).toBe(0);
  });

  it.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const)(
    "normalizes a thrown %s trap without reading the thrown object", (trap) => {
      const thrown = new Proxy({}, { get: () => { throw new Error("must not inspect thrown value"); } });
      const input = new Proxy({ op: "lock_vault" }, { [trap]: () => { throw thrown; } });
      const result = parseSyntheticToolAction(input);
      expect(result).toEqual({ ok: false, code: "INVALID_PAYLOAD" });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it.each(["", "  ", "x".repeat(128), "가".repeat(42), "😀".repeat(32)])(
    "accepts a well-formed query within 128 UTF-8 bytes", (query) => {
      expect(parseSyntheticToolAction({ op: "search_catalog", query })).toEqual({
        ok: true, action: { op: "search_catalog", query, maxResults: 500 },
      });
    },
  );

  it.each(["x".repeat(129), "가".repeat(43), "😀".repeat(33)])(
    "rejects queries over the UTF-8 byte limit", (query) => {
      expect(parseSyntheticToolAction({ op: "search_catalog", query })).toEqual({ ok: false, code: "LIMIT_EXCEEDED" });
    },
  );

  it("bounds raw length before scanning Unicode well-formedness", () => {
    expect(parseSyntheticToolAction({ op: "search_catalog", query: "\ud800".repeat(129) }))
      .toEqual({ ok: false, code: "LIMIT_EXCEEDED" });
  });

  it.each(["\ud800", "\udc00", "\ud800x", "x\udc00"])("rejects short unpaired UTF-16 surrogates", (query) => {
    expect(parseSyntheticToolAction({ op: "search_catalog", query })).toEqual({ ok: false, code: "INVALID_PAYLOAD" });
  });

  it.each([0, 1, 500])("accepts integer result limit %s for both actions", (maxResults) => {
    for (const input of [{ op: "search_catalog", query: "", maxResults }, { op: "filter_catalog", filter: "all", maxResults }]) {
      expect(parseSyntheticToolAction(input)).toEqual({ ok: true, action: input });
    }
  });

  it.each([-1, 501, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "1", null, undefined])(
    "rejects an explicit invalid result limit %s for both actions", (maxResults) => {
      for (const input of [{ op: "search_catalog", query: "", maxResults }, { op: "filter_catalog", filter: "all", maxResults }]) {
        expect(parseSyntheticToolAction(input)).toEqual({ ok: false, code: "LIMIT_EXCEEDED" });
      }
    },
  );
});
