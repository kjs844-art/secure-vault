import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wasm = vi.hoisted(() => ({
  init: vi.fn(), append: vi.fn(), create: vi.fn(), edit: vi.fn(), open: vi.fn(),
}));
vi.mock("../../generated/vault-wasm-demo/vault_client_wasm.js", () => ({
  default: wasm.init,
  appendSyntheticRegistration: wasm.append,
  createSyntheticArchive: wasm.create,
  editSyntheticConnections: wasm.edit,
  openSyntheticArchive: wasm.open,
}));

async function harness() {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  const port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(() => { finish(); }),
  };
  vi.stubGlobal("self", port);
  await import("./syntheticVault.worker");
  const send = port.onmessage!;
  return { port, closed, send: (data: unknown) => { send({ data } as MessageEvent<unknown>); } };
}

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  wasm.init.mockResolvedValue(undefined);
  wasm.edit.mockReturnValue(new Uint8Array([1, 2, 3]));
});
afterEach(() => { vi.unstubAllGlobals(); });

function invalidLengthArchive(kind: string): Uint8Array {
  const bytes = new Uint8Array(kind === "oversized" ? 524_289 : kind === "detached" ? 2 : 0);
  if (kind === "detached") structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  return Object.defineProperty(bytes, "byteLength", { value: 1 });
}

describe("synthetic connection-edit worker dispatch (mock WASM boundary)", () => {
  it.each(["empty", "oversized", "detached"])("rejects %s spoofed archive before WASM initialization", async (kind) => {
    const { port, send, closed } = await harness();
    send({ op: "editConnections", bytes: invalidLengthArchive(kind), selection: { reference: 0, connectionIds: [] } });
    await closed;
    expect(wasm.init).not.toHaveBeenCalled(); expect(wasm.edit).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: kind === "oversized" ? "LIMITS_EXCEEDED" : "INVALID_ARCHIVE" });
  });
  it.each(["empty", "oversized", "detached"])("rejects %s spoofed WASM output instead of returning ciphertext", async (kind) => {
    const { port, send, closed } = await harness();
    wasm.edit.mockReturnValueOnce(invalidLengthArchive(kind));
    send({ op: "editConnections", bytes: new Uint8Array([1]), selection: { reference: 0, connectionIds: [] } });
    await closed;
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: kind === "oversized" ? "LIMITS_EXCEEDED" : "INVALID_ARCHIVE" });
  });
  it("does not inspect native archive byteLength/length/iterator shadows", async () => {
    const { port, send, closed } = await harness();
    const shadow = vi.fn(() => { throw new Error("unused shadow"); });
    const bytes = Object.defineProperties(new Uint8Array([1, 2]), {
      byteLength: { get: shadow }, length: { get: shadow }, [Symbol.iterator]: { get: shadow },
    });
    wasm.edit.mockReturnValueOnce(bytes);
    send({ op: "editConnections", bytes, selection: { reference: 0, connectionIds: [] } });
    await closed;
    expect(wasm.edit).toHaveBeenCalledWith(new Uint8Array([1, 2]), 0, new Float64Array());
    expect(port.postMessage.mock.calls[0]![0]).toEqual({ ok: true, kind: "archive", bytes: new Uint8Array([1, 2]) });
    expect(shadow).not.toHaveBeenCalled();
  });
  it("snapshots selection and bytes before initialization and sends only copied ciphertext", async () => {
    const { port, send, closed } = await harness();
    const bytes = new Uint8Array([1, 2]);
    const selection = { reference: 2, connectionIds: [2, 0] };
    send({ op: "editConnections", bytes, selection });
    bytes.fill(9); selection.reference = 1; selection.connectionIds.length = 0;
    await closed;
    expect(wasm.edit).toHaveBeenCalledWith(new Uint8Array([1, 2]), 2, new Float64Array([2, 0]));
    const response = port.postMessage.mock.calls[0]![0];
    expect(response).toEqual({ ok: true, kind: "archive", bytes: new Uint8Array([1, 2, 3]) });
    expect(response.bytes).not.toBe(wasm.edit.mock.results[0]!.value);
    expect(wasm.open).not.toHaveBeenCalled();
    expect(port.close).toHaveBeenCalledOnce();
  });
  it.each([
    { reference: 128, connectionIds: [] }, { reference: 0.5, connectionIds: [] },
    { reference: NaN, connectionIds: [] }, { reference: 2 ** 32, connectionIds: [] },
    { reference: 0, connectionIds: [0, 0] }, { reference: 0, connectionIds: ["0"] },
    { reference: 0, connectionIds: [], recordId: "private" },
    { reference: 0, connectionIds: [], revisionId: "private" },
  ])("rejects non-closed edit selection before WASM init", async (selection) => {
    const { port, send, closed } = await harness();
    send({ op: "editConnections", bytes: new Uint8Array([1]), selection });
    await closed;
    expect(wasm.init).not.toHaveBeenCalled(); expect(wasm.edit).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "INVALID_ARCHIVE" });
  });
  it.each([new Uint8Array(), new Uint8Array(524_289)])("bounds archive input before WASM init", async (bytes) => {
    const { port, send, closed } = await harness();
    send({ op: "editConnections", bytes, selection: { reference: 0, connectionIds: [] } });
    await closed;
    expect(wasm.init).not.toHaveBeenCalled(); expect(wasm.edit).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: bytes.length === 0 ? "INVALID_ARCHIVE" : "LIMITS_EXCEEDED" });
  });
  it.each(["AUTHENTICATION_FAILED", "PRIVATE_ERROR"])("sanitizes the edit failure %s and closes", async (error) => {
    const { port, send, closed } = await harness();
    wasm.edit.mockImplementationOnce(() => { throw error; });
    send({ op: "editConnections", bytes: new Uint8Array([1]), selection: { reference: 0, connectionIds: [] } });
    await closed;
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: error === "AUTHENTICATION_FAILED" ? error : "BRIDGE_FAILURE" });
    expect(port.close).toHaveBeenCalledOnce();
  });
  it("allows only one request per worker even through a retained callback", async () => {
    const { send, closed } = await harness();
    const request = { op: "editConnections", bytes: new Uint8Array([1]), selection: { reference: 0, connectionIds: [] } };
    send(request); send(request); await closed;
    expect(wasm.edit).toHaveBeenCalledOnce();
  });
});
