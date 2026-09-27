import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserSyntheticVaultWorker, SYNTHETIC_ARCHIVE_MAX_BYTES,
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
  reference: 1,
  mcp: "user_confirmed",
  cli: "pending",
  ci: "provider_verified",
  supersededRevocation: "provider_verified",
} as const);

function checklist() {
  return {
    generation: "initial_0001",
    readinessState: "ready",
    entries: [{ fixture: "mcp", requiredForCutover: true }],
    remainingRequired: 0,
    remainingOptional: 0,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("BrowserSyntheticVaultWorker rotation boundary", () => {
  it("dispatches owned closed inputs and reconstructs a frozen checklist allowlist", async () => {
    const { client, workers } = setup();
    const bytes = new Uint8Array([1, 2]);
    const pending = client.inspectRotation(bytes, selection);
    const request = workers[0]!.postMessage.mock.calls[0]![0] as {
      op: string; bytes: Uint8Array; selection: typeof selection;
    };
    expect(request).toEqual({ op: "inspectRotation", bytes, selection });
    expect(request.bytes).not.toBe(bytes);
    expect(request.selection).not.toBe(selection);

    const input = checklist();
    workers[0]!.reply({ ok: true, kind: "rotationChecklist", checklist: input });
    const result = await pending;
    expect(result).toEqual(checklist());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.entries[0])).toBe(true);
    input.entries[0]!.fixture = "ci";
    expect(result.entries[0]!.fixture).toBe("mcp");
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("dispatches the exact reviewed selection and returns only copied candidate bytes", async () => {
    const { client, workers } = setup();
    const bytes = new Uint8Array([1, 2]);
    const pending = client.createRotationCutover(bytes, selection);
    const request = workers[0]!.postMessage.mock.calls[0]![0] as {
      op: string; bytes: Uint8Array; selection: typeof selection;
    };
    expect(request).toEqual({ op: "createRotationCutover", bytes, selection });
    expect(request.bytes).not.toBe(bytes);
    expect(request.selection).not.toBe(selection);
    const candidate = new Uint8Array([3, 4]);
    workers[0]!.reply({ ok: true, kind: "archive", bytes: candidate, checklist: checklist() });
    const result = await pending;
    expect(result).toEqual(candidate);
    expect(result).not.toBe(candidate);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    { ...selection, reference: -0 },
    { ...selection, reference: 128 },
    { ...selection, cli: "complete" },
    { ...selection, supersededRevocation: "pending" },
    { ...selection, revisionId: "private" },
  ])("rejects invalid selection before worker creation", async (invalid) => {
    const { client, factory } = setup();
    await expect(client.inspectRotation(new Uint8Array([1]), invalid as never))
      .rejects.toHaveProperty("code", "INVALID_ARCHIVE");
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    { ...checklist(), generation: "future" },
    { ...checklist(), readinessState: "terminal" },
    { ...checklist(), remainingRequired: 1 },
    { ...checklist(), remainingOptional: 1 },
    { ...checklist(), entries: [{ fixture: "mcp", requiredForCutover: true }, { fixture: "mcp", requiredForCutover: false }] },
    { ...checklist(), entries: new Array(1) },
    { ...checklist(), secretValue: "PRIVATE_MUST_NOT_REACH_UI" },
    { ...checklist(), recordId: "PRIVATE_ID" },
  ])("rejects malformed checklist without publishing a partial value", async (invalid) => {
    const { client, workers } = setup();
    const pending = client.inspectRotation(new Uint8Array([1]), selection);
    workers[0]!.reply({ ok: true, kind: "rotationChecklist", checklist: invalid });
    await expect(pending).rejects.toHaveProperty("code");
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("rejects wrong response kinds for both rotation operations", async () => {
    const first = setup();
    const inspection = first.client.inspectRotation(new Uint8Array([1]), selection);
    first.workers[0]!.reply({ ok: true, kind: "archive", bytes: new Uint8Array([1]) });
    await expect(inspection).rejects.toHaveProperty("code", "BRIDGE_FAILURE");

    const second = setup();
    const cutover = second.client.createRotationCutover(new Uint8Array([1]), selection);
    second.workers[0]!.reply({ ok: true, kind: "rotationChecklist", checklist: checklist() });
    await expect(cutover).rejects.toHaveProperty("code", "BRIDGE_FAILURE");
  });

  it("rejects invalid archive input and cancellation prevents a late checklist", async () => {
    const invalid = setup();
    await expect(invalid.client.inspectRotation(
      new Uint8Array(SYNTHETIC_ARCHIVE_MAX_BYTES + 1), selection,
    )).rejects.toHaveProperty("code", "LIMITS_EXCEEDED");
    expect(invalid.factory).not.toHaveBeenCalled();

    const { client, workers } = setup();
    const pending = client.inspectRotation(new Uint8Array([1]), selection);
    const rejected = expect(pending).rejects.toHaveProperty("code", "CANCELLED");
    const late = workers[0]!.onmessage!;
    client.cancel();
    late({ data: { ok: true, kind: "rotationChecklist", checklist: checklist() } } as MessageEvent<unknown>);
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("sanitizes a synchronous transport failure and clears the worker handlers", async () => {
    const worker = new FakeWorker();
    worker.postMessage.mockImplementationOnce(() => { throw new Error("PRIVATE_TRANSPORT_DETAIL"); });
    const client = new BrowserSyntheticVaultWorker(() => worker);
    await expect(client.inspectRotation(new Uint8Array([1]), selection)).rejects.toMatchObject({
      code: "BRIDGE_FAILURE",
      message: "BRIDGE_FAILURE",
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
  });
});
