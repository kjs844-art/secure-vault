import { describe, expect, it, vi } from "vitest";
import type { CatalogCredentialTypeV1, LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import { SyntheticVaultSession } from "./SyntheticVaultSession";

function fixture(kind: CatalogCredentialTypeV1 = "password") {
  const row = (reference: number, credentialType: CatalogCredentialTypeV1): LocalCatalogEntryV1 => ({
    reference, credentialType, itemName: "Example item", providerName: "Example service",
    issuerAccountIdentifier: null, issuerOrganizationOrWorkspace: null, issuerProject: null,
    issuerEnvironment: null, status: "active", connectionCount: 0, secretFieldCount: 1,
    mcpConnectionCount: 0, connections: [],
  });
  const bytes = new Uint8Array([1, 2]);
  const store = {
    read: vi.fn(async () => bytes.slice()),
    createIfAbsent: vi.fn(async () => "exists" as const),
    compareAndSwapArchive: vi.fn(async () => "updated" as const),
    compareAndSwapArchivePreservingConflict: vi.fn(async () => ({ kind: "updated" as const })),
    preserveConflictArchiveIfCurrentDiffers: vi.fn(async () => ({ kind: "already-current" as const })),
  };
  const worker = {
    create: vi.fn(async () => bytes.slice()), open: vi.fn(async () => [row(0, kind), row(1, "api_key")]),
    cancel: vi.fn(), editConnections: vi.fn(async () => bytes.slice()),
    inspectRotation: vi.fn(async (): Promise<never> => { throw new Error("unexpected inspection"); }),
    createRotationCutover: vi.fn(async () => bytes.slice()),
    inspectRotationStage: vi.fn(async (_input: Uint8Array, _reference: number) => null), saveRotationStage: vi.fn(async () => bytes.slice()),
    createRotationCutoverFromStage: vi.fn(async () => bytes.slice()),
  };
  const session = new SyntheticVaultSession(store, worker);
  return { session, store, worker, bytes };
}

describe("credential-specific session capabilities", () => {
  it.each(["password", "token", "custom"] as const)("rejects connection edits on %s before worker/write", async (kind) => {
    const { session, worker, store, bytes } = fixture(kind);
    await session.open();
    await session.editConnections(session.viewGeneration, { reference: 0, connectionIds: [] });
    expect(session.state.phase).toBe("error");
    expect(session.state.errorCode).toBe("INVALID_ARCHIVE");
    expect(worker.editConnections).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchivePreservingConflict).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    expect(bytes).toEqual(new Uint8Array([1, 2]));
  });
  it.each([0, 2])("does not inspect/save a Password or missing reference %i", async (reference) => {
    const { session, worker, store } = fixture();
    await session.open();
    const generation = session.viewGeneration;
    const before = session.state;
    expect(await session.inspectRotationStage(generation, reference)).toBeNull();
    await session.saveRotationStage(generation, {
      reference, mcp: "pending", cli: "pending", ci: "pending", supersededRevocation: "pending",
    });
    expect(session.state).toBe(before);
    expect(session.viewGeneration).toBe(generation);
    expect(worker.inspectRotationStage).not.toHaveBeenCalled();
    expect(worker.saveRotationStage).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchivePreservingConflict).not.toHaveBeenCalled();
  });
  it("does not grant one-shot cutover review to Password", async () => {
    const { session, worker, store } = fixture();
    await session.open();
    const generation = session.viewGeneration;
    expect(await session.inspectRotation(generation, {
      reference: 0, mcp: "pending", cli: "pending", ci: "pending", supersededRevocation: "user_confirmed",
    })).toBeNull();
    expect(session.rotationReviewState.phase).toBe("error");
    expect(session.rotationReviewState.errorCode).toBe("INVALID_ARCHIVE");
    await session.commitRotationCutover(generation, session.rotationReviewState.reviewVersion);
    expect(worker.inspectRotation).not.toHaveBeenCalled();
    expect(worker.createRotationCutover).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchivePreservingConflict).not.toHaveBeenCalled();
    expect(session.state.phase).toBe("open");
  });
  it("uses the real API reference rather than its filtered-list index", async () => {
    const { session, worker } = fixture();
    let inspected: Uint8Array | undefined;
    worker.inspectRotationStage.mockImplementationOnce(async (bytes) => { inspected = bytes.slice(); return null; });
    await session.open();
    const receipt = await session.inspectRotationStage(session.viewGeneration, 1);
    expect(receipt?.reference).toBe(1);
    expect(inspected).toEqual(new Uint8Array([1, 2]));
    expect(worker.inspectRotationStage.mock.calls[0]?.[1]).toBe(1);
    // The session wipes its disposable Worker input after the call.
    expect(worker.inspectRotationStage.mock.calls[0]?.[0]).toEqual(new Uint8Array([0, 0]));
  });
});
