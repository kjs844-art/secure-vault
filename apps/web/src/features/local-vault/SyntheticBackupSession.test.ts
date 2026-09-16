import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindVaultAutoLock, VAULT_IDLE_TIMEOUT_MS, type VaultAutoLockEnvironment } from "./bindVaultAutoLock";
import { SyntheticBackupError } from "./SyntheticVaultBackup";
import { SyntheticBackupSession, type SyntheticBackupSessionPort } from "./SyntheticBackupSession";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function file(size = 16): File {
  return { size, get name(): string { throw new Error("PRIVATE_FILENAME"); } } as File;
}

function fixture() {
  const backend = {
    exportArchive: vi.fn<() => Promise<Uint8Array>>().mockResolvedValue(new Uint8Array(16)),
    restoreArchive: vi.fn<(bytes: Uint8Array) => Promise<void>>().mockResolvedValue(undefined),
    cancel: vi.fn(),
  };
  let urls = 0;
  const port: SyntheticBackupSessionPort = {
    readFile: vi.fn().mockResolvedValue(new Uint8Array(16)),
    createObjectURL: vi.fn(() => `blob:synthetic-${++urls}`),
    revokeObjectURL: vi.fn(),
  };
  const session = new SyntheticBackupSession(backend, port);
  return { backend, port, session };
}

function expectLocked(session: SyntheticBackupSession) {
  expect(session.state).toMatchObject({ phase: "locked", acknowledged: false, fileSize: null, downloadUrl: null });
}

describe("synthetic backup UI session", () => {
  it("starts locked without browser APIs, file I/O, worker work, or mutable state", () => {
    const f = fixture();
    expectLocked(f.session);
    expect(Object.isFrozen(f.session.state)).toBe(true);
    expect(f.backend.cancel).not.toHaveBeenCalled();
    expect(f.port.readFile).not.toHaveBeenCalled();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
    vi.stubGlobal("URL", undefined);
    try { expectLocked(new SyntheticBackupSession(f.backend)); }
    finally { if (descriptor) Object.defineProperty(globalThis, "URL", descriptor); else vi.unstubAllGlobals(); }
  });

  it("requires explicit acknowledgment and a selected file for restore", async () => {
    const f = fixture();
    f.session.selectFile(file());
    await f.session.prepareExport(); await f.session.restore();
    expectLocked(f.session);
    expect(f.backend.exportArchive).not.toHaveBeenCalled();
    expect(f.port.readFile).not.toHaveBeenCalled();
    f.session.acknowledge(true); await f.session.restore();
    expect(f.backend.restoreArchive).not.toHaveBeenCalled();
  });

  it("selects without eager reads or filename access and restores only on request", async () => {
    const f = fixture(); const selected = file();
    f.session.acknowledge(true); f.session.selectFile(selected);
    expect(f.port.readFile).not.toHaveBeenCalled();
    expect(f.session.state.fileSize).toBe(16);
    expect(f.session.state.phase).toBe("open");
    await f.session.restore();
    expect(f.port.readFile).toHaveBeenCalledWith(selected);
    expect(f.backend.restoreArchive).toHaveBeenCalledTimes(1);
    expect(f.session.state.fileSize).toBeNull();
    expect(f.session.state.message).toContain("복원 완료");
    expect(f.session.state.phase).toBe("open");
    expect(Object.keys(f.session.state).sort()).toEqual(["acknowledged", "downloadUrl", "fileSize", "message", "phase"]);
  });

  it.each([0, 15, -1, 524289, Infinity, NaN, 16.5])("rejects invalid size %s before retention", async (size) => {
    const f = fixture(); f.session.acknowledge(true); f.session.selectFile(file(size));
    expect(f.session.state.fileSize).toBeNull();
    expect(f.session.state.phase).toBe("open");
    await f.session.restore();
    expect(f.port.readFile).not.toHaveBeenCalled();
    expect(f.backend.restoreArchive).not.toHaveBeenCalled();
  });

  it("accepts the exact maximum size and safely handles a thrown size accessor", () => {
    const f = fixture(); f.session.acknowledge(true); f.session.selectFile(file(524288));
    expect(f.session.state.fileSize).toBe(524288);
    f.session.selectFile({ get size(): number { throw new Error("PRIVATE_SIZE_ERROR"); } } as File);
    expect(f.session.state.fileSize).toBeNull();
    expect(f.session.state.message).not.toContain("PRIVATE");
  });

  it("prevents duplicate export or restore jobs while busy", async () => {
    const f = fixture(); const exporting = deferred<Uint8Array>();
    f.backend.exportArchive.mockReturnValue(exporting.promise); f.session.acknowledge(true);
    const pending = f.session.prepareExport();
    await f.session.prepareExport(); await f.session.restore();
    expect(f.backend.exportArchive).toHaveBeenCalledTimes(1);
    expect(f.session.state.phase).toBe("busy");
    exporting.resolve(new Uint8Array(16)); await pending;
    const reading = deferred<Uint8Array>(); vi.mocked(f.port.readFile).mockReturnValue(reading.promise);
    f.session.selectFile(file()); const restoring = f.session.restore();
    await f.session.restore(); await f.session.prepareExport();
    expect(f.port.readFile).toHaveBeenCalledTimes(1);
    expect(f.backend.exportArchive).toHaveBeenCalledTimes(1);
    reading.resolve(new Uint8Array(16)); await restoring;
  });

  it.each(["success", "failure"])("ignores stale export %s after lock", async (outcome) => {
    const f = fixture(); const work = deferred<Uint8Array>();
    f.backend.exportArchive.mockReturnValue(work.promise); f.session.acknowledge(true);
    const pending = f.session.prepareExport(); f.session.lock();
    if (outcome === "success") work.resolve(new Uint8Array(16)); else work.reject(new Error("PRIVATE_EXCEPTION"));
    await pending; expectLocked(f.session); expect(f.port.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("ignores stale file read %s and never starts restore", async (outcome) => {
    const f = fixture(); const work = deferred<Uint8Array>();
    vi.mocked(f.port.readFile).mockReturnValue(work.promise);
    f.session.acknowledge(true); f.session.selectFile(file()); const pending = f.session.restore();
    f.session.lock();
    if (outcome === "success") work.resolve(new Uint8Array(16)); else work.reject(new Error("PRIVATE_EXCEPTION"));
    await pending; expectLocked(f.session); expect(f.backend.restoreArchive).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("ignores stale backend restore %s after lock", async (outcome) => {
    const f = fixture(); const work = deferred<void>(); f.backend.restoreArchive.mockReturnValue(work.promise);
    f.session.acknowledge(true); f.session.selectFile(file()); const pending = f.session.restore();
    await Promise.resolve(); expect(f.backend.restoreArchive).toHaveBeenCalledTimes(1);
    f.session.lock();
    if (outcome === "success") work.resolve(undefined); else work.reject(new Error("PRIVATE_EXCEPTION"));
    await pending; expectLocked(f.session); expect(f.session.state.message).toContain("이미 시작된");
  });

  it("a new selection cancels an old read without clearing the replacement", async () => {
    const f = fixture(); const old = deferred<Uint8Array>(); vi.mocked(f.port.readFile).mockReturnValueOnce(old.promise);
    f.session.acknowledge(true); f.session.selectFile(file(16)); const pending = f.session.restore();
    f.session.selectFile(file(32)); old.resolve(new Uint8Array(16)); await pending;
    expect(f.session.state.fileSize).toBe(32); expect(f.backend.restoreArchive).not.toHaveBeenCalled();
    await f.session.restore(); expect(f.backend.restoreArchive).toHaveBeenCalledTimes(1);
  });

  it("unchecking cancels pending work and clears file selection and acknowledgment", async () => {
    const f = fixture(); const work = deferred<Uint8Array>(); f.backend.exportArchive.mockReturnValue(work.promise);
    f.session.acknowledge(true); const pending = f.session.prepareExport(); f.session.acknowledge(false);
    work.resolve(new Uint8Array(16)); await pending; expectLocked(f.session);
    await f.session.prepareExport(); expect(f.backend.exportArchive).toHaveBeenCalledTimes(1);
  });

  it("revokes every prepared URL on replacement, selection, unchecking and lock", async () => {
    const f = fixture(); f.session.acknowledge(true); await f.session.prepareExport();
    expect(f.session.state.downloadUrl).toBe("blob:synthetic-1");
    await f.session.prepareExport(); expect(f.port.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-1");
    f.session.selectFile(file()); expect(f.port.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-2");
    await f.session.prepareExport(); f.session.acknowledge(false);
    expect(f.port.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-3");
    f.session.acknowledge(true); await f.session.prepareExport(); f.session.lock(); f.session.lock();
    expect(f.port.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-4");
    expect(f.port.revokeObjectURL).toHaveBeenCalledTimes(4); expectLocked(f.session);
  });

  it("reports a requested download, never filesystem completion", async () => {
    const f = fixture(); f.session.acknowledge(true); const initial = f.session.state;
    f.session.markDownloadRequested(); expect(f.session.state).toBe(initial);
    await f.session.prepareExport(); expect(f.session.state.message).toContain("아직 디스크 저장을 확인한 것은 아닙니다");
    f.session.markDownloadRequested(); expect(f.session.state.message).toContain("브라우저 다운로드 목록에서");
    expect(f.session.state.message).toContain("자동으로 보증하지 않습니다");
  });

  it("cleanup exceptions cannot prevent state clearing or notification", async () => {
    const f = fixture(); f.session.acknowledge(true); await f.session.prepareExport();
    const notified = vi.fn(() => { expectLocked(f.session); }); f.session.subscribe(notified);
    f.backend.cancel.mockImplementation(() => { throw new Error("PRIVATE_CANCEL"); });
    vi.mocked(f.port.revokeObjectURL).mockImplementation(() => { throw new Error("PRIVATE_REVOKE"); });
    expect(() => f.session.lock()).not.toThrow(); expectLocked(f.session);
    expect(notified).toHaveBeenCalledOnce(); expect(f.session.state.message).not.toContain("PRIVATE");
  });

  it.each([new Error("PRIVATE_RAW_EXCEPTION"), new Proxy({}, { getPrototypeOf() { throw new Error("PRIVATE_PROXY"); } })])(
    "renders a fixed error for untrusted exceptions", async (error) => {
      const f = fixture(); f.backend.exportArchive.mockRejectedValue(error); f.session.acknowledge(true);
      await f.session.prepareExport(); expect(f.session.state.phase).toBe("open");
      expect(f.session.state.message).toBe("작업에 실패했습니다. 원본 파일과 기존 금고를 자동으로 수정하지 않았습니다.");
    },
  );

  it("maps known errors without rendering their changed message", async () => {
    const f = fixture(); const error = new SyntheticBackupError("EXISTS"); error.message = "PRIVATE_EXCEPTION";
    f.backend.restoreArchive.mockRejectedValue(error); f.session.acknowledge(true); f.session.selectFile(file());
    await f.session.restore(); expect(f.session.state.message).toContain("기존 금고는 그대로 보존");
    expect(f.session.state.message).not.toContain("PRIVATE");
  });

  it("does not create a download URL when unresolved conflicts block export", async () => {
    const f = fixture();
    f.backend.exportArchive.mockRejectedValue(new SyntheticBackupError("UNRESOLVED_CONFLICTS"));
    f.session.acknowledge(true);
    await f.session.prepareExport();
    expect(f.session.state.downloadUrl).toBeNull();
    expect(f.session.state.message).toContain("충돌 암호문");
    expect(f.port.createObjectURL).not.toHaveBeenCalled();
  });

  it("a reentrant error-code getter cannot reopen a locked session", async () => {
    const f = fixture(); const error = new SyntheticBackupError("EXISTS");
    Object.defineProperty(error, "code", { get() { f.session.lock(); return "EXISTS"; } });
    f.backend.exportArchive.mockRejectedValue(error); f.session.acknowledge(true);
    await f.session.prepareExport(); expectLocked(f.session);
  });

  it("stale export failure cannot erase a newer prepared download", async () => {
    const f = fixture(); const old = deferred<Uint8Array>(); f.backend.exportArchive.mockReturnValueOnce(old.promise);
    f.session.acknowledge(true); const previous = f.session.prepareExport(); f.session.lock();
    f.session.acknowledge(true); await f.session.prepareExport(); const current = f.session.state;
    old.reject(new Error("PRIVATE_STALE_ERROR")); await previous;
    expect(f.session.state).toBe(current); expect(f.session.state.downloadUrl).toBe("blob:synthetic-1");
    expect(f.port.revokeObjectURL).not.toHaveBeenCalled();
  });

  it.each(["export", "restore"])("a reentrant subscriber can lock before %s starts", async (kind) => {
    const f = fixture(); f.session.acknowledge(true); f.session.selectFile(file());
    f.session.subscribe(() => { if (f.session.state.phase === "busy") f.session.lock(); });
    if (kind === "export") await f.session.prepareExport(); else await f.session.restore();
    expectLocked(f.session); expect(f.backend.exportArchive).not.toHaveBeenCalled(); expect(f.port.readFile).not.toHaveBeenCalled();
  });

  it("a reentrant size accessor cannot retain a file after lock", () => {
    const f = fixture(); f.session.acknowledge(true);
    f.session.selectFile({ get size() { f.session.lock(); return 16; } } as File);
    expectLocked(f.session);
  });

  it("a selection subscriber can lock before a selected file can be reused", async () => {
    const f = fixture(); f.session.acknowledge(true);
    f.session.subscribe(() => { if (f.session.state.fileSize !== null) f.session.lock(); });
    f.session.selectFile(file()); await f.session.restore();
    expectLocked(f.session); expect(f.port.readFile).not.toHaveBeenCalled();
  });

  it("revokes a newly-created URL if its injected factory reentrantly locks", async () => {
    const f = fixture(); f.session.acknowledge(true);
    vi.mocked(f.port.createObjectURL).mockImplementation(() => { f.session.lock(); return "blob:late"; });
    await f.session.prepareExport(); expectLocked(f.session); expect(f.port.revokeObjectURL).toHaveBeenCalledWith("blob:late");
  });

  it("a result subscriber can lock after publication without retaining its URL", async () => {
    const f = fixture(); f.session.acknowledge(true);
    f.session.subscribe(() => { if (f.session.state.downloadUrl !== null) f.session.lock(); });
    await f.session.prepareExport(); expectLocked(f.session); expect(f.port.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("isolates throwing subscribers and supports unsubscribe", () => {
    const f = fixture(); const listener = vi.fn();
    f.session.subscribe(() => { throw new Error("UI subscriber failure"); });
    const unsubscribe = f.session.subscribe(listener);
    expect(() => f.session.acknowledge(true)).not.toThrow(); expect(listener).toHaveBeenCalledOnce();
    unsubscribe(); f.session.lock(); expect(listener).toHaveBeenCalledOnce();
  });
});

class Events {
  hidden = false;
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener === null) return;
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener !== null) this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, isTrusted = false) {
    for (const listener of [...this.listeners.get(type) ?? []]) {
      const event = { type, isTrusted } as Event;
      if (typeof listener === "function") listener(event); else listener.handleEvent(event);
    }
  }
}

function lifecycleFixture() {
  const f = fixture(); const doc = new Events(); const win = new Events();
  let wall = 1000; let monotonic = 1000;
  const environment: VaultAutoLockEnvironment = { document: doc, window: win, clocks: () => ({ wall, monotonic }) };
  const dispose = bindVaultAutoLock(f.session, environment);
  return { ...f, doc, win, environment, dispose,
    advance(ms: number) { wall += ms; monotonic += ms; },
    sleep(ms: number) { wall += ms; },
  };
}

describe("backup session lifecycle policy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it.each(["selected", "download", "error"])("clears a ready %s state at the 5 minute idle deadline", async (kind) => {
    const f = lifecycleFixture(); f.session.acknowledge(true);
    if (kind === "selected") f.session.selectFile(file());
    if (kind === "download") await f.session.prepareExport();
    if (kind === "error") f.session.selectFile(file(0));
    f.advance(VAULT_IDLE_TIMEOUT_MS - 1); vi.advanceTimersByTime(1000); expect(f.session.state.phase).toBe("open");
    f.advance(1); vi.advanceTimersByTime(1000); expectLocked(f.session);
    if (kind === "download") expect(f.port.revokeObjectURL).toHaveBeenCalledOnce();
    f.dispose();
  });

  it.each(["hidden", "pagehide"])("clears prepared URLs on %s and does not auto-reopen", async (event) => {
    const f = lifecycleFixture(); f.session.acknowledge(true); await f.session.prepareExport();
    if (event === "hidden") { f.doc.hidden = true; f.doc.emit("visibilitychange"); } else f.win.emit("pagehide");
    expectLocked(f.session); expect(f.port.revokeObjectURL).toHaveBeenCalledOnce();
    f.doc.hidden = false; f.doc.emit("visibilitychange"); f.win.emit("pageshow"); expectLocked(f.session); f.dispose();
  });

  it.each(["focus", "pageshow"])("detects device sleep from wall time on %s", (event) => {
    const f = lifecycleFixture(); f.session.acknowledge(true); f.session.selectFile(file());
    f.sleep(VAULT_IDLE_TIMEOUT_MS); f.win.emit(event); expectLocked(f.session); f.dispose();
  });

  it("ignores pending export after idle expiry", async () => {
    const f = lifecycleFixture(); const pending = deferred<Uint8Array>(); f.backend.exportArchive.mockReturnValue(pending.promise);
    f.session.acknowledge(true); const running = f.session.prepareExport();
    f.advance(VAULT_IDLE_TIMEOUT_MS); vi.advanceTimersByTime(1000);
    pending.resolve(new Uint8Array(16)); await running; expectLocked(f.session); expect(f.port.createObjectURL).not.toHaveBeenCalled(); f.dispose();
  });

  it("never starts work while hidden", async () => {
    const f = lifecycleFixture(); f.doc.hidden = true; f.session.acknowledge(true);
    await f.session.prepareExport(); expectLocked(f.session); expect(f.backend.exportArchive).not.toHaveBeenCalled(); f.dispose();
  });

  it("cleanup is idempotent and StrictMode cleanup/rebind stays usable without retained files", async () => {
    const f = lifecycleFixture(); f.session.acknowledge(true); await f.session.prepareExport();
    f.dispose(); f.dispose(); expectLocked(f.session); expect(vi.getTimerCount()).toBe(0);
    const calls = f.backend.cancel.mock.calls.length; f.win.emit("pagehide"); expect(f.backend.cancel).toHaveBeenCalledTimes(calls);
    const disposeAgain = bindVaultAutoLock(f.session, f.environment);
    expectLocked(f.session); expect(vi.getTimerCount()).toBe(1);
    f.session.acknowledge(true); await f.session.prepareExport(); expect(f.session.state.downloadUrl).toBe("blob:synthetic-2");
    f.advance(VAULT_IDLE_TIMEOUT_MS); vi.advanceTimersByTime(1000); expectLocked(f.session);
    disposeAgain(); expect(vi.getTimerCount()).toBe(0);
    expect([...f.doc.listeners.values(), ...f.win.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
});
