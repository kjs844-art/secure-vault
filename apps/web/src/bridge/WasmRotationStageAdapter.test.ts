import { describe, expect, it, vi } from "vitest";
import { WasmRotationStageAdapter } from "./WasmRotationStageAdapter";
import { type WasmRotationStageV1 } from "./rotationStageProtocol";

function handle(overrides: Partial<WasmRotationStageV1> = {}) {
  let locked = false;
  const order: string[] = [];
  return {
    isLocked: vi.fn(() => locked), lock: vi.fn(() => { locked = true; order.push("lock"); }),
    free: vi.fn(() => { order.push("free"); }),
    baseGeneration: vi.fn(() => "initial_0001"), targetGeneration: vi.fn(() => "rotated_0002"),
    entryCount: vi.fn(() => 1), entryFixture: vi.fn(() => "mcp"),
    entryRequiredForCutover: vi.fn(() => true), entryCompletion: vi.fn(() => "pending"),
    revocation: vi.fn(() => "pending"), remainingRequired: vi.fn(() => 1), remainingOptional: vi.fn(() => 0),
    readyForCutover: vi.fn(() => false), privateValue: "PRIVATE_HANDLE_VALUE", order, ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("WasmRotationStageAdapter handle ownership", () => {
  it("publishes only the frozen allowlist after lock then free", async () => {
    const source = handle();
    const adapter = new WasmRotationStageAdapter(() => source);
    expect(adapter.isLocked).toBe(true);
    const result = await adapter.load();
    expect(result).toEqual({
      baseGeneration: "initial_0001", targetGeneration: "rotated_0002",
      entries: [{ fixture: "mcp", requiredForCutover: true, completion: "pending" }],
      revocation: "pending", remainingRequired: 1, remainingOptional: 0, readyForCutover: false,
    });
    expect(JSON.stringify(result)).not.toContain(source.privateValue);
    expect(source.order).toEqual(["lock", "free"]);
    expect(adapter.stage).toBe(result);
    expect(adapter.isLocked).toBe(false);
    adapter.lock();
    expect(adapter.stage).toBeUndefined();
    adapter.dispose();
    expect(source.free).toHaveBeenCalledOnce();
  });
  it("treats only undefined as authenticated absence, without restoring consent", async () => {
    const adapter = new WasmRotationStageAdapter(() => undefined);
    expect(await adapter.load()).toBeNull();
    expect(adapter.stage).toBeNull();
    expect(adapter.isLocked).toBe(false);
    adapter.lock();
    expect(adapter.stage).toBeUndefined();
    await expect(new WasmRotationStageAdapter(() => null as never).load()).rejects.toHaveProperty("code");
  });
  it.each([
    [{ isLocked: () => true }, "LOCKED"],
    [{ entryCount: (): number => 4 }, "LIMITS_EXCEEDED"],
    [{ entryCount: (): number => -0 }, "INVALID_CATALOG"],
    [{ entryCount: (): number => 0.5 }, "INVALID_CATALOG"],
    [{ entryCount: (): number => -1 }, "INVALID_CATALOG"],
    [{ entryCompletion: () => "future" }, "INVALID_CATALOG"],
    [{ entryRequiredForCutover: () => 1 as never }, "INVALID_CATALOG"],
    [{ baseGeneration: () => "terminal_0003" }, "INVALID_CATALOG"],
    [{ targetGeneration: () => "terminal_0003" }, "INVALID_CATALOG"],
    [{ remainingRequired: () => 0 }, "INVALID_CATALOG"],
    [{ readyForCutover: () => true }, "INVALID_CATALOG"],
    [{ revocation: () => "user_confirmed" }, "INVALID_CATALOG"],
  ] as const)("rejects malformed handle %# and always releases it", async (overrides, code) => {
    const source = handle(overrides);
    const adapter = new WasmRotationStageAdapter(() => source);
    await expect(adapter.load()).rejects.toHaveProperty("code", code);
    expect(source.order).toEqual(["lock", "free"]);
    expect(adapter.stage).toBeUndefined();
  });
  it.each([undefined, null, 0, "", Number.NaN])("checks strict lock state before and after projection: %s", async (invalid) => {
    for (const first of [true, false]) {
      const source = handle({ isLocked: first ? () => invalid as never : vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(invalid) });
      await expect(new WasmRotationStageAdapter(() => source).load()).rejects.toHaveProperty("code", "INVALID_CATALOG");
      expect(source.order).toEqual(["lock", "free"]);
    }
  });
  it.each(["lock", "free"] as const)("never retries cleanup after %s failure", async (method) => {
    const source = handle({ [method]: vi.fn(() => { throw new Error("PRIVATE_CLEANUP_DETAIL"); }) });
    const adapter = new WasmRotationStageAdapter(() => source);
    await expect(adapter.load()).rejects.toMatchObject({ code: "CLEANUP_FAILED", message: "CLEANUP_FAILED" });
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
    expect(adapter.stage).toBeUndefined();
  });
  it.each(["AUTHENTICATION_FAILED", "UPGRADE_REQUIRED", "PRIVATE_DETAIL"])("sanitizes factory/getter failure %s", async (thrown) => {
    const code = thrown === "PRIVATE_DETAIL" ? "BRIDGE_FAILURE" : thrown;
    await expect(new WasmRotationStageAdapter(() => { throw thrown; }).load()).rejects.toMatchObject({ code, message: code });
    const source = handle({ revocation: () => { throw thrown; } });
    await expect(new WasmRotationStageAdapter(() => source).load()).rejects.toMatchObject({ code, message: code });
    expect(source.order).toEqual(["lock", "free"]);
  });
  it("sanitizes a hostile thrown proxy", async () => {
    const proxy = Proxy.revocable({}, {}); proxy.revoke();
    await expect(new WasmRotationStageAdapter(() => { throw proxy.proxy; }).load()).rejects.toHaveProperty("code", "BRIDGE_FAILURE");
  });
  it.each(["handle", "absence", "rejection"] as const)("late older %s cannot replace a newer saved stage", async (kind) => {
    const pending = deferred<WasmRotationStageV1 | undefined>();
    const old = handle();
    const newer = handle({ baseGeneration: () => "rotated_0002", targetGeneration: () => "terminal_0003" });
    const factory = vi.fn<() => WasmRotationStageV1 | undefined | Promise<WasmRotationStageV1 | undefined>>()
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(newer);
    const adapter = new WasmRotationStageAdapter(factory);
    const olderLoad = adapter.load();
    const rejected = expect(olderLoad).rejects.toHaveProperty("code", "CANCELLED");
    const current = await adapter.load();
    if (kind === "rejection") pending.reject("AUTHENTICATION_FAILED");
    else pending.resolve(kind === "handle" ? old : undefined);
    await rejected;
    expect(adapter.stage).toBe(current);
    expect(adapter.stage?.baseGeneration).toBe("rotated_0002");
    expect(old.free).toHaveBeenCalledTimes(kind === "handle" ? 1 : 0);
  });
  it.each(["lock", "dispose"] as const)("%s cancels pending load and prevents restored progress publication", async (method) => {
    const pending = deferred<WasmRotationStageV1 | undefined>();
    const source = handle();
    const adapter = new WasmRotationStageAdapter(() => pending.promise);
    const result = adapter.load();
    const rejection = expect(result).rejects.toHaveProperty("code", "CANCELLED");
    adapter[method]();
    pending.resolve(source);
    await rejection;
    expect(source.order).toEqual(["lock", "free"]);
    expect(adapter.stage).toBeUndefined();
    if (method === "dispose") await expect(adapter.load()).rejects.toHaveProperty("code", "DISPOSED");
  });
  it.each(["entryCompletion", "isLocked", "lock", "free"] as const)("rejects reentrant lock during %s", async (method) => {
    let adapter!: WasmRotationStageAdapter;
    const value = method === "entryCompletion" ? "pending" : method === "isLocked" ? false : undefined;
    const source = handle({ [method]: vi.fn(() => { adapter.lock(); return value; }) } as Partial<WasmRotationStageV1>);
    adapter = new WasmRotationStageAdapter(() => source);
    await expect(adapter.load()).rejects.toHaveProperty("code", "CANCELLED");
    expect(source.free).toHaveBeenCalledOnce();
    expect(adapter.stage).toBeUndefined();
  });
});
