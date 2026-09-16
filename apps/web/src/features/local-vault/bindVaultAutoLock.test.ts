import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindVaultAutoLock, VAULT_IDLE_TIMEOUT_MS, type VaultAutoLockEnvironment } from "./bindVaultAutoLock";
import { SyntheticVaultSession, type SyntheticVaultWorker } from "./SyntheticVaultSession";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";

// Explicit event ports allow testing trusted input without pretending a browser
// dispatchEvent() creates a trusted user event.
class Events {
  hidden = false;
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener === null) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener !== null) this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, isTrusted = false) {
    const event = { type, isTrusted } as Event;
    for (const listener of [...this.listeners.get(type) ?? []]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

function fixture() {
  let wall = 1000;
  let monotonic = 1000;
  const doc = new Events();
  const win = new Events();
  const worker: SyntheticVaultWorker = {
    create: vi.fn().mockResolvedValue(new Uint8Array([1])),
    open: vi.fn().mockResolvedValue([]),
    cancel: vi.fn(),
  };
  const session = new SyntheticVaultSession({
    read: vi.fn().mockResolvedValue(new Uint8Array([1])),
    createIfAbsent: vi.fn().mockResolvedValue("created"),
    listConflictArchives: vi.fn().mockResolvedValue([{
      conflictId: "00000000000000000000000000000001", bytes: new Uint8Array([2]),
    }]),
    deleteConflictArchiveIfEqual: vi.fn().mockResolvedValue("deleted"),
  }, worker);
  const environment: VaultAutoLockEnvironment = {
    document: doc, window: win,
    clocks: () => ({ wall, monotonic }),
  };
  const dispose = bindVaultAutoLock(session, environment);
  return { doc, win, session, worker, dispose,
    advance(ms: number) { wall += ms; monotonic += ms; },
    clocks(nextWall: number, nextMonotonic: number) { wall = nextWall; monotonic = nextMonotonic; },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("local vault auto-lock", () => {
  it("does not open or access a vault merely by mounting", () => {
    const f = fixture();
    vi.advanceTimersByTime(VAULT_IDLE_TIMEOUT_MS);
    expect(f.session.state.phase).toBe("locked");
    expect(f.worker.open).not.toHaveBeenCalled();
    f.dispose();
  });

  it("locks at the exact idle deadline and cancels the worker", async () => {
    const f = fixture(); await f.session.open();
    f.advance(VAULT_IDLE_TIMEOUT_MS - 1);
    vi.advanceTimersByTime(1000);
    expect(f.session.state.phase).toBe("open");
    f.advance(1); vi.advanceTimersByTime(1000);
    expect(f.session.state.phase).toBe("locked");
    expect(f.session.state.entries).toEqual([]);
    expect(f.worker.cancel).toHaveBeenCalled();
    f.dispose();
  });

  it.each(["keydown", "pointerdown"])("only trusted %s refreshes an unexpired deadline", async (type) => {
    const f = fixture(); await f.session.open();
    f.advance(VAULT_IDLE_TIMEOUT_MS - 1); f.doc.emit(type, true);
    f.advance(VAULT_IDLE_TIMEOUT_MS - 1); vi.advanceTimersByTime(1000);
    expect(f.session.state.phase).toBe("open");
    f.advance(1); vi.advanceTimersByTime(1000);
    expect(f.session.state.phase).toBe("locked");
    f.dispose();
  });

  it("scripted input cannot extend the deadline", async () => {
    const f = fixture(); await f.session.open();
    f.advance(VAULT_IDLE_TIMEOUT_MS - 1); f.doc.emit("keydown");
    f.advance(1); vi.advanceTimersByTime(1000);
    expect(f.session.state.phase).toBe("locked"); f.dispose();
  });

  it("trusted input after a throttled deadline cannot revive the session", async () => {
    const f = fixture(); await f.session.open();
    f.advance(VAULT_IDLE_TIMEOUT_MS); f.doc.emit("pointerdown", true);
    expect(f.session.state.phase).toBe("locked"); f.dispose();
  });

  it.each(["focus", "pageshow"])("checks elapsed wall time on %s even if the monotonic clock slept", async (event) => {
    const f = fixture(); await f.session.open();
    f.clocks(1000 + VAULT_IDLE_TIMEOUT_MS, 1000); f.win.emit(event);
    expect(f.session.state.phase).toBe("locked"); f.dispose();
  });

  it("also expires using monotonic time if the wall clock stands still", async () => {
    const f = fixture(); await f.session.open();
    f.clocks(1000, 1000 + VAULT_IDLE_TIMEOUT_MS); vi.advanceTimersByTime(1000);
    expect(f.session.state.phase).toBe("locked"); f.dispose();
  });

  it.each([[999, 1000], [1000, 999], [NaN, 1000], [1000, Infinity]])(
    "locks on a backwards or invalid clock sample (%s, %s)", async (wall, monotonic) => {
      const f = fixture(); await f.session.open();
      f.clocks(wall, monotonic); vi.advanceTimersByTime(1000);
      expect(f.session.state.phase).toBe("locked"); f.dispose();
    },
  );

  it("locks on hidden or pagehide and never auto-unlocks on return", async () => {
    const f = fixture(); await f.session.open();
    f.doc.hidden = true; f.doc.emit("visibilitychange");
    expect(f.session.state.phase).toBe("locked");
    f.doc.hidden = false; f.doc.emit("visibilitychange"); f.win.emit("pageshow");
    expect(f.session.state.phase).toBe("locked");
    await f.session.open(); f.win.emit("pagehide");
    expect(f.session.state.phase).toBe("locked"); f.dispose();
  });

  it("does not start a worker when opening while hidden", async () => {
    const f = fixture(); f.doc.hidden = true;
    await f.session.open();
    expect(f.session.state.phase).toBe("locked");
    expect(f.worker.open).not.toHaveBeenCalled(); f.dispose();
  });

  it("a busy operation cannot publish a late result after idle lock", async () => {
    const f = fixture();
    let resolve!: (entries: readonly LocalCatalogEntryV1[]) => void;
    vi.mocked(f.worker.open).mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = f.session.open(); await Promise.resolve();
    expect(f.session.state.phase).toBe("busy");
    f.advance(VAULT_IDLE_TIMEOUT_MS); vi.advanceTimersByTime(1000);
    resolve([]); await pending;
    expect(f.session.state.phase).toBe("locked"); f.dispose();
  });

  it("an explicit reopen gets a new deadline", async () => {
    const f = fixture(); await f.session.open();
    f.advance(VAULT_IDLE_TIMEOUT_MS); vi.advanceTimersByTime(1000);
    await f.session.open();
    f.advance(VAULT_IDLE_TIMEOUT_MS - 1); vi.advanceTimersByTime(1000);
    expect(f.session.state.phase).toBe("open"); f.dispose();
  });

  it("cleanup is idempotent, locks, removes listeners and stops the timer", async () => {
    const f = fixture(); await f.session.open();
    f.dispose(); const calls = vi.mocked(f.worker.cancel).mock.calls.length;
    f.dispose(); f.win.emit("pagehide"); f.doc.hidden = true; f.doc.emit("visibilitychange");
    vi.advanceTimersByTime(VAULT_IDLE_TIMEOUT_MS);
    expect(f.session.state.phase).toBe("locked");
    expect(vi.mocked(f.worker.cancel).mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleanup invalidates authenticated conflict review plaintext", async () => {
    const f = fixture();
    await f.session.open();
    vi.mocked(f.worker.open).mockResolvedValueOnce([{
      reference: 0, itemName: "Ephemeral conflict item", providerName: "Demo provider",
      issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
      issuerProject: "demo-project", issuerEnvironment: "demo", credentialType: "api_key",
      status: "active", connectionCount: 0, secretFieldCount: 1, mcpConnectionCount: 0,
      connections: [],
    }]);
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.session.conflictReviewState.items[0]!.entries[0]!.itemName)
      .toBe("Ephemeral conflict item");
    const version = f.session.conflictReviewState.reviewVersion;

    f.dispose();

    expect(f.session.state.phase).toBe("locked");
    expect(f.session.conflictReviewState).toMatchObject({ phase: "idle", items: [] });
    expect(f.session.conflictReviewState.reviewVersion).toBeGreaterThan(version);
    expect(JSON.stringify(f.session.conflictReviewState)).not.toContain("Ephemeral conflict item");
  });
});
