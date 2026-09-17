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
function setup() {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  return { client: new BrowserSyntheticVaultWorker(factory), workers, factory };
}
const selection = Object.freeze({
  reference: 1, mcp: "user_confirmed", cli: "pending", ci: "provider_verified", supersededRevocation: "pending",
} as const);
function stage() {
  return {
    baseGeneration: "initial_0001", targetGeneration: "rotated_0002",
    entries: [{ fixture: "mcp", requiredForCutover: true, completion: "pending" }],
    revocation: "pending", remainingRequired: 1, remainingOptional: 0, readyForCutover: false,
  };
}
const operations = ["inspectRotationStage", "saveRotationStage", "createRotationCutoverFromStage"] as const;
type Operation = (typeof operations)[number];
function invoke(client: BrowserSyntheticVaultWorker, operation: Operation, bytes: Uint8Array = new Uint8Array([1, 2])) {
  return operation === "saveRotationStage" ? client.saveRotationStage(bytes, selection) : client[operation](bytes, 1);
}
function response(operation: Operation) {
  return operation === "inspectRotationStage" ? { ok: true, kind: "rotationStage", stage: stage() }
    : { ok: true, kind: "archive", bytes: new Uint8Array([7, 8]) };
}
afterEach(() => { vi.useRealTimers(); });

describe("durable rotation Worker client boundary", () => {
  it.each(operations)("%s snapshots and dispatches only bounded closed inputs", async (operation) => {
    const { client, workers } = setup();
    const bytes = new Uint8Array([1, 2]);
    const pending = invoke(client, operation, bytes);
    const request = workers[0]!.postMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toEqual(operation === "saveRotationStage"
      ? { op: operation, bytes, selection } : { op: operation, bytes, reference: 1 });
    expect(request.bytes).not.toBe(bytes);
    if (operation === "saveRotationStage") {
      expect(request.selection).not.toBe(selection);
      expect(Object.isFrozen(request.selection)).toBe(true);
    }
    bytes.fill(0);
    expect(request.bytes).toEqual(new Uint8Array([1, 2]));
    workers[0]!.reply(response(operation));
    await pending;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("returns a deeply frozen fresh stage, or explicit null when no authenticated stage exists", async () => {
    const { client, workers } = setup();
    const input = stage();
    const inspection = client.inspectRotationStage(new Uint8Array([1]), 0);
    workers[0]!.reply({ ok: true, kind: "rotationStage", stage: input });
    const result = await inspection;
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result?.entries)).toBe(true);
    input.entries[0]!.completion = "provider_verified";
    expect(result?.entries[0]?.completion).toBe("pending");
    const absent = client.inspectRotationStage(new Uint8Array([1]), 0);
    workers[1]!.reply({ ok: true, kind: "rotationStage", stage: null });
    expect(await absent).toBeNull();
  });
  it.each(["saveRotationStage", "createRotationCutoverFromStage"] as const)("%s returns a fresh ciphertext copy", async (operation) => {
    const { client, workers } = setup();
    const pending = invoke(client, operation);
    const candidate = new Uint8Array([7, 8]);
    workers[0]!.reply({ ok: true, kind: "archive", bytes: candidate });
    const result = await pending;
    expect(result).toEqual(candidate);
    expect(result).not.toBe(candidate);
    candidate.fill(0);
    expect(result).toEqual(new Uint8Array([7, 8]));
  });
  it.each([-0, -1, 128, 0.5, "1", null, NaN, Infinity])("rejects invalid reference %# before creating Worker", async (invalid) => {
    const { client, factory } = setup();
    await expect(client.inspectRotationStage(new Uint8Array([1]), invalid as never)).rejects.toHaveProperty("code", "INVALID_ARCHIVE");
    await expect(client.createRotationCutoverFromStage(new Uint8Array([1]), invalid as never)).rejects.toHaveProperty("code", "INVALID_ARCHIVE");
    await expect(client.saveRotationStage(new Uint8Array([1]), { ...selection, reference: invalid } as never)).rejects.toHaveProperty("code", "INVALID_ARCHIVE");
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(operations)("%s rejects unsafe archive representations before Worker creation", async (operation) => {
    const detached = new Uint8Array([1]); structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const bytes of [new Uint8Array(), new Uint8Array(SYNTHETIC_ARCHIVE_MAX_BYTES + 1),
      new Uint8Array(new SharedArrayBuffer(1)), detached, new (class Bytes extends Uint8Array {})([1])]) {
      const { client, factory } = setup();
      await expect(invoke(client, operation, bytes)).rejects.toHaveProperty("code");
      expect(factory).not.toHaveBeenCalled();
    }
  });
  it.each([
    { ...stage(), baseGeneration: "future" }, { ...stage(), targetGeneration: "terminal_0003" },
    { ...stage(), remainingRequired: 0 }, { ...stage(), readyForCutover: true },
    { ...stage(), entries: new Array(1) }, { ...stage(), recordId: "private" }, undefined,
  ])("rejects malformed saved progress %#", async (invalid) => {
    const { client, workers } = setup();
    const pending = client.inspectRotationStage(new Uint8Array([1]), 0);
    workers[0]!.reply({ ok: true, kind: "rotationStage", stage: invalid });
    await expect(pending).rejects.toHaveProperty("code", "INVALID_CATALOG");
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
  it.each(operations)("%s rejects extra fields, accessors, prototype/symbol messages and wrong kinds", async (operation) => {
    const getter = vi.fn(() => true);
    const variants = [
      { ...response(operation), privateValue: "private" },
      { ...response(operation), [Symbol("extra")]: true },
      { ...response(operation), kind: "catalog" },
      Object.defineProperty({ ...response(operation) }, "ok", { enumerable: true, get: getter }),
      Object.assign(new (class Message {})(), response(operation)),
      { ok: false, code: "AUTHENTICATION_FAILED", privateDetail: "private" },
    ];
    for (const variant of variants) {
      const { client, workers } = setup();
      const pending = invoke(client, operation);
      workers[0]!.reply(variant);
      await expect(pending).rejects.toHaveProperty("code", "BRIDGE_FAILURE");
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(operations)("%s cancellation rejects late results and leaves no handlers", async (operation) => {
    const { client, workers } = setup();
    const pending = invoke(client, operation);
    const rejected = expect(pending).rejects.toHaveProperty("code", "CANCELLED");
    const late = workers[0]!.onmessage!;
    client.cancel();
    late({ data: response(operation) } as MessageEvent<unknown>);
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers[0]!.onmessage).toBeNull();
    expect(workers[0]!.onerror).toBeNull();
    expect(workers[0]!.onmessageerror).toBeNull();
  });
  it.each(operations)("%s timeout terminates once and sanitizes failure", async (operation) => {
    vi.useFakeTimers();
    const { client, workers } = setup();
    const pending = invoke(client, operation);
    const rejected = expect(pending).rejects.toMatchObject({ code: "BRIDGE_FAILURE", message: "BRIDGE_FAILURE" });
    await vi.advanceTimersByTimeAsync(SYNTHETIC_WORKER_TIMEOUT_MS);
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("invalid replacement cancels an older pending inspection without dispatching", async () => {
    const { client, workers, factory } = setup();
    const pending = client.inspectRotationStage(new Uint8Array([1]), 0);
    const rejected = expect(pending).rejects.toHaveProperty("code", "CANCELLED");
    await expect(client.saveRotationStage(new Uint8Array([1]), { ...selection, ci: "future" } as never)).rejects.toHaveProperty("code", "INVALID_ARCHIVE");
    await rejected;
    expect(factory).toHaveBeenCalledOnce();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("sanitizes hostile proxy throws without leaving the operation pending", async () => {
    const { client, workers } = setup();
    const thrown = Proxy.revocable({}, {}); thrown.revoke();
    const pending = client.inspectRotationStage(new Uint8Array([1]), 0);
    workers[0]!.reply(new Proxy({}, { getOwnPropertyDescriptor() { throw thrown.proxy; } }));
    await expect(pending).rejects.toHaveProperty("code", "BRIDGE_FAILURE");
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("cancellation during projection prevents a reentrant stage from publishing", async () => {
    const { client, workers } = setup();
    const pending = client.inspectRotationStage(new Uint8Array([1]), 0);
    const rejection = expect(pending).rejects.toHaveProperty("code", "CANCELLED");
    const reentrant = new Proxy(stage(), { getPrototypeOf() { client.cancel(); return Object.prototype; } });
    workers[0]!.reply({ ok: true, kind: "rotationStage", stage: reentrant });
    await rejection;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("old worker cleanup does not clear a newer reentrant cancellation handle", async () => {
    const { client, workers } = setup();
    const pending = client.inspectRotationStage(new Uint8Array([1]), 0);
    let replacement!: ReturnType<typeof client.inspectRotationStage>;
    workers[0]!.terminate.mockImplementationOnce(() => { replacement = client.inspectRotationStage(new Uint8Array([2]), 1); });
    workers[0]!.reply({ ok: true, kind: "rotationStage", stage: null });
    expect(await pending).toBeNull();
    const rejected = expect(replacement).rejects.toHaveProperty("code", "CANCELLED");
    client.cancel();
    await rejected;
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  });
  it.each(["saveRotationStage", "createRotationCutoverFromStage"] as const)("%s rejects malformed candidate output", async (operation) => {
    const detached = new Uint8Array([1]); structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const bytes of [new Uint8Array(), new Uint8Array(SYNTHETIC_ARCHIVE_MAX_BYTES + 1),
      new Uint8Array(new SharedArrayBuffer(1)), detached]) {
      const { client, workers } = setup();
      const pending = invoke(client, operation);
      workers[0]!.reply({ ok: true, kind: "archive", bytes });
      await expect(pending).rejects.toHaveProperty("code");
      expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    }
  });
  it.each(["AUTHENTICATION_FAILED", "PRIVATE_ERROR"])("sanitizes explicit Worker error %s", async (error) => {
    const { client, workers } = setup();
    const pending = client.inspectRotationStage(new Uint8Array([1]), 0);
    workers[0]!.reply({ ok: false, code: error });
    const code = error === "AUTHENTICATION_FAILED" ? error : "BRIDGE_FAILURE";
    await expect(pending).rejects.toMatchObject({ code, message: code });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
});
