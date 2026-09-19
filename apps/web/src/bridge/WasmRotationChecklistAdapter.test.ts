import { describe, expect, it, vi } from "vitest";
import { CatalogAdapterError, type CatalogErrorCodeV1 } from "./catalogProtocol";
import { WasmRotationChecklistAdapter } from "./WasmRotationChecklistAdapter";
import {
  projectRotationChecklistV1,
  type WasmRotationChecklistV1,
} from "./rotationProtocol";

function plain(overrides: Record<string, unknown> = {}) {
  return {
    generation: "initial_0001",
    readinessState: "ready",
    entries: [
      { fixture: "mcp", requiredForCutover: true },
      { fixture: "cli", requiredForCutover: false },
    ],
    remainingRequired: 0,
    remainingOptional: 1,
    ...overrides,
  };
}

function handle(overrides: Partial<WasmRotationChecklistV1> = {}) {
  let locked = false;
  const order: string[] = [];
  const fixtures = ["mcp", "cli"];
  const required = [true, false];
  const value: WasmRotationChecklistV1 & { order: string[]; privateValue: string } = {
    isLocked: vi.fn(() => locked),
    lock: vi.fn(() => { order.push("lock"); locked = true; }),
    free: vi.fn(() => { order.push("free"); }),
    generation: vi.fn(() => "initial_0001"),
    readinessState: vi.fn(() => "ready"),
    entryCount: vi.fn(() => fixtures.length),
    entryFixture: vi.fn((index) => fixtures[index]!),
    entryRequiredForCutover: vi.fn((index) => required[index]!),
    remainingRequired: vi.fn(() => 0),
    remainingOptional: vi.fn(() => 1),
    order,
    privateValue: "PRIVATE_HANDLE_VALUE",
    ...overrides,
  };
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("projectRotationChecklistV1", () => {
  it("rebuilds and freezes the exact structured-clone allowlist", () => {
    const source = plain();
    const result = projectRotationChecklistV1(source);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result.entries).not.toBe(source.entries);
    expect(Object.keys(result)).toEqual([
      "generation", "readinessState", "entries", "remainingRequired", "remainingOptional",
    ]);
    expect(Object.keys(result.entries[0]!)).toEqual(["fixture", "requiredForCutover"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(result.entries.every(Object.isFrozen)).toBe(true);
  });

  it("accepts exact null-prototype checklist and entry containers", () => {
    const entry = Object.assign(Object.create(null), { fixture: "mcp", requiredForCutover: true });
    const source = Object.assign(Object.create(null), plain({ entries: [entry], remainingOptional: 0 }));
    expect(projectRotationChecklistV1(source)).toEqual({
      generation: "initial_0001", readinessState: "ready",
      entries: [{ fixture: "mcp", requiredForCutover: true }],
      remainingRequired: 0, remainingOptional: 0,
    });
  });

  it("rejects private, missing, symbol, accessor, inherited and exotic fields", () => {
    const missing = plain() as Record<string, unknown>; delete missing.generation;
    const extra = plain({ recordId: "private" });
    const symbol = Object.assign(plain(), { [Symbol("private")]: true });
    const getter = vi.fn(() => "ready");
    const accessor = plain(); Object.defineProperty(accessor, "readinessState", { enumerable: true, get: getter });
    const inherited = Object.assign(Object.create({ generation: "initial_0001" }), plain());
    const exotic = Object.assign(new (class Checklist {})(), plain());
    for (const input of [missing, extra, symbol, accessor, inherited, exotic]) {
      expect(() => projectRotationChecklistV1(input))
        .toThrow(expect.objectContaining({ code: "INVALID_CATALOG" }));
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects entry extras/accessors/prototypes, sparse arrays and array extras", () => {
    const entryGetter = vi.fn(() => "mcp");
    const accessor = { requiredForCutover: true } as Record<string, unknown>;
    Object.defineProperty(accessor, "fixture", { enumerable: true, get: entryGetter });
    const sparse = new Array(1);
    const cases = [
      [{ fixture: "mcp", requiredForCutover: true, revisionId: "private" }],
      [accessor],
      [Object.assign(new (class Entry {})(), { fixture: "mcp", requiredForCutover: true })],
      sparse,
      Object.assign([{ fixture: "mcp", requiredForCutover: true }], { privateValue: true }),
    ];
    for (const entries of cases) {
      expect(() => projectRotationChecklistV1(plain({ entries, remainingOptional: 0 })))
        .toThrow(expect.objectContaining({ code: "INVALID_CATALOG" }));
    }
    expect(entryGetter).not.toHaveBeenCalled();
  });

  it.each([
    [plain({ generation: "future" }), "INVALID_CATALOG"],
    [plain({ readinessState: "future" }), "INVALID_CATALOG"],
    [plain({ entries: [{ fixture: "future", requiredForCutover: true }], remainingOptional: 0 }), "INVALID_CATALOG"],
    [plain({ entries: [{ fixture: "mcp", requiredForCutover: 1 }], remainingOptional: 0 }), "INVALID_CATALOG"],
    [plain({ entries: [
      { fixture: "mcp", requiredForCutover: true }, { fixture: "mcp", requiredForCutover: false },
    ], remainingOptional: 1 }), "INVALID_CATALOG"],
    [plain({ entries: Array.from({ length: 4 }, (_, index) => ({ fixture: index, requiredForCutover: false })) }), "LIMITS_EXCEEDED"],
    [plain({ remainingRequired: 4 }), "LIMITS_EXCEEDED"],
    [plain({ remainingOptional: 4 }), "LIMITS_EXCEEDED"],
    [plain({ remainingRequired: -0 }), "INVALID_CATALOG"],
  ] as const)("rejects malformed closed projection %#", (input, code) => {
    expect(() => projectRotationChecklistV1(input)).toThrow(expect.objectContaining({ code }));
  });

  it.each([
    plain({ generation: "terminal_0003", readinessState: "ready", remainingOptional: 0 }),
    plain({ generation: "initial_0001", readinessState: "terminal", remainingOptional: 0 }),
    plain({ generation: "terminal_0003", readinessState: "terminal", remainingRequired: 1, remainingOptional: 0 }),
    plain({ generation: "terminal_0003", readinessState: "terminal", remainingRequired: 0, remainingOptional: 1 }),
    plain({ readinessState: "required_pending", remainingRequired: 0, remainingOptional: 0 }),
    plain({ readinessState: "required_pending", remainingRequired: 2, remainingOptional: 0 }),
    plain({ readinessState: "required_pending", remainingRequired: 1, remainingOptional: 1 }),
    plain({ readinessState: "ready", remainingRequired: 1, remainingOptional: 0 }),
    plain({ readinessState: "ready", remainingRequired: 0, remainingOptional: 2 }),
  ])("rejects inconsistent generation/readiness/count state %#", (input) => {
    expect(() => projectRotationChecklistV1(input))
      .toThrow(expect.objectContaining({ code: "INVALID_CATALOG" }));
  });

  it.each([
    plain({ readinessState: "required_pending", remainingRequired: 1, remainingOptional: 0 }),
    plain({ readinessState: "ready", remainingRequired: 0, remainingOptional: 0 }),
    plain({ generation: "rotated_0002", readinessState: "ready", remainingRequired: 0, remainingOptional: 1 }),
    plain({ generation: "terminal_0003", readinessState: "terminal", remainingRequired: 0, remainingOptional: 0 }),
  ])("accepts valid closed state %#", (input) => {
    expect(projectRotationChecklistV1(input)).toEqual(input);
  });

  it("normalizes hostile proxy traps without retaining diagnostics", () => {
    const proxy = new Proxy(plain(), { getPrototypeOf() { throw new Error("PRIVATE_DETAIL"); } });
    try {
      projectRotationChecklistV1(proxy);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_CATALOG", message: "INVALID_CATALOG" });
      expect(String(error)).not.toContain("PRIVATE_DETAIL");
      expect(error).not.toHaveProperty("cause");
    }
  });
});

describe("WasmRotationChecklistAdapter", () => {
  it("projects only fixed fields, then locks and frees the handle before publishing", async () => {
    const source = handle();
    const adapter = new WasmRotationChecklistAdapter(() => source);
    const result = await adapter.load();
    expect(result).toEqual(plain());
    expect(JSON.stringify(result)).not.toContain("PRIVATE_HANDLE_VALUE");
    expect(source.order).toEqual(["lock", "free"]);
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
    expect(adapter.checklist).toBe(result);
    expect(adapter.isLocked).toBe(false);
    adapter.lock();
    expect(adapter.checklist).toBeUndefined();
    expect(adapter.isLocked).toBe(true);
    adapter.dispose();
    expect(source.lock).toHaveBeenCalledOnce();
  });

  it.each([
    ["locked", { isLocked: () => true }, "LOCKED"],
    ["too many entries", { entryCount: () => 4 }, "LIMITS_EXCEEDED"],
    ["negative entries", { entryCount: () => -1 }, "INVALID_CATALOG"],
    ["fractional entries", { entryCount: () => 1.5 }, "INVALID_CATALOG"],
    ["negative zero entries", { entryCount: () => -0 }, "INVALID_CATALOG"],
    ["duplicate fixture", { entryFixture: () => "mcp" }, "INVALID_CATALOG"],
    ["unknown fixture", { entryFixture: () => "future" }, "INVALID_CATALOG"],
    ["nonboolean requirement", { entryRequiredForCutover: () => 1 as never }, "INVALID_CATALOG"],
    ["bad cross-state counts", { remainingOptional: () => 2 }, "INVALID_CATALOG"],
  ] satisfies readonly (readonly [string, Partial<WasmRotationChecklistV1>, CatalogErrorCodeV1])[])(
    "cleans up malformed handle: %s", async (_label, overrides, code) => {
      const source = handle(overrides);
      const adapter = new WasmRotationChecklistAdapter(() => source);
      await expect(adapter.load()).rejects.toMatchObject({ code });
      expect(source.order).toEqual(["lock", "free"]);
      expect(adapter.checklist).toBeUndefined();
    },
  );

  it.each([undefined, null, 0, "", Number.NaN])(
    "rejects a falsey nonboolean first lock-state result: %s",
    async (invalid) => {
      const source = handle({ isLocked: vi.fn(() => invalid as never) });
      const adapter = new WasmRotationChecklistAdapter(() => source);
      await expect(adapter.load()).rejects.toMatchObject({
        code: "INVALID_CATALOG",
        message: "INVALID_CATALOG",
      });
      expect(source.isLocked).toHaveBeenCalledOnce();
      expect(source.order).toEqual(["lock", "free"]);
      expect(adapter.checklist).toBeUndefined();
    },
  );

  it.each([undefined, null, 0, "", Number.NaN])(
    "rejects a falsey nonboolean second lock-state result: %s",
    async (invalid) => {
      const source = handle({
        isLocked: vi.fn()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(invalid as never),
      });
      const adapter = new WasmRotationChecklistAdapter(() => source);
      await expect(adapter.load()).rejects.toMatchObject({
        code: "INVALID_CATALOG",
        message: "INVALID_CATALOG",
      });
      expect(source.isLocked).toHaveBeenCalledTimes(2);
      expect(source.order).toEqual(["lock", "free"]);
      expect(adapter.checklist).toBeUndefined();
    },
  );

  it("attempts free after a lock failure and reports only cleanup failure", async () => {
    const order: string[] = [];
    const source = handle({
      lock: vi.fn(() => { order.push("lock"); throw new Error("PRIVATE_LOCK_DETAIL"); }),
      free: vi.fn(() => { order.push("free"); }),
    });
    const adapter = new WasmRotationChecklistAdapter(() => source);
    await expect(adapter.load()).rejects.toMatchObject({
      code: "CLEANUP_FAILED", message: "CLEANUP_FAILED",
    });
    expect(order).toEqual(["lock", "free"]);
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
    expect(adapter.checklist).toBeUndefined();
  });

  it("does not retry cleanup when free fails", async () => {
    const source = handle({ free: vi.fn(() => { throw new Error("PRIVATE_FREE_DETAIL"); }) });
    const adapter = new WasmRotationChecklistAdapter(() => source);
    await expect(adapter.load()).rejects.toHaveProperty("code", "CLEANUP_FAILED");
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
  });

  it.each([
    ["AUTHENTICATION_FAILED", "AUTHENTICATION_FAILED"],
    ["UPGRADE_REQUIRED", "UPGRADE_REQUIRED"],
    ["PRIVATE_WASM_DETAIL", "BRIDGE_FAILURE"],
  ] as const)("sanitizes getter failure %s", async (thrown, code) => {
    const source = handle({ generation: () => { throw thrown; } });
    const adapter = new WasmRotationChecklistAdapter(() => source);
    await expect(adapter.load()).rejects.toMatchObject({ code, message: code });
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
  });

  it("releases a late older handle without replacing the newer checklist", async () => {
    const pending = deferred<WasmRotationChecklistV1>();
    const older = handle();
    const newer = handle({ generation: () => "rotated_0002" });
    const factory = vi.fn<() => WasmRotationChecklistV1 | Promise<WasmRotationChecklistV1>>()
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(newer);
    const adapter = new WasmRotationChecklistAdapter(factory);
    const oldLoad = adapter.load();
    const current = await adapter.load();
    pending.resolve(older);
    await expect(oldLoad).rejects.toHaveProperty("code", "CANCELLED");
    expect(adapter.checklist).toBe(current);
    expect(adapter.checklist?.generation).toBe("rotated_0002");
    expect(older.lock).toHaveBeenCalledOnce();
    expect(older.free).toHaveBeenCalledOnce();
  });

  it("a late older rejection cannot clear a newer checklist", async () => {
    const pending = deferred<WasmRotationChecklistV1>();
    const newer = handle({ generation: () => "rotated_0002" });
    const factory = vi.fn<() => WasmRotationChecklistV1 | Promise<WasmRotationChecklistV1>>()
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(newer);
    const adapter = new WasmRotationChecklistAdapter(factory);
    const oldLoad = adapter.load();
    const current = await adapter.load();
    pending.reject("AUTHENTICATION_FAILED");
    await expect(oldLoad).rejects.toHaveProperty("code", "CANCELLED");
    expect(adapter.checklist).toBe(current);
  });

  it("lock during a pending factory prevents publication and releases the handle", async () => {
    const pending = deferred<WasmRotationChecklistV1>();
    const source = handle();
    const adapter = new WasmRotationChecklistAdapter(() => pending.promise);
    const load = adapter.load();
    adapter.lock();
    pending.resolve(source);
    await expect(load).rejects.toHaveProperty("code", "CANCELLED");
    expect(adapter.checklist).toBeUndefined();
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
  });

  it("clears an old projection before waiting for a replacement", async () => {
    const first = handle();
    const pending = deferred<WasmRotationChecklistV1>();
    const factory = vi.fn<() => WasmRotationChecklistV1 | Promise<WasmRotationChecklistV1>>()
      .mockReturnValueOnce(first).mockReturnValueOnce(pending.promise);
    const adapter = new WasmRotationChecklistAdapter(factory);
    await adapter.load();
    const next = adapter.load();
    expect(adapter.checklist).toBeUndefined();
    pending.resolve(handle());
    await next;
  });

  it("dispose cancels pending work and permanently rejects later loads", async () => {
    const pending = deferred<WasmRotationChecklistV1>();
    const source = handle();
    const factory = vi.fn(() => pending.promise);
    const adapter = new WasmRotationChecklistAdapter(factory);
    const load = adapter.load();
    adapter.dispose();
    pending.resolve(source);
    await expect(load).rejects.toHaveProperty("code", "CANCELLED");
    await expect(adapter.load()).rejects.toHaveProperty("code", "DISPOSED");
    expect(factory).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
  });

  it("a cleanup callback that locks the adapter cannot publish a stale projection", async () => {
    let adapter!: WasmRotationChecklistAdapter;
    const source = handle({
      lock: vi.fn(() => { adapter.lock(); }),
    });
    adapter = new WasmRotationChecklistAdapter(() => source);
    await expect(adapter.load()).rejects.toHaveProperty("code", "CANCELLED");
    expect(source.free).toHaveBeenCalledOnce();
    expect(adapter.checklist).toBeUndefined();
  });

  it("normalizes a hostile adapter error code accessor", async () => {
    const error = new CatalogAdapterError("AUTHENTICATION_FAILED");
    Object.defineProperty(error, "code", {
      get() { throw new Error("PRIVATE_CODE_DETAIL"); },
    });
    const source = handle({ generation: () => { throw error; } });
    await expect(new WasmRotationChecklistAdapter(() => source).load())
      .rejects.toMatchObject({ code: "BRIDGE_FAILURE" satisfies CatalogErrorCodeV1 });
  });
});
