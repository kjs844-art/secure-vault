import { describe, expect, it, vi } from "vitest";
import { WasmCatalogAdapter } from "./WasmCatalogAdapter";
import {
  CATALOG_CONNECTION_TYPES_V1, CATALOG_CREDENTIAL_TYPES_V1, CATALOG_STATUSES_V1, CatalogAdapterError,
  type WasmCatalogV1,
} from "./catalogProtocol";

function catalog(overrides: Partial<WasmCatalogV1> = {}) {
  let locked = false;
  return {
    length: vi.fn(() => 1),
    isLocked: vi.fn(() => locked),
    lock: vi.fn(() => { locked = true; }),
    free: vi.fn(),
    itemName: vi.fn(() => "Synthetic workshop"),
    providerName: vi.fn(() => "Synthetic provider"),
    credentialType: vi.fn(() => "api_key"),
    status: vi.fn(() => "active"),
    connectionCount: vi.fn(() => 2),
    secretFieldCount: vi.fn(() => 1),
    mcpConnectionCount: vi.fn(() => 1),
    connectionLabel: vi.fn((_reference: number, index: number) => index === 0 ? "Example MCP" : "Example CLI"),
    connectionType: vi.fn((_reference: number, index: number) => index === 0 ? "mcp_server" : "cli"),
    ...overrides,
  };
}

function deferred() {
  let resolve: (value: WasmCatalogV1) => void = () => {
    throw new Error("Deferred not initialized");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<WasmCatalogV1>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("WasmCatalogAdapter", () => {
  it("copies only the reviewed local metadata fields and freezes the result", async () => {
    const handle = Object.assign(catalog(), {
      secretValue: "DEMO_VALUE_ONLY_do_not_project",
      recordId: "synthetic-persistent-id",
      notes: "synthetic private note",
    });
    const adapter = new WasmCatalogAdapter(() => handle);
    const rows = await adapter.load();
    expect(Object.keys(rows[0] ?? {})).toEqual([
      "reference", "itemName", "providerName", "credentialType", "status",
      "connectionCount", "secretFieldCount", "mcpConnectionCount", "connections",
    ]);
    expect(rows[0]).toEqual({
      reference: 0, itemName: "Synthetic workshop", providerName: "Synthetic provider",
      credentialType: "api_key", status: "active", connectionCount: 2,
      secretFieldCount: 1, mcpConnectionCount: 1,
      connections: [{label: "Example MCP", consumerType: "mcp_server"}, {label: "Example CLI", consumerType: "cli"}],
    });
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(Object.isFrozen(rows[0]?.connections)).toBe(true);
    expect(Object.isFrozen(rows[0]?.connections[0])).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("DEMO_VALUE_ONLY");
    expect(JSON.stringify(rows)).not.toContain("synthetic-persistent-id");
    expect(adapter.isLocked).toBe(false);
    adapter.dispose();
  });

  it.each(CATALOG_CREDENTIAL_TYPES_V1)("accepts core kind %s", async (kind) => {
    const adapter = new WasmCatalogAdapter(() => catalog({ credentialType: () => kind }));
    expect((await adapter.load())[0]?.credentialType).toBe(kind);
    adapter.dispose();
  });

  it.each(CATALOG_STATUSES_V1)("accepts core status %s", async (status) => {
    const adapter = new WasmCatalogAdapter(() => catalog({ status: () => status }));
    expect((await adapter.load())[0]?.status).toBe(status);
    adapter.dispose();
  });

  it.each(CATALOG_CONNECTION_TYPES_V1)("accepts reviewed relationship type %s", async (type) => {
    const adapter = new WasmCatalogAdapter(() => catalog({
      connectionType: () => type,
      mcpConnectionCount: () => type === "mcp_server" ? 2 : 0,
    }));
    expect((await adapter.load())[0]?.connections.map((connection) => connection.consumerType)).toEqual([type, type]);
    adapter.dispose();
  });

  it("releases the old Rust handle and clears owned rows on lock", async () => {
    const handle = catalog();
    const adapter = new WasmCatalogAdapter(() => handle);
    await adapter.load();
    adapter.lock();
    expect(adapter.entries).toEqual([]);
    expect(adapter.isLocked).toBe(true);
    expect(handle.lock).toHaveBeenCalledTimes(1);
    expect(handle.free).toHaveBeenCalledTimes(1);
    adapter.lock();
    adapter.dispose();
    expect(handle.free).toHaveBeenCalledTimes(1);
  });

  it("does not publish a load completed after locking", async () => {
    const pending = deferred();
    const handle = catalog();
    const adapter = new WasmCatalogAdapter(() => pending.promise);
    const result = adapter.load();
    adapter.lock();
    pending.resolve(handle);
    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    expect(adapter.entries).toEqual([]);
    expect(handle.itemName).not.toHaveBeenCalled();
    expect(handle.lock).toHaveBeenCalledTimes(1);
    expect(handle.free).toHaveBeenCalledTimes(1);
  });

  it("retains the newer snapshot when an older load completes last", async () => {
    const pending = deferred();
    const older = catalog();
    const newer = catalog({ itemName: () => "New synthetic catalog" });
    const factory = vi.fn<() => WasmCatalogV1 | Promise<WasmCatalogV1>>()
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(newer);
    const adapter = new WasmCatalogAdapter(factory);
    const olderResult = adapter.load();
    await adapter.load();
    pending.resolve(older);
    await expect(olderResult).rejects.toMatchObject({ code: "CANCELLED" });
    expect(adapter.entries[0]?.itemName).toBe("New synthetic catalog");
    expect(older.free).toHaveBeenCalledTimes(1);
    expect(newer.free).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("cancels a pending factory rejection after locking", async () => {
    const pending = deferred();
    const adapter = new WasmCatalogAdapter(() => pending.promise);
    const result = adapter.load();
    adapter.lock();
    pending.reject("AUTHENTICATION_FAILED");
    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    expect(adapter.entries).toEqual([]);
    expect(adapter.isLocked).toBe(true);
  });

  it("cancels an older rejection while preserving a newer successful snapshot", async () => {
    const pending = deferred();
    const newer = catalog({ itemName: () => "New synthetic catalog" });
    const factory = vi.fn<() => WasmCatalogV1 | Promise<WasmCatalogV1>>()
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(newer);
    const adapter = new WasmCatalogAdapter(factory);
    const olderResult = adapter.load();
    await adapter.load();
    pending.reject("AUTHENTICATION_FAILED");
    await expect(olderResult).rejects.toMatchObject({ code: "CANCELLED" });
    expect(adapter.entries[0]?.itemName).toBe("New synthetic catalog");
    expect(adapter.isLocked).toBe(false);
    expect(newer.free).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("clears an existing snapshot before awaiting its replacement", async () => {
    const original = catalog();
    const pending = deferred();
    const factory = vi.fn<() => WasmCatalogV1 | Promise<WasmCatalogV1>>()
      .mockReturnValueOnce(original).mockReturnValueOnce(pending.promise);
    const adapter = new WasmCatalogAdapter(factory);
    await adapter.load();
    const nextResult = adapter.load();
    expect(adapter.entries).toEqual([]);
    expect(original.free).toHaveBeenCalledTimes(1);
    pending.resolve(catalog());
    await nextResult;
    adapter.dispose();
  });

  it("disposal invalidates pending results and permanently rejects new loads", async () => {
    const pending = deferred();
    const handle = catalog();
    const factory = vi.fn(() => pending.promise);
    const adapter = new WasmCatalogAdapter(factory);
    const result = adapter.load();
    adapter.dispose();
    pending.resolve(handle);
    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(adapter.load()).rejects.toMatchObject({ code: "DISPOSED" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(handle.free).toHaveBeenCalledTimes(1);
  });

  it("drops partial rows when a later entry fails authentication", async () => {
    const handle = catalog({
      length: () => 2,
      itemName: (reference) => {
        if (reference === 1) throw "AUTHENTICATION_FAILED";
        return "First synthetic entry";
      },
    });
    const adapter = new WasmCatalogAdapter(() => handle);
    await expect(adapter.load()).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(adapter.entries).toEqual([]);
    expect(adapter.isLocked).toBe(true);
    expect(handle.free).toHaveBeenCalledTimes(1);
  });

  const invalidCases: [string, Partial<WasmCatalogV1>, string][] = [
    ["unknown kind", { credentialType: () => "future_kind" }, "INVALID_CATALOG"],
    ["unknown status", { status: () => "future_status" }, "INVALID_CATALOG"],
    ["negative length", { length: () => -1 }, "INVALID_CATALOG"],
    ["fractional count", { connectionCount: () => 0.5 }, "INVALID_CATALOG"],
    ["NaN length", { length: () => Number.NaN }, "INVALID_CATALOG"],
    ["too many rows", { length: () => 5_001 }, "LIMITS_EXCEEDED"],
    ["too many connections", { connectionCount: () => 129 }, "LIMITS_EXCEEDED"],
    ["no secret fields", { secretFieldCount: () => 0 }, "INVALID_CATALOG"],
    ["too many secret fields", { secretFieldCount: () => 17 }, "LIMITS_EXCEEDED"],
    ["MCP count exceeds connections", { mcpConnectionCount: () => 3 }, "LIMITS_EXCEEDED"],
    ["missing name", { itemName: () => "" }, "INVALID_CATALOG"],
    ["UTF-8 name overflow", { itemName: () => "한".repeat(43) }, "LIMITS_EXCEEDED"],
    ["provider overflow", { providerName: () => "x".repeat(257) }, "LIMITS_EXCEEDED"],
    ["unknown connection type", { connectionType: () => "future_type" }, "INVALID_CATALOG"],
    ["connection UTF-8 overflow", { connectionLabel: () => "한".repeat(86) }, "LIMITS_EXCEEDED"],
    ["inconsistent MCP aggregate", { mcpConnectionCount: () => 0 }, "INVALID_CATALOG"],
    ["locked handle", { isLocked: () => true }, "LOCKED"],
  ];
  it.each(invalidCases)("fails closed for %s", async (_label, overrides, code) => {
    const handle = catalog(overrides);
    const adapter = new WasmCatalogAdapter(() => handle);
    await expect(adapter.load()).rejects.toMatchObject({ code });
    expect(adapter.entries).toEqual([]);
    expect(handle.free).toHaveBeenCalledTimes(1);
  });

  it("supports an empty authenticated catalog", async () => {
    const handle = catalog({ length: () => 0 });
    const adapter = new WasmCatalogAdapter(() => handle);
    expect(await adapter.load()).toEqual([]);
    expect(adapter.isLocked).toBe(false);
    expect(handle.itemName).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("never retains arbitrary errors as messages or causes", async () => {
    const adapter = new WasmCatalogAdapter(() => {
      throw new Error("DEMO_VALUE_ONLY_private_loader_detail");
    });
    await expect(adapter.load()).rejects.toMatchObject({
      name: "CatalogAdapterError", message: "BRIDGE_FAILURE", code: "BRIDGE_FAILURE",
    });
    try { await adapter.load(); } catch (error) {
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("DEMO_VALUE_ONLY");
    }
  });

  it("rebuilds upstream adapter errors without mutable messages, causes, or private fields", async () => {
    const upstream = Object.assign(new CatalogAdapterError("AUTHENTICATION_FAILED"), {
      message: "DEMO_VALUE_ONLY_private_message",
      cause: new Error("DEMO_VALUE_ONLY_private_cause"),
      privateDetail: "DEMO_VALUE_ONLY_private_field",
    });
    const adapter = new WasmCatalogAdapter(() => { throw upstream; });
    const result = adapter.load();
    await expect(result).rejects.toMatchObject({
      name: "CatalogAdapterError", message: "AUTHENTICATION_FAILED", code: "AUTHENTICATION_FAILED",
    });
    await expect(result).rejects.not.toBe(upstream);
    await expect(result).rejects.not.toHaveProperty("cause");
    await expect(result).rejects.not.toHaveProperty("privateDetail");
    await expect(result).rejects.not.toHaveProperty("stack", upstream.stack);
  });

  it.each(["DEMO_VALUE_ONLY_invalid_code", 42, null])("rejects a runtime-mutated error code %s", async (code) => {
    const upstream = Object.assign(new CatalogAdapterError("AUTHENTICATION_FAILED"), { code });
    const adapter = new WasmCatalogAdapter(() => { throw upstream; });
    await expect(adapter.load()).rejects.toMatchObject({
      message: "BRIDGE_FAILURE", code: "BRIDGE_FAILURE",
    });
  });

  it("does not propagate an exception from an upstream error code getter", async () => {
    const upstream = new CatalogAdapterError("AUTHENTICATION_FAILED");
    Object.defineProperty(upstream, "code", {
      get: () => { throw new Error("DEMO_VALUE_ONLY_private_getter"); },
    });
    const adapter = new WasmCatalogAdapter(() => { throw upstream; });
    await expect(adapter.load()).rejects.toMatchObject({
      message: "BRIDGE_FAILURE", code: "BRIDGE_FAILURE",
    });
  });

  it("still reports cleanup failure when a stale handle cannot be released", async () => {
    const pending = deferred();
    const handle = catalog({ lock: () => { throw "synthetic cleanup failure"; } });
    const adapter = new WasmCatalogAdapter(() => pending.promise);
    const result = adapter.load();
    adapter.lock();
    pending.resolve(handle);
    await expect(result).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect(handle.free).toHaveBeenCalledTimes(1);
    expect(adapter.entries).toEqual([]);
  });

  it("clears owned state and attempts free even when Rust lock throws", async () => {
    const handle = catalog({ lock: () => { throw "synthetic cleanup failure"; } });
    const adapter = new WasmCatalogAdapter(() => handle);
    await adapter.load();
    expect(() => adapter.lock()).toThrow("CLEANUP_FAILED");
    expect(adapter.entries).toEqual([]);
    expect(adapter.isLocked).toBe(true);
    expect(handle.free).toHaveBeenCalledTimes(1);
  });
});
