import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wasm = vi.hoisted(() => ({
  init: vi.fn(), append: vi.fn(), create: vi.fn(), cutover: vi.fn(), edit: vi.fn(), inspectRotation: vi.fn(), open: vi.fn(),
  inspectStage: vi.fn(), saveStage: vi.fn(), cutoverStage: vi.fn(),
}));
vi.mock("../../generated/vault-wasm-demo/vault_client_wasm.js", () => ({
  default: wasm.init, appendSyntheticRegistration: wasm.append, createSyntheticArchive: wasm.create,
  createSyntheticRotationCutover: wasm.cutover, editSyntheticConnections: wasm.edit,
  inspectSyntheticRotationChecklist: wasm.inspectRotation, openSyntheticArchive: wasm.open,
  inspectSyntheticRotationStage: wasm.inspectStage, createSyntheticRotationStage: wasm.saveStage,
  createSyntheticRotationCutoverFromStage: wasm.cutoverStage,
}));
function handle(overrides: Record<string, unknown> = {}) {
  return {
    isLocked: vi.fn(() => false), lock: vi.fn(), free: vi.fn(),
    baseGeneration: vi.fn(() => "initial_0001"), targetGeneration: vi.fn(() => "rotated_0002"),
    entryCount: vi.fn(() => 1), entryFixture: vi.fn(() => "mcp"),
    entryRequiredForCutover: vi.fn(() => true), entryCompletion: vi.fn(() => "pending"),
    revocation: vi.fn(() => "pending"), remainingRequired: vi.fn(() => 1), remainingOptional: vi.fn(() => 0),
    readyForCutover: vi.fn(() => false), privateField: vi.fn(() => "PRIVATE_MUST_NOT_LEAVE_WORKER"), ...overrides,
  };
}
async function harness() {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  const port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: vi.fn(), close: vi.fn(() => { finish(); }),
  };
  vi.stubGlobal("self", port);
  await import("./syntheticVault.worker");
  const send = port.onmessage!;
  return { port, closed, send: (data: unknown) => { send({ data } as MessageEvent<unknown>); } };
}
const selection = Object.freeze({
  reference: 1, mcp: "user_confirmed", cli: "pending", ci: "provider_verified", supersededRevocation: "pending",
} as const);
const operations = ["inspectRotationStage", "saveRotationStage", "createRotationCutoverFromStage"] as const;
function request(op: (typeof operations)[number]) {
  return op === "saveRotationStage" ? { op, bytes: new Uint8Array([1, 2]), selection }
    : { op, bytes: new Uint8Array([1, 2]), reference: 1 };
}
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  wasm.init.mockResolvedValue(undefined);
  wasm.inspectStage.mockReturnValue(handle());
  wasm.saveStage.mockReturnValue(new Uint8Array([7, 8]));
  wasm.cutoverStage.mockReturnValue(new Uint8Array([7, 8]));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("durable saved-stage Worker dispatch (mock WASM)", () => {
  it("projects a stage only after cleanup and never calls private or finalization methods", async () => {
    const source = handle();
    wasm.inspectStage.mockReturnValueOnce(source);
    const { port, send, closed } = await harness();
    send(request("inspectRotationStage"));
    await closed;
    expect(wasm.inspectStage).toHaveBeenCalledWith(new Uint8Array([1, 2]), 1);
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
    expect(source.privateField).not.toHaveBeenCalled();
    expect(source.free.mock.invocationCallOrder[0]).toBeLessThan(port.postMessage.mock.invocationCallOrder[0]!);
    expect(port.postMessage).toHaveBeenCalledWith({
      ok: true, kind: "rotationStage", stage: {
        baseGeneration: "initial_0001", targetGeneration: "rotated_0002",
        entries: [{ fixture: "mcp", requiredForCutover: true, completion: "pending" }],
        revocation: "pending", remainingRequired: 1, remainingOptional: 0, readyForCutover: false,
      },
    });
    expect(wasm.cutoverStage).not.toHaveBeenCalled();
    expect(wasm.cutover).not.toHaveBeenCalled();
    expect(port.close).toHaveBeenCalledOnce();
  });
  it("maps only WASM undefined to explicit no-stage null", async () => {
    wasm.inspectStage.mockReturnValueOnce(undefined);
    const { port, send, closed } = await harness();
    send(request("inspectRotationStage"));
    await closed;
    expect(port.postMessage).toHaveBeenCalledWith({ ok: true, kind: "rotationStage", stage: null });
  });
  it.each([["pending", 0], ["user_confirmed", 1], ["provider_verified", 2]] as const)(
    "maps %s revocation to closed primitive %i and preserves one-shot API separation", async (supersededRevocation, code) => {
      const { port, send, closed } = await harness();
      send({ op: "saveRotationStage", bytes: new Uint8Array([1, 2]), selection: { ...selection, supersededRevocation } });
      await closed;
      expect(wasm.saveStage).toHaveBeenCalledWith(new Uint8Array([1, 2]), 1, true, false, false, false, false, true, code);
      expect(wasm.cutover).not.toHaveBeenCalled();
      expect(wasm.cutoverStage).not.toHaveBeenCalled();
      expect(wasm.open).not.toHaveBeenCalled();
      expect(port.postMessage.mock.calls[0]?.[0]).toMatchObject({ ok: true, kind: "archive" });
    },
  );
  it("snapshots both dispatch and closed input before async initialization", async () => {
    let initialized!: () => void;
    wasm.init.mockReturnValueOnce(new Promise<void>((resolve) => { initialized = resolve; }));
    const { send, closed } = await harness();
    const mutableSelection = { ...selection } as Record<string, unknown>;
    const bytes = new Uint8Array([1, 2]);
    const input = { op: "saveRotationStage", bytes, selection: mutableSelection };
    send(input);
    input.op = "createRotationCutoverFromStage";
    bytes.fill(0);
    mutableSelection.reference = 2;
    mutableSelection.supersededRevocation = "provider_verified";
    initialized();
    await closed;
    expect(wasm.saveStage).toHaveBeenCalledWith(new Uint8Array([1, 2]), 1, true, false, false, false, false, true, 0);
    expect(wasm.cutoverStage).not.toHaveBeenCalled();
  });
  it.each(["saveRotationStage", "createRotationCutoverFromStage"] as const)("%s transfers only an owned candidate copy", async (op) => {
    const candidate = new Uint8Array([7, 8]);
    (op === "saveRotationStage" ? wasm.saveStage : wasm.cutoverStage).mockReturnValueOnce(candidate);
    const { port, send, closed } = await harness();
    let delivered: unknown;
    port.postMessage.mockImplementation((message: unknown, transfer?: Transferable[]) => {
      delivered = structuredClone(message, { transfer: transfer ?? [] });
    });
    send(request(op));
    await closed;
    const [message, transfer] = port.postMessage.mock.calls[0]! as [{ bytes: Uint8Array }, Transferable[]];
    expect(transfer).toEqual([message.bytes.buffer]);
    expect(message.bytes.byteLength).toBe(0);
    expect(candidate).toEqual(new Uint8Array([7, 8]));
    expect(delivered).toEqual({ ok: true, kind: "archive", bytes: new Uint8Array([7, 8]) });
    if (op === "createRotationCutoverFromStage") expect(wasm.cutoverStage).toHaveBeenCalledWith(new Uint8Array([1, 2]), 1);
  });
  it.each(operations)("%s rejects unsafe archive input before init", async (op) => {
    const { port, send, closed } = await harness();
    send({ ...request(op), bytes: new Uint8Array(new SharedArrayBuffer(2)) });
    await closed;
    expect(wasm.init).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "INVALID_ARCHIVE" });
  });
  it.each([-0, 128, 1.5, "1", NaN, undefined])("rejects invalid reference %# before init", async (reference) => {
    const { port, send, closed } = await harness();
    send({ ...request("inspectRotationStage"), reference });
    await closed;
    expect(wasm.init).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "INVALID_ARCHIVE" });
  });
  it.each([{ ...selection, reference: -0 }, { ...selection, mcp: "complete" },
    { ...selection, supersededRevocation: true }, { ...selection, recordId: "private" }])(
    "rejects invalid stage selection before init", async (invalid) => {
      const { port, send, closed } = await harness();
      send({ ...request("saveRotationStage"), selection: invalid });
      await closed;
      expect(wasm.init).not.toHaveBeenCalled();
      expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "INVALID_ARCHIVE" });
    },
  );
  it.each(["op", "bytes", "reference"])("rejects a request %s getter without invoking it", async (field) => {
    const { port, send, closed } = await harness();
    const getter = vi.fn(() => "PRIVATE_DETAIL");
    send(Object.defineProperty(request("inspectRotationStage"), field, { get: getter, enumerable: true }));
    await closed;
    expect(getter).not.toHaveBeenCalled();
    expect(wasm.init).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "BRIDGE_FAILURE" });
  });
  it("rejects an extra request field rather than forwarding identifiers", async () => {
    const { port, send, closed } = await harness();
    send({ ...request("inspectRotationStage"), recordId: "private" });
    await closed;
    expect(wasm.init).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "BRIDGE_FAILURE" });
  });
  it("rejects malformed handle, cleans up, and never publishes partial progress", async () => {
    const source = handle({ readyForCutover: () => true });
    wasm.inspectStage.mockReturnValueOnce(source);
    const { port, send, closed } = await harness();
    send(request("inspectRotationStage"));
    await closed;
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "INVALID_CATALOG" });
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
  });
  it.each(["AUTHENTICATION_FAILED", "PRIVATE_DETAIL"])("sanitizes finalization failure %s", async (error) => {
    wasm.cutoverStage.mockImplementationOnce(() => { throw error; });
    const { port, send, closed } = await harness();
    send(request("createRotationCutoverFromStage"));
    await closed;
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: error === "AUTHENTICATION_FAILED" ? error : "BRIDGE_FAILURE" });
    expect(port.close).toHaveBeenCalledOnce();
  });
  it("allows only one stage operation per Worker", async () => {
    const { send, closed } = await harness();
    send(request("saveRotationStage")); send(request("createRotationCutoverFromStage"));
    await closed;
    expect(wasm.saveStage).toHaveBeenCalledOnce();
    expect(wasm.cutoverStage).not.toHaveBeenCalled();
    expect(wasm.init).toHaveBeenCalledOnce();
  });
  it.each(["saveRotationStage", "createRotationCutoverFromStage"] as const)("%s rejects a shared candidate instead of transferring it", async (op) => {
    (op === "saveRotationStage" ? wasm.saveStage : wasm.cutoverStage)
      .mockReturnValueOnce(new Uint8Array(new SharedArrayBuffer(2)));
    const { port, send, closed } = await harness();
    send(request(op));
    await closed;
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "INVALID_ARCHIVE" });
    expect(port.close).toHaveBeenCalledOnce();
  });
  it("cleanup failure rejects an otherwise valid restored stage", async () => {
    const source = handle({ lock: vi.fn(() => { throw new Error("PRIVATE_LOCK_DETAIL"); }) });
    wasm.inspectStage.mockReturnValueOnce(source);
    const { port, send, closed } = await harness();
    send(request("inspectRotationStage"));
    await closed;
    expect(source.lock).toHaveBeenCalledOnce();
    expect(source.free).toHaveBeenCalledOnce();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "CLEANUP_FAILED" });
  });
});
