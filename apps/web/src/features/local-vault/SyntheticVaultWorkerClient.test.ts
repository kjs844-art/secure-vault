import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSyntheticVaultWorker, SYNTHETIC_ARCHIVE_MAX_BYTES, SYNTHETIC_WORKER_TIMEOUT_MS,
  type SyntheticVaultWorkerPort,
} from "./SyntheticVaultWorkerClient";

class FakeWorker implements SyntheticVaultWorkerPort {
  onmessage: SyntheticVaultWorkerPort["onmessage"] = null;
  onerror: SyntheticVaultWorkerPort["onerror"] = null;
  onmessageerror: SyntheticVaultWorkerPort["onmessageerror"] = null;
  postMessage = vi.fn<(message: unknown) => void>();
  terminate = vi.fn();
  reply(data: unknown): void { this.onmessage?.({ data } as MessageEvent<unknown>); }
}

function row() {
  return {
    reference: 0, itemName: "Example API", providerName: "Example Workshop",
    credentialType: "api_key", status: "active", connectionCount: 2,
    secretFieldCount: 1, mcpConnectionCount: 1,
    connections: [
      { label: "Example MCP", consumerType: "mcp_server" },
      { label: "Example CLI", consumerType: "cli" },
    ],
  };
}

function setup() {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  return { client: new BrowserSyntheticVaultWorker(factory), workers, factory };
}

afterEach(() => { vi.useRealTimers(); });

describe("BrowserSyntheticVaultWorker", () => {
  it("dispatches a copied closed append selection and returns only copied ciphertext", async () => {
    const { client, workers } = setup();
    const input = new Uint8Array([1, 2]);
    const selection = { profileId: 1, credentialId: 0, connectionIds: [2, 0] } as const;
    const pending = client.append(input, selection);
    const request = workers[0]!.postMessage.mock.calls[0]![0] as {
      op: string; bytes: Uint8Array; selection: typeof selection;
    };
    expect(request).toEqual({ op: "append", bytes: input, selection });
    expect(request.bytes).not.toBe(input);
    expect(request.selection).not.toBe(selection);
    expect(request.selection.connectionIds).not.toBe(selection.connectionIds);
    const candidate = new Uint8Array([1, 2, 3]);
    workers[0]!.reply({ ok: true, kind: "archive", bytes: candidate });
    const output = await pending;
    expect(output).toEqual(candidate);
    expect(output).not.toBe(candidate);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("rejects invalid append selection before starting the worker", async () => {
    const { client, factory } = setup();
    await expect(client.append(new Uint8Array([1]), {
      profileId: 0.5, credentialId: 0, connectionIds: [],
    } as never)).rejects.toHaveProperty("code", "INVALID_ARCHIVE");
    expect(factory).not.toHaveBeenCalled();
  });

  it("cancelled append cannot return a late archive or catalog", async () => {
    const { client, workers } = setup();
    const pending = client.append(new Uint8Array([1]), { profileId: 0, credentialId: 0, connectionIds: [] });
    const rejected = expect(pending).rejects.toHaveProperty("code", "CANCELLED");
    const late = workers[0]!.onmessage!;
    client.cancel();
    late({ data: { ok: true, kind: "archive", bytes: new Uint8Array([9]) } } as MessageEvent<unknown>);
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("creates nothing until called, returns an owned archive copy, then terminates", async () => {
    const { client, workers, factory } = setup();
    expect(factory).not.toHaveBeenCalled();
    const pending = client.create();
    const worker = workers[0]!;
    expect(worker.postMessage).toHaveBeenCalledWith({ op: "create" });
    const bytes = new Uint8Array([1, 2, 3]);
    worker.reply({ ok: true, kind: "archive", bytes });
    const result = await pending;
    expect(result).toEqual(bytes);
    expect(result).not.toBe(bytes);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    client.cancel();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("preserves input bytes and explicitly copies/freezes only allowlisted nested rows", async () => {
    const { client, workers } = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    const pending = client.open(bytes);
    const worker = workers[0]!;
    const request = worker.postMessage.mock.calls[0]![0] as { bytes: Uint8Array };
    expect(request.bytes).not.toBe(bytes);
    request.bytes[0] = 9;
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    const input = row();
    Object.assign(input, { secretValue: "DEMO_VALUE_ONLY_DO_NOT_PROJECT", recordId: "private-id" });
    Object.assign(input.connections[0]!, { url: "https://example.invalid", binding: "private" });
    worker.reply({ ok: true, kind: "catalog", entries: [input] });
    const result = await pending;
    expect(result).toEqual([row()]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[0]!.connections)).toBe(true);
    expect(Object.isFrozen(result[0]!.connections[0])).toBe(true);
    input.itemName = "changed";
    input.connections[0]!.label = "changed";
    expect(result[0]!.itemName).toBe("Example API");
    expect(result[0]!.connections[0]!.label).toBe("Example MCP");
  });

  it("cancel rejects immediately and ignores even a captured late callback", async () => {
    const { client, workers } = setup();
    const pending = client.create();
    const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    const worker = workers[0]!;
    const late = worker.onmessage!;
    client.cancel();
    await rejected;
    late({ data: { ok: true, kind: "archive", bytes: new Uint8Array([1]) } } as MessageEvent<unknown>);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("a newer operation terminates its predecessor and uses a fresh worker", async () => {
    const { client, workers } = setup();
    const older = client.create();
    const rejected = expect(older).rejects.toMatchObject({ code: "CANCELLED" });
    const newer = client.create();
    await rejected;
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    workers[1]!.reply({ ok: true, kind: "archive", bytes: new Uint8Array([2]) });
    expect(await newer).toEqual(new Uint8Array([2]));
  });

  it.each([
    [new Uint8Array(), "INVALID_ARCHIVE"],
    [new Uint8Array(SYNTHETIC_ARCHIVE_MAX_BYTES + 1), "LIMITS_EXCEEDED"],
    ["not bytes", "INVALID_ARCHIVE"],
  ])("rejects invalid input before starting a worker", async (bytes, code) => {
    const { client, factory } = setup();
    await expect(client.open(bytes as Uint8Array)).rejects.toMatchObject({ code });
    expect(factory).not.toHaveBeenCalled();
  });

  it("timeouts terminate work and expose only a fixed code", async () => {
    vi.useFakeTimers();
    const { client, workers } = setup();
    const pending = client.create();
    const rejected = expect(pending).rejects.toMatchObject({ code: "BRIDGE_FAILURE" });
    await vi.advanceTimersByTimeAsync(SYNTHETIC_WORKER_TIMEOUT_MS);
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(["AUTHENTICATION_FAILED", "UPGRADE_REQUIRED", "INVALID_ARCHIVE", "private detail"])(
    "sanitizes worker error %s", async (code) => {
      const { client, workers } = setup();
      const pending = client.create();
      workers[0]!.reply({ ok: false, code, message: "private error detail" });
      await expect(pending).rejects.toMatchObject({
        code: code === "private detail" ? "BRIDGE_FAILURE" : code,
        message: code === "private detail" ? "BRIDGE_FAILURE" : code,
      });
    },
  );

  it.each([
    { ok: true, kind: "archive", bytes: new Uint8Array() },
    { ok: true, kind: "catalog", entries: [] },
    { ok: "true", kind: "archive", bytes: new Uint8Array([1]) },
    null,
  ])("rejects malformed create responses", async (reply) => {
    const { client, workers } = setup();
    const pending = client.create();
    workers[0]!.reply(reply);
    await expect(pending).rejects.toHaveProperty("code");
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reference: 2 }, { itemName: "" }, { itemName: "한".repeat(43) },
    { credentialType: "future" }, { status: "future" }, { connectionCount: 129 },
    { connectionCount: 1.5 }, { secretFieldCount: 0 }, { mcpConnectionCount: 0 },
    { connections: new Array(2), mcpConnectionCount: 0 },
    { connections: [{ label: "Example", consumerType: "unknown" }, { label: "CLI", consumerType: "cli" }] },
  ])("rejects invalid catalog rows without publishing a partial result", async (override) => {
    const { client, workers } = setup();
    const pending = client.open(new Uint8Array([1]));
    workers[0]!.reply({ ok: true, kind: "catalog", entries: [{ ...row(), ...override }] });
    await expect(pending).rejects.toHaveProperty("code");
  });

  it("sanitizes startup, transport, and worker error failures", async () => {
    const broken = new BrowserSyntheticVaultWorker(() => { throw new Error("private details"); });
    await expect(broken.create()).rejects.toMatchObject({ code: "BRIDGE_FAILURE" });
    const { client, workers } = setup();
    const pending = client.create();
    workers[0]!.onerror?.({ message: "private details" } as ErrorEvent);
    await expect(pending).rejects.toMatchObject({ code: "BRIDGE_FAILURE" });
    const next = client.create();
    workers[1]!.onmessageerror?.({ data: "private details" } as MessageEvent<unknown>);
    await expect(next).rejects.toMatchObject({ code: "BRIDGE_FAILURE" });
  });
});
