import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wasm = vi.hoisted(() => ({
  init: vi.fn(), append: vi.fn(), create: vi.fn(), cutover: vi.fn(), edit: vi.fn(),
  inspectRotation: vi.fn(), open: vi.fn(),
}));
vi.mock("../../generated/vault-wasm-demo/vault_client_wasm.js", () => ({
  default: wasm.init,
  appendSyntheticRegistration: wasm.append,
  createSyntheticArchive: wasm.create,
  createSyntheticRotationCutover: wasm.cutover,
  editSyntheticConnections: wasm.edit,
  inspectSyntheticRotationChecklist: wasm.inspectRotation,
  openSyntheticArchive: wasm.open,
}));

function rotationHandle(overrides: Record<string, unknown> = {}) {
  return {
    isLocked: vi.fn(() => false),
    lock: vi.fn(),
    free: vi.fn(),
    generation: vi.fn(() => "initial_0001"),
    readinessState: vi.fn(() => "ready"),
    entryCount: vi.fn(() => 1),
    entryFixture: vi.fn(() => "mcp"),
    entryRequiredForCutover: vi.fn(() => true),
    remainingRequired: vi.fn(() => 0),
    remainingOptional: vi.fn(() => 0),
    secretValue: vi.fn(() => "PRIVATE_MUST_NOT_LEAVE_WORKER"),
    ...overrides,
  };
}

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

const selection = Object.freeze({
  reference: 1,
  mcp: "user_confirmed",
  cli: "pending",
  ci: "provider_verified",
  supersededRevocation: "provider_verified",
} as const);

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  wasm.init.mockResolvedValue(undefined);
  wasm.inspectRotation.mockReturnValue(rotationHandle());
  wasm.cutover.mockReturnValue(new Uint8Array([7, 8, 9]));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("synthetic rotation worker dispatch", () => {
  it("snapshots closed inputs, projects an allowlisted checklist, and releases the handle", async () => {
    const { port, send, closed } = await harness();
    const bytes = new Uint8Array([1, 2]);
    const mutable: {
      reference: number;
      mcp: "pending" | "user_confirmed" | "provider_verified";
      cli: "pending" | "user_confirmed" | "provider_verified";
      ci: "pending" | "user_confirmed" | "provider_verified";
      supersededRevocation: "user_confirmed" | "provider_verified";
    } = { ...selection };
    const handle = rotationHandle();
    wasm.inspectRotation.mockReturnValueOnce(handle);
    send({ op: "inspectRotation", bytes, selection: mutable });
    bytes.fill(9);
    mutable.reference = 0;
    mutable.mcp = "pending";
    await closed;

    expect(wasm.inspectRotation).toHaveBeenCalledWith(
      new Uint8Array([1, 2]), 1,
      true, false, false,
      false, false, true,
      1,
    );
    expect(handle.lock).toHaveBeenCalledOnce();
    expect(handle.free).toHaveBeenCalledOnce();
    expect(handle.secretValue).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({
      ok: true,
      kind: "rotationChecklist",
      checklist: {
        generation: "initial_0001",
        readinessState: "ready",
        entries: [{ fixture: "mcp", requiredForCutover: true }],
        remainingRequired: 0,
        remainingOptional: 0,
      },
    });
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("returns only an owned cutover archive copy and never opens a catalog", async () => {
    const { port, send, closed } = await harness();
    const candidate = new Uint8Array([7, 8, 9]);
    wasm.cutover.mockReturnValueOnce(candidate);
    send({ op: "createRotationCutover", bytes: new Uint8Array([1]), selection });
    await closed;

    expect(wasm.cutover).toHaveBeenCalledWith(
      new Uint8Array([1]), 1,
      true, false, false,
      false, false, true,
      1,
    );
    const response = port.postMessage.mock.calls[0]![0];
    expect(response).toEqual({ ok: true, kind: "archive", bytes: candidate });
    expect(response.bytes).not.toBe(candidate);
    expect(wasm.open).not.toHaveBeenCalled();
  });

  it("transfers and detaches only the Worker-owned cutover copy", async () => {
    const { port, send, closed } = await harness();
    const candidate = new Uint8Array([7, 8, 9]);
    let delivered: unknown;
    port.postMessage.mockImplementation((message: unknown, transfer?: Transferable[]) => {
      delivered = structuredClone(message, { transfer: transfer ?? [] });
    });
    wasm.cutover.mockReturnValueOnce(candidate);
    send({ op: "createRotationCutover", bytes: new Uint8Array([1]), selection });
    await closed;

    const [posted, transfer] = port.postMessage.mock.calls[0]! as [
      { ok: boolean; kind: string; bytes: Uint8Array }, Transferable[],
    ];
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(posted.bytes.buffer);
    expect(posted.bytes.byteLength).toBe(0);
    expect(delivered).toEqual({
      ok: true,
      kind: "archive",
      bytes: new Uint8Array([7, 8, 9]),
    });
    expect(candidate).toEqual(new Uint8Array([7, 8, 9]));
  });

  it.each([
    { ...selection, reference: -0 },
    { ...selection, reference: 128 },
    { ...selection, mcp: "complete" },
    { ...selection, supersededRevocation: "pending" },
    { ...selection, recordId: "private" },
  ])("rejects non-closed rotation input before WASM initialization", async (invalid) => {
    const { port, send, closed } = await harness();
    send({ op: "inspectRotation", bytes: new Uint8Array([1]), selection: invalid });
    await closed;
    expect(wasm.init).not.toHaveBeenCalled();
    expect(wasm.inspectRotation).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "INVALID_ARCHIVE" });
  });

  it("sanitizes malformed checklist handles and still releases ownership", async () => {
    const { port, send, closed } = await harness();
    const handle = rotationHandle({
      readinessState: vi.fn(() => "terminal"),
    });
    wasm.inspectRotation.mockReturnValueOnce(handle);
    send({ op: "inspectRotation", bytes: new Uint8Array([1]), selection });
    await closed;
    expect(handle.lock).toHaveBeenCalledOnce();
    expect(handle.free).toHaveBeenCalledOnce();
    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, code: "INVALID_CATALOG" });
  });

  it.each(["AUTHENTICATION_FAILED", "PRIVATE_ROTATION_FAILURE"])(
    "sanitizes rotation failure %s and closes", async (error) => {
      const { port, send, closed } = await harness();
      wasm.cutover.mockImplementationOnce(() => { throw error; });
      send({ op: "createRotationCutover", bytes: new Uint8Array([1]), selection });
      await closed;
      expect(port.postMessage).toHaveBeenCalledWith({
        ok: false,
        code: error === "AUTHENTICATION_FAILED" ? error : "BRIDGE_FAILURE",
      });
      expect(port.close).toHaveBeenCalledOnce();
    },
  );
});
