import { describe, expect, it, vi } from "vitest";

import { CatalogAdapterError, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { LocalRotationChecklistV1 } from "../../bridge/rotationProtocol";
import type {
  SyntheticConflictCiphertextStore,
  SyntheticMutableCiphertextStore,
} from "../../storage/SyntheticCiphertextStore";
import { SyntheticStorageError } from "../../storage/SyntheticCiphertextStore";
import {
  SyntheticVaultSession,
  type SyntheticRotationWorker,
} from "./SyntheticVaultSession";

const original = new Uint8Array([1, 2]);
const candidate = new Uint8Array([1, 2, 3]);
const racer = new Uint8Array([1, 2, 4]);
const conflictId = "0".repeat(31) + "1";

function selection() {
  return {
    reference: 1,
    mcp: "user_confirmed",
    cli: "pending",
    ci: "provider_verified",
    supersededRevocation: "provider_verified",
  } as const;
}

function checklist(overrides: Partial<LocalRotationChecklistV1> = {}): LocalRotationChecklistV1 {
  return {
    generation: "initial_0001",
    readinessState: "ready",
    entries: [{ fixture: "mcp", requiredForCutover: true }],
    remainingRequired: 0,
    remainingOptional: 0,
    ...overrides,
  };
}

function rows(name: string): readonly LocalCatalogEntryV1[] {
  return [0, 1].map((reference): LocalCatalogEntryV1 => ({
    reference,
    itemName: name,
    providerName: "Example",
    issuerAccountIdentifier: "demo-account",
    issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project",
    issuerEnvironment: "demo",
    credentialType: "api_key",
    status: "active",
    connectionCount: 0,
    secretFieldCount: 1,
    mcpConnectionCount: 0,
    connections: [],
  }));
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function fixture() {
  let saved: Uint8Array | null = original.slice();
  const read = vi.fn<SyntheticMutableCiphertextStore["read"]>(
    async () => saved === null ? null : saved.slice(),
  );
  const createIfAbsent = vi.fn<SyntheticMutableCiphertextStore["createIfAbsent"]>(async (bytes) => {
    if (saved !== null) return "exists";
    saved = bytes.slice();
    return "created";
  });
  const compareAndSwapArchive = vi.fn<SyntheticMutableCiphertextStore["compareAndSwapArchive"]>(
    async (before, next) => {
      if (saved === null) return "missing";
      if (!same(before, saved)) return "conflict";
      saved = next.slice();
      return "updated";
    },
  );
  const preservingCas = vi.fn<SyntheticConflictCiphertextStore["compareAndSwapArchivePreservingConflict"]>(
    async (before, next) => {
      if (saved === null) return { kind: "missing" };
      if (!same(before, saved)) return { kind: "conflict-preserved", conflictId };
      saved = next.slice();
      return { kind: "updated" };
    },
  );
  const preserveAfterReadback = vi.fn<SyntheticConflictCiphertextStore["preserveConflictArchiveIfCurrentDiffers"]>(
    async (next) => {
      if (saved === null) return { kind: "missing" };
      return same(next, saved)
        ? { kind: "already-current" }
        : { kind: "conflict-preserved", conflictId };
    },
  );
  const listConflictArchives = vi.fn<SyntheticConflictCiphertextStore["listConflictArchives"]>(
    async () => [{ conflictId, bytes: racer.slice() }],
  );
  const deleteConflictArchiveIfEqual = vi.fn<SyntheticConflictCiphertextStore["deleteConflictArchiveIfEqual"]>(
    async () => "deleted",
  );
  const store = {
    read,
    createIfAbsent,
    compareAndSwapArchive,
    compareAndSwapArchivePreservingConflict: preservingCas,
    preserveConflictArchiveIfCurrentDiffers: preserveAfterReadback,
    listConflictArchives,
    deleteConflictArchiveIfEqual,
  };
  const worker = {
    create: vi.fn<SyntheticRotationWorker["create"]>().mockResolvedValue(original.slice()),
    open: vi.fn<SyntheticRotationWorker["open"]>(
      async (bytes) => rows(bytes.length === original.length ? "original" : "rotated"),
    ),
    inspectRotation: vi.fn<SyntheticRotationWorker["inspectRotation"]>().mockResolvedValue(checklist()),
    createRotationCutover: vi.fn<SyntheticRotationWorker["createRotationCutover"]>()
      .mockResolvedValue(candidate.slice()),
    cancel: vi.fn(),
  };
  return {
    store,
    worker,
    session: new SyntheticVaultSession(store, worker),
    saved: () => saved,
    replace: (bytes: Uint8Array | null) => { saved = bytes === null ? null : bytes.slice(); },
    preservingCas,
    preserveAfterReadback,
  };
}

async function ready(f: ReturnType<typeof fixture>) {
  await f.session.open();
  const vaultGeneration = f.session.viewGeneration;
  await f.session.inspectRotation(vaultGeneration, selection());
  expect(f.session.rotationReviewState.phase).toBe("ready");
  return {
    vaultGeneration,
    reviewVersion: f.session.rotationReviewState.reviewVersion,
  };
}

describe("snapshot-bound synthetic rotation session", () => {
  it("publishes only a frozen checklist bound to copied archive and selection snapshots", async () => {
    const f = fixture();
    await f.session.open();
    const generation = f.session.viewGeneration;
    const input = { ...selection(), reference: 1 as number };
    let inspectedSnapshot: Uint8Array | undefined;
    f.worker.inspectRotation.mockImplementationOnce(async (bytes) => {
      inspectedSnapshot = bytes.slice();
      return checklist();
    });
    const receipt = await f.session.inspectRotation(generation, input);

    const state = f.session.rotationReviewState;
    expect(state).toEqual({
      phase: "ready",
      reviewVersion: 2,
      checklist: checklist(),
      errorCode: null,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.checklist)).toBe(true);
    expect(Object.isFrozen(state.checklist?.entries)).toBe(true);
    expect(receipt).toEqual({ reviewVersion: 2, selection: selection() });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt?.selection)).toBe(true);
    const [bytes, parsed] = f.worker.inspectRotation.mock.calls[0]!;
    expect(inspectedSnapshot).toEqual(original);
    expect(bytes).toEqual(new Uint8Array(original.length));
    expect(bytes).not.toBe(f.saved());
    expect(parsed).toEqual(selection());
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    input.reference = 0;
    expect(parsed.reference).toBe(1);
    expect(receipt?.selection.reference).toBe(1);
  });

  it("returns no receipt when a loading notification re-enters with another review", async () => {
    const f = fixture();
    await f.session.open();
    const generation = f.session.viewGeneration;
    const secondSelection = Object.freeze({ ...selection(), reference: 0 });
    let started = false;
    let second: ReturnType<typeof f.session.inspectRotation> | undefined;
    const unsubscribe = f.session.subscribe(() => {
      if (!started && f.session.rotationReviewState.phase === "loading") {
        started = true;
        second = f.session.inspectRotation(generation, secondSelection);
      }
    });

    const firstReceipt = await f.session.inspectRotation(generation, selection());
    const secondReceipt = await second;
    unsubscribe();

    expect(firstReceipt).toBeNull();
    expect(secondReceipt).toEqual({ reviewVersion: 3, selection: secondSelection });
    expect(f.session.rotationReviewState).toMatchObject({ phase: "ready", reviewVersion: 3 });
    expect(f.worker.inspectRotation).toHaveBeenCalledOnce();
    expect(f.worker.inspectRotation.mock.calls[0]![1]).toEqual(secondSelection);
  });

  it("returns no receipt when a ready notification is replaced re-entrantly", async () => {
    const f = fixture();
    await f.session.open();
    const generation = f.session.viewGeneration;
    const secondSelection = Object.freeze({ ...selection(), reference: 0 });
    let started = false;
    let second: ReturnType<typeof f.session.inspectRotation> | undefined;
    const unsubscribe = f.session.subscribe(() => {
      if (!started && f.session.rotationReviewState.phase === "ready") {
        started = true;
        second = f.session.inspectRotation(generation, secondSelection);
      }
    });

    const firstReceipt = await f.session.inspectRotation(generation, selection());
    const secondReceipt = await second;
    unsubscribe();

    expect(firstReceipt).toBeNull();
    expect(secondReceipt).toEqual({ reviewVersion: 3, selection: secondSelection });
    expect(f.session.rotationReviewState).toMatchObject({ phase: "ready", reviewVersion: 3 });
    expect(f.worker.inspectRotation).toHaveBeenCalledTimes(2);
    expect(f.worker.inspectRotation.mock.calls[1]![1]).toEqual(secondSelection);
  });

  it("is a true no-op while locked or for a stale vault generation", async () => {
    const f = fixture();
    const trap = vi.fn(() => { throw new Error("PRIVATE_TRAP"); });
    const hostile = new Proxy({}, { getPrototypeOf: trap });
    await f.session.inspectRotation(0, hostile);
    expect(trap).not.toHaveBeenCalled();
    expect(f.worker.cancel).not.toHaveBeenCalled();
    expect(f.worker.inspectRotation).not.toHaveBeenCalled();

    await f.session.open();
    const stale = f.session.viewGeneration - 1;
    const prior = f.session.rotationReviewState;
    await f.session.inspectRotation(stale, hostile);
    expect(f.session.rotationReviewState).toBe(prior);
    expect(trap).not.toHaveBeenCalled();
    expect(f.worker.inspectRotation).not.toHaveBeenCalled();
  });

  it("rejects malformed injected checklist data without retaining a reviewed selection", async () => {
    const f = fixture();
    await f.session.open();
    f.worker.inspectRotation.mockResolvedValueOnce({
      ...checklist(),
      recordId: "PRIVATE_ID",
    } as never);
    await f.session.inspectRotation(f.session.viewGeneration, selection());
    expect(f.session.state.phase).toBe("open");
    expect(f.session.rotationReviewState).toEqual({
      phase: "error",
      reviewVersion: 2,
      checklist: null,
      errorCode: "INVALID_CATALOG",
    });
    await f.session.commitRotationCutover(
      f.session.viewGeneration,
      f.session.rotationReviewState.reviewVersion,
    );
    expect(f.worker.createRotationCutover).not.toHaveBeenCalled();
    expect(f.preservingCas).not.toHaveBeenCalled();
  });

  it.each([
    checklist({ readinessState: "required_pending", remainingRequired: 1 }),
    checklist({
      generation: "terminal_0003",
      readinessState: "terminal",
      remainingRequired: 0,
      remainingOptional: 0,
    }),
  ])("does not cut over a non-ready checklist %#", async (reviewedChecklist) => {
    const f = fixture();
    await f.session.open();
    f.worker.inspectRotation.mockResolvedValueOnce(reviewedChecklist);
    await f.session.inspectRotation(f.session.viewGeneration, selection());
    const state = f.session.rotationReviewState;
    expect(state.phase).toBe("ready");
    await f.session.commitRotationCutover(f.session.viewGeneration, state.reviewVersion);
    expect(f.session.state.phase).toBe("open");
    expect(f.worker.createRotationCutover).not.toHaveBeenCalled();
    expect(f.preservingCas).not.toHaveBeenCalled();
  });

  it("requires the current review version and never reuses an older decision", async () => {
    const f = fixture();
    const first = await ready(f);
    await f.session.inspectRotation(first.vaultGeneration, selection());
    const current = f.session.rotationReviewState.reviewVersion;
    expect(current).toBeGreaterThan(first.reviewVersion);
    await f.session.commitRotationCutover(first.vaultGeneration, first.reviewVersion);
    expect(f.worker.createRotationCutover).not.toHaveBeenCalled();
    await f.session.commitRotationCutover(first.vaultGeneration, current);
    expect(f.worker.createRotationCutover).toHaveBeenCalledOnce();
  });

  it("requires the current vault generation even with the current review version", async () => {
    const f = fixture();
    const token = await ready(f);
    const state = f.session.state;
    const review = f.session.rotationReviewState;
    await f.session.commitRotationCutover(token.vaultGeneration - 1, token.reviewVersion);
    expect(f.session.state).toBe(state);
    expect(f.session.rotationReviewState).toBe(review);
    expect(f.worker.createRotationCutover).not.toHaveBeenCalled();
    expect(f.preservingCas).not.toHaveBeenCalled();
  });

  it("authenticates before CAS and publishes only the exact reread after reauthentication", async () => {
    const f = fixture();
    const token = await ready(f);
    const events: string[] = [];
    f.worker.createRotationCutover.mockImplementationOnce(async (bytes, parsed) => {
      events.push("candidate");
      expect(bytes).toEqual(original);
      expect(parsed).toEqual(selection());
      return candidate.slice();
    });
    f.worker.open.mockReset().mockImplementation(async (bytes) => {
      events.push("authenticate");
      expect(bytes).toEqual(candidate);
      return rows("rotated");
    });
    f.preservingCas.mockImplementationOnce(async (before, next) => {
      events.push("cas");
      expect(before).toEqual(original);
      expect(next).toEqual(candidate);
      f.replace(next);
      return { kind: "updated" };
    });
    f.store.read.mockImplementationOnce(async () => {
      events.push("readback");
      return candidate.slice();
    });

    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(events).toEqual(["candidate", "authenticate", "cas", "readback", "authenticate"]);
    expect(f.session.state).toEqual({ phase: "open", entries: rows("rotated"), errorCode: null });
    expect(f.session.rotationReviewState.phase).toBe("idle");
    expect(f.preservingCas).toHaveBeenCalledOnce();
    expect(f.preserveAfterReadback).not.toHaveBeenCalled();
  });

  it("keeps an owned candidate when worker output and CAS arguments are mutated", async () => {
    const f = fixture();
    const token = await ready(f);
    f.worker.open.mockClear();
    const rawWorkerOutput = candidate.slice();
    const expectedCandidate = candidate.slice();
    let casExpected: Uint8Array | undefined;
    let casCandidate: Uint8Array | undefined;
    f.worker.createRotationCutover.mockResolvedValueOnce(rawWorkerOutput);
    f.preservingCas.mockImplementationOnce(async (before, next) => {
      casExpected = before;
      casCandidate = next;
      expect(before).toEqual(original);
      expect(next).toEqual(expectedCandidate);
      f.replace(next);
      rawWorkerOutput.fill(0xa5);
      before.fill(0x4a);
      next.fill(0x5a);
      return { kind: "updated" };
    });

    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);

    expect(f.session.state).toEqual({ phase: "open", entries: rows("rotated"), errorCode: null });
    expect(f.saved()).toEqual(expectedCandidate);
    expect(casExpected).toEqual(new Uint8Array(original.length));
    expect(casCandidate).toEqual(new Uint8Array(expectedCandidate.length));
    expect(f.worker.open.mock.calls).toHaveLength(2);
    for (const [authenticationInput] of f.worker.open.mock.calls) {
      expect(authenticationInput).toEqual(new Uint8Array(expectedCandidate.length));
    }
    expect(f.preserveAfterReadback).not.toHaveBeenCalled();
  });

  it("never writes a candidate that fails complete pre-authentication", async () => {
    const f = fixture();
    const token = await ready(f);
    f.worker.open.mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(f.session.state).toEqual({ phase: "error", entries: [], errorCode: "AUTHENTICATION_FAILED" });
    expect(f.preservingCas).not.toHaveBeenCalled();
    expect(f.saved()).toEqual(original);
  });

  it("rejects a byte-identical no-op candidate before authentication or storage", async () => {
    const f = fixture();
    const token = await ready(f);
    f.worker.open.mockClear();
    f.worker.createRotationCutover.mockResolvedValueOnce(original.slice());
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(f.session.state).toEqual({ phase: "error", entries: [], errorCode: "INVALID_ARCHIVE" });
    expect(f.worker.open).not.toHaveBeenCalled();
    expect(f.preservingCas).not.toHaveBeenCalled();
    expect(f.saved()).toEqual(original);
  });

  it("requires atomic conflict preservation rather than falling back to plain CAS", async () => {
    const f = fixture();
    const store = {
      read: f.store.read,
      createIfAbsent: f.store.createIfAbsent,
      compareAndSwapArchive: f.store.compareAndSwapArchive,
    };
    const session = new SyntheticVaultSession(store, f.worker);
    await session.open();
    await session.inspectRotation(session.viewGeneration, selection());
    const version = session.rotationReviewState.reviewVersion;
    await session.commitRotationCutover(session.viewGeneration, version);
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "ROTATION_UNAVAILABLE" });
    expect(f.worker.createRotationCutover).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
  });

  it("reports an atomically preserved CAS loser without retrying or rereading", async () => {
    const f = fixture();
    const token = await ready(f);
    f.store.read.mockClear();
    f.preservingCas.mockResolvedValueOnce({ kind: "conflict-preserved", conflictId });
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(f.session.state).toEqual({
      phase: "error",
      entries: [],
      errorCode: "STORAGE_CONFLICT_PRESERVED",
    });
    expect(f.preservingCas).toHaveBeenCalledOnce();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.preserveAfterReadback).not.toHaveBeenCalled();
    expect(f.worker.createRotationCutover).toHaveBeenCalledOnce();
  });

  it("preserves a candidate displaced after CAS and never reports ambiguous success", async () => {
    const f = fixture();
    const token = await ready(f);
    f.preservingCas.mockImplementationOnce(async () => {
      f.replace(racer);
      return { kind: "updated" };
    });
    let preservedSnapshot: Uint8Array | undefined;
    f.preserveAfterReadback.mockImplementationOnce(async (bytes) => {
      preservedSnapshot = bytes.slice();
      return { kind: "conflict-preserved", conflictId };
    });
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(f.preserveAfterReadback).toHaveBeenCalledOnce();
    expect(preservedSnapshot).toEqual(candidate);
    expect(f.preserveAfterReadback.mock.calls[0]![0]).toEqual(new Uint8Array(candidate.length));
    expect(f.session.state).toEqual({
      phase: "error",
      entries: [],
      errorCode: "STORAGE_CONFLICT_PRESERVED",
    });
    expect(f.saved()).toEqual(racer);
    expect(f.worker.open).toHaveBeenCalledTimes(2);
  });

  it("does not publish a byte-equal readback until its second authentication succeeds", async () => {
    const f = fixture();
    const token = await ready(f);
    f.worker.open.mockReset()
      .mockResolvedValueOnce(rows("pre-auth"))
      .mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(f.preservingCas).toHaveBeenCalledOnce();
    expect(f.session.state).toEqual({ phase: "error", entries: [], errorCode: "AUTHENTICATION_FAILED" });
    expect(f.saved()).toEqual(candidate);
  });

  it("rejects malformed atomic results without a readback or retry", async () => {
    const f = fixture();
    const token = await ready(f);
    f.store.read.mockClear();
    f.preservingCas.mockResolvedValueOnce({ kind: "updated", extra: true } as never);
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(f.session.state).toEqual({ phase: "error", entries: [], errorCode: "OPERATION_FAILED" });
    expect(f.preservingCas).toHaveBeenCalledOnce();
    expect(f.store.read).not.toHaveBeenCalled();
  });

  it("surfaces a bounded outbox failure while preserving the ambiguous canonical state", async () => {
    const f = fixture();
    const token = await ready(f);
    f.store.read.mockResolvedValueOnce(racer.slice());
    f.preserveAfterReadback.mockRejectedValueOnce(new SyntheticStorageError("outbox-full"));
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(f.session.state).toEqual({ phase: "error", entries: [], errorCode: "outbox-full" });
    expect(f.preservingCas).toHaveBeenCalledOnce();
    expect(f.preserveAfterReadback).toHaveBeenCalledOnce();
  });

  it("does not preserve or reauthenticate after a hostile readback comparison locks the session", async () => {
    const f = fixture();
    const token = await ready(f);
    f.worker.open.mockClear();
    const trap = vi.fn(() => {
      f.session.lock();
      return Uint8Array.prototype;
    });
    const hostileReadback = new Proxy(candidate.slice(), { getPrototypeOf: trap });
    f.store.read.mockResolvedValueOnce(hostileReadback);

    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);

    expect(trap).toHaveBeenCalled();
    expect(f.session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    expect(f.preserveAfterReadback).not.toHaveBeenCalled();
    expect(f.worker.open).toHaveBeenCalledOnce();
  });

  it("rechecks generation after re-entrant capability getters before starting new work", async () => {
    const f = fixture();
    const token = await ready(f);
    const start = vi.fn(async () => candidate.slice());
    Object.defineProperty(f.worker, "createRotationCutover", {
      configurable: true,
      get() {
        f.session.lock();
        return start;
      },
    });
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(f.session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    expect(start).not.toHaveBeenCalled();
    expect(f.preservingCas).not.toHaveBeenCalled();
  });

  it("rechecks rotation review freshness after a re-entrant inspect getter", async () => {
    const f = fixture();
    await f.session.open();
    const inspect = vi.fn(async () => checklist());
    Object.defineProperty(f.worker, "inspectRotation", {
      configurable: true,
      get() {
        f.session.lock();
        return inspect;
      },
    });

    await f.session.inspectRotation(f.session.viewGeneration, selection());

    expect(f.session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    expect(f.session.rotationReviewState.phase).toBe("idle");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("zeroizes a late worker candidate returned after lock", async () => {
    const f = fixture();
    const token = await ready(f);
    const gate = deferred<Uint8Array>();
    f.worker.createRotationCutover.mockReturnValueOnce(gate.promise);
    const pending = f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    await flush();
    f.session.lock();
    const lateCandidate = candidate.slice();
    gate.resolve(lateCandidate);
    await pending;
    expect(Array.from(lateCandidate)).toEqual([0, 0, 0]);
    expect(f.session.state.phase).toBe("locked");
  });

  it("zeroizes a late readback returned after lock", async () => {
    const f = fixture();
    const token = await ready(f);
    const gate = deferred<Uint8Array | null>();
    f.store.read.mockReturnValueOnce(gate.promise);
    const pending = f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    await flush();
    expect(f.preservingCas).toHaveBeenCalledOnce();
    f.session.lock();
    const lateReadback = candidate.slice();
    gate.resolve(lateReadback);
    await pending;
    expect(Array.from(lateReadback)).toEqual([0, 0, 0]);
    expect(f.session.state.phase).toBe("locked");
  });

  it("uses native cleanup without invoking a worker result's own fill accessor", async () => {
    const f = fixture();
    const token = await ready(f);
    const rawWorkerOutput = candidate.slice();
    const ownFill = vi.fn(() => { throw new Error("OWN_FILL_CALLED"); });
    Object.defineProperty(rawWorkerOutput, "fill", { configurable: true, get: ownFill });
    f.worker.createRotationCutover.mockResolvedValueOnce(rawWorkerOutput);

    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);

    expect(f.session.state.phase).toBe("open");
    expect(ownFill).not.toHaveBeenCalled();
    expect(Array.from(rawWorkerOutput)).toEqual([0, 0, 0]);
  });

  it("a busy subscriber lock prevents capability lookup and cutover work", async () => {
    const f = fixture();
    const token = await ready(f);
    const unsubscribe = f.session.subscribe(() => {
      if (f.session.state.phase === "busy") f.session.lock();
    });
    await f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    unsubscribe();
    expect(f.session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    expect(f.worker.createRotationCutover).not.toHaveBeenCalled();
    expect(f.preservingCas).not.toHaveBeenCalled();
  });

  it.each(["candidate", "pre-auth", "cas", "readback", "preserve", "re-auth"] as const)(
    "a lock during %s discards every late continuation",
    async (stage) => {
      const f = fixture();
      const token = await ready(f);
      const gate = deferred<unknown>();
      f.store.read.mockClear();
      f.worker.open.mockReset().mockResolvedValue(rows("authenticated"));
      if (stage === "candidate") {
        f.worker.createRotationCutover.mockReturnValueOnce(gate.promise as Promise<Uint8Array>);
      } else if (stage === "pre-auth") {
        f.worker.open.mockReturnValueOnce(gate.promise as Promise<readonly LocalCatalogEntryV1[]>);
      } else if (stage === "cas") {
        f.preservingCas.mockReturnValueOnce(
          gate.promise as ReturnType<typeof f.preservingCas>,
        );
      } else if (stage === "readback") {
        f.store.read.mockReturnValueOnce(gate.promise as Promise<Uint8Array | null>);
      } else if (stage === "preserve") {
        f.store.read.mockResolvedValueOnce(racer.slice());
        f.preserveAfterReadback.mockReturnValueOnce(
          gate.promise as ReturnType<typeof f.preserveAfterReadback>,
        );
      } else {
        f.worker.open
          .mockResolvedValueOnce(rows("pre-auth"))
          .mockReturnValueOnce(gate.promise as Promise<readonly LocalCatalogEntryV1[]>);
      }

      const pending = f.session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
      await flush();
      expect(f.session.state.phase).toBe("busy");
      f.session.lock();
      if (stage === "candidate") gate.resolve(candidate.slice());
      else if (stage === "pre-auth" || stage === "re-auth") gate.resolve(rows("late"));
      else if (stage === "cas") gate.resolve({ kind: "updated" });
      else if (stage === "preserve") gate.resolve({ kind: "conflict-preserved", conflictId });
      else gate.resolve(candidate.slice());
      await pending;
      expect(f.session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
      expect(f.session.rotationReviewState.phase).toBe("idle");
    },
  );

  it("a lock during checklist inspection prevents a late ready state", async () => {
    const f = fixture();
    await f.session.open();
    const gate = deferred<LocalRotationChecklistV1>();
    f.worker.inspectRotation.mockReturnValueOnce(gate.promise);
    const pending = f.session.inspectRotation(f.session.viewGeneration, selection());
    expect(f.session.rotationReviewState.phase).toBe("loading");
    f.session.lock();
    gate.resolve(checklist());
    await pending;
    expect(f.session.state.phase).toBe("locked");
    expect(f.session.rotationReviewState.phase).toBe("idle");
  });

  it("rotation and conflict reviews mutually invalidate because they share one Worker", async () => {
    const f = fixture();
    await f.session.open();
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.session.conflictReviewState.phase).toBe("ready");
    await f.session.inspectRotation(f.session.viewGeneration, selection());
    expect(f.session.conflictReviewState.phase).toBe("idle");
    expect(f.session.rotationReviewState.phase).toBe("ready");
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.session.conflictReviewState.phase).toBe("ready");
    expect(f.session.rotationReviewState.phase).toBe("idle");
  });

  it("cannot start a rotation review or replacement conflict review during exact discard", async () => {
    const f = fixture();
    await f.session.open();
    await f.session.loadConflictReviews(f.session.viewGeneration);
    const version = f.session.conflictReviewState.reviewVersion;
    f.session.requestConflictDiscard(version, 0);
    const gate = deferred<"deleted" | "missing" | "changed">();
    f.store.deleteConflictArchiveIfEqual.mockReturnValueOnce(gate.promise);
    const pending = f.session.confirmConflictDiscard(version, 0);
    await flush();
    expect(f.session.conflictReviewState.phase).toBe("discarding");
    const inspectCalls = f.worker.inspectRotation.mock.calls.length;
    const listCalls = f.store.listConflictArchives.mock.calls.length;
    await f.session.inspectRotation(f.session.viewGeneration, selection());
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.worker.inspectRotation).toHaveBeenCalledTimes(inspectCalls);
    expect(f.store.listConflictArchives).toHaveBeenCalledTimes(listCalls);
    expect(f.session.conflictReviewState.phase).toBe("discarding");
    gate.resolve("deleted");
    await pending;
    expect(f.session.conflictReviewState.phase).toBe("discarded");
    expect(f.session.rotationReviewState.phase).toBe("idle");
  });
});
