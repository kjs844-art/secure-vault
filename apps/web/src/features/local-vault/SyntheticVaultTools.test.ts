import { describe, expect, it, vi } from "vitest";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { SyntheticVaultSession, SyntheticVaultSessionState } from "./SyntheticVaultSession";
import { SyntheticVaultTools } from "./SyntheticVaultTools";

type Session = Pick<SyntheticVaultSession, "state" | "viewGeneration" | "subscribe" | "lock">;

function item(reference: number, overrides: Partial<LocalCatalogEntryV1> = {}): LocalCatalogEntryV1 {
  return Object.freeze({ reference, itemName: "DEMO workbench", providerName: "Example Workshop",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo",
    credentialType: "api_key", status: "active", connectionCount: 0, secretFieldCount: 1,
    mcpConnectionCount: 0, connections: Object.freeze([]), ...overrides });
}
const entries = Object.freeze([
  item(4, { itemName: "DEMO 개인 비밀번호", providerName: "Example Mail", credentialType: "password" }),
  item(8, { connectionCount: 1, mcpConnectionCount: 1, connections: Object.freeze([
    Object.freeze({ label: "DEMO Local MCP", consumerType: "mcp_server" as const }),
  ]) }),
  item(2, { status: "rotation_due", connectionCount: 1, connections: Object.freeze([
    Object.freeze({ label: "DEMO Build runner", consumerType: "ci_cd" as const }),
  ]) }),
]);

class SessionFixture implements Session {
  viewGeneration = 0;
  state: SyntheticVaultSessionState = Object.freeze({ phase: "open", entries, errorCode: null });
  readonly listeners = new Set<() => void>();
  readonly subscribe = vi.fn((listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  });
  readonly lock = vi.fn(() => { this.change("locked"); });
  change(phase: SyntheticVaultSessionState["phase"], rows = entries, notify = true): void {
    this.viewGeneration += 1;
    this.state = Object.freeze({ phase, entries: phase === "open" ? rows : Object.freeze([]), errorCode: null });
    if (notify) for (const listener of [...this.listeners]) listener();
  }
}

function setup() {
  const session = new SessionFixture();
  const tools = new SyntheticVaultTools(session);
  const unbind = tools.bindToSession();
  return { session, tools, unbind };
}
const search = (query = "", maxResults?: number) => ({ op: "search_catalog", query, ...(maxResults === undefined ? {} : { maxResults }) });
const filter = (value = "all", maxResults?: number) => ({ op: "filter_catalog", filter: value, ...(maxResults === undefined ? {} : { maxResults }) });
const error = (code: string) => ({ kind: "error", code });

describe("synthetic local tools lifecycle", () => {
  it("constructs without reading, subscribing, locking or other session I/O", () => {
    const io = vi.fn(() => { throw new Error("SHOULD_NOT_RUN"); });
    const tools = new SyntheticVaultTools({ get state() { return io(); }, get viewGeneration() { return io(); }, subscribe: io, lock: io });
    expect(io).not.toHaveBeenCalled();
    expect(tools.state).toEqual({ phase: "idle", entries: [], receipt: null });
    expect(io).not.toHaveBeenCalled();
  });

  it("does not parse or execute commands before binding, including lock", async () => {
    const session = new SessionFixture();
    const tools = new SyntheticVaultTools(session);
    const trap = vi.fn(() => { throw new Error("SHOULD_NOT_RUN"); });
    expect(await tools.executeTool(new Proxy({}, { ownKeys: trap }))).toEqual(error("NOT_READY"));
    expect(await tools.executeTool({ op: "lock_vault" })).toEqual(error("NOT_READY"));
    expect(trap).not.toHaveBeenCalled();
    expect(session.subscribe).not.toHaveBeenCalled();
    expect(session.lock).not.toHaveBeenCalled();
  });

  it("supports StrictMode bind-cleanup-bind with no retained rows or extra subscription", async () => {
    const { session, tools, unbind } = setup();
    await tools.executeTool(search("mail"));
    unbind();
    unbind();
    expect(session.listeners.size).toBe(0);
    expect(tools.state).toEqual({ phase: "idle", entries: [], receipt: null });
    expect(await tools.executeTool(search())).toEqual(error("NOT_READY"));
    const secondCleanup = tools.bindToSession();
    expect(session.listeners.size).toBe(1);
    expect(await tools.executeTool(search("mcp"))).toEqual({ kind: "ok", action: "search_catalog" });
    secondCleanup();
    expect(session.listeners.size).toBe(0);
    expect(session.lock).not.toHaveBeenCalled();
  });

  it("an older cleanup cannot disconnect a newer binding", async () => {
    const { session, tools, unbind } = setup();
    const secondCleanup = tools.bindToSession();
    expect(session.listeners.size).toBe(1);
    unbind();
    expect(session.listeners.size).toBe(1);
    expect(await tools.executeTool(search())).toEqual({ kind: "ok", action: "search_catalog" });
    session.lock();
    expect(tools.state.entries).toEqual([]);
    secondCleanup();
  });

  it("binding and unbinding cancel pending work", async () => {
    const { tools, unbind } = setup();
    const first = tools.executeTool(search());
    unbind();
    tools.bindToSession();
    expect(await first).toEqual(error("CANCELLED"));
    expect(tools.state.entries).toEqual([]);
    const second = tools.executeTool(search());
    tools.bindToSession();
    expect(await second).toEqual(error("CANCELLED"));
  });

  it("subscription failure leaves the controller inert and does not inspect the thrown value", async () => {
    const fixture = new SessionFixture();
    const inspect = vi.fn(() => { throw new Error("DO_NOT_INSPECT"); });
    // A plain throw avoids the spy framework itself inspecting thrown values.
    const session: Session = { get state() { return fixture.state; }, get viewGeneration() { return fixture.viewGeneration; },
      subscribe() { throw new Proxy({}, { get: inspect, getPrototypeOf: inspect }); }, lock: fixture.lock };
    const tools = new SyntheticVaultTools(session);
    expect(() => tools.bindToSession()).not.toThrow();
    expect(await tools.executeTool(search())).toEqual(error("NOT_READY"));
    expect(inspect).not.toHaveBeenCalled();
    expect(fixture.lock).not.toHaveBeenCalled();
  });

  it("keeps local subscribers isolated and supports unsubscribe", async () => {
    const { tools } = setup();
    const good = vi.fn();
    tools.subscribe(() => { throw new Error("LOCAL_SUBSCRIBER_FAILURE"); });
    const off = tools.subscribe(good);
    expect(await tools.executeTool(search())).toEqual({ kind: "ok", action: "search_catalog" });
    expect(good).toHaveBeenCalled();
    off();
    const calls = good.mock.calls.length;
    await tools.executeTool(search("mail"));
    expect(good).toHaveBeenCalledTimes(calls);
  });

  it("cleans up a stale subscription created during a reentrant bind", async () => {
    const fixture = new SessionFixture();
    let reentered = false;
    let tools: SyntheticVaultTools;
    const session: Session = { get state() { return fixture.state; }, get viewGeneration() { return fixture.viewGeneration; },
      subscribe(listener) {
        const off = fixture.subscribe(listener);
        if (!reentered) { reentered = true; tools.bindToSession(); }
        return off;
      }, lock: fixture.lock };
    tools = new SyntheticVaultTools(session);
    const olderCleanup = tools.bindToSession();
    expect(fixture.listeners.size).toBe(1);
    olderCleanup();
    expect(fixture.listeners.size).toBe(1);
    expect(await tools.executeTool(search())).toEqual({ kind: "ok", action: "search_catalog" });
    fixture.lock();
    expect(tools.state.entries).toEqual([]);
  });

  it("an old unsubscribe throwing cannot disable the replacement binding", async () => {
    const fixture = new SessionFixture();
    const session: Session = { get state() { return fixture.state; }, get viewGeneration() { return fixture.viewGeneration; },
      subscribe(listener) {
        const off = fixture.subscribe(listener);
        return () => { off(); throw new Error("DEMO_CLEANUP_FAILURE"); };
      }, lock: fixture.lock };
    const tools = new SyntheticVaultTools(session);
    tools.bindToSession();
    const cleanup = tools.bindToSession();
    expect(fixture.listeners.size).toBe(1);
    expect(await tools.executeTool(search())).toEqual({ kind: "ok", action: "search_catalog" });
    expect(() => cleanup()).not.toThrow();
    expect(fixture.listeners.size).toBe(0);
  });
});

describe("synthetic local tools session guards", () => {
  it.each(["locked", "busy", "empty", "error"] as const)("denies metadata operations while %s", async (phase) => {
    const { session, tools } = setup();
    session.change(phase);
    const expected = error(phase === "locked" ? "VAULT_LOCKED" : "NOT_READY");
    expect(await tools.executeTool(search())).toEqual(expected);
    expect(await tools.executeTool(filter())).toEqual(expected);
    expect(tools.state.entries).toEqual([]);
    expect(session.lock).not.toHaveBeenCalled();
  });

  it.each(["locked", "busy", "empty", "error"] as const)("clears the displayed result on %s session notification", async (phase) => {
    const { session, tools } = setup();
    await tools.executeTool(search());
    session.change(phase);
    expect(tools.state).toEqual({ phase: "idle", entries: [], receipt: null });
  });

  it("clears on an open-to-open generation change", async () => {
    const { session, tools } = setup();
    await tools.executeTool(search());
    session.change("open", [item(99)]);
    expect(tools.state.entries).toEqual([]);
  });

  it("the getter cannot return stale rows even if a session notification was missed", async () => {
    const { session, tools } = setup();
    await tools.executeTool(search());
    session.change("open", [item(99)], false);
    expect(tools.state.entries).toEqual([]);
    expect(await tools.executeTool(search())).toEqual({ kind: "ok", action: "search_catalog" });
    expect(tools.state.entries.map((row) => row.reference)).toEqual([99]);
  });

  it("never restores pending rows after lock and reopen", async () => {
    const { session, tools } = setup();
    const pending = tools.executeTool(search());
    session.lock();
    session.change("open", [item(99)]);
    expect(await pending).toEqual(error("CANCELLED"));
    expect(tools.state.entries).toEqual([]);
  });

  it("checks generation again after a parser Proxy trap locks and reopens", async () => {
    const { session, tools } = setup();
    const input = new Proxy(search(), { ownKeys(target) {
      session.lock();
      session.change("open", [item(99)]);
      return Reflect.ownKeys(target);
    } });
    expect(await tools.executeTool(input)).toEqual(error("CANCELLED"));
    expect(tools.state.entries).toEqual([]);
  });

  it("newer operations win even when started by a parser trap", async () => {
    const { tools } = setup();
    let inner: ReturnType<SyntheticVaultTools["executeTool"]> | undefined;
    const input = new Proxy(search("mail"), { ownKeys(target) {
      inner = tools.executeTool(search("runner"));
      return Reflect.ownKeys(target);
    } });
    expect(await tools.executeTool(input)).toEqual(error("CANCELLED"));
    expect(await inner).toEqual({ kind: "ok", action: "search_catalog" });
    expect(tools.state.entries.map((row) => row.reference)).toEqual([2]);
  });

  it("latest command wins rather than publishing an earlier result", async () => {
    const { tools } = setup();
    const first = tools.executeTool(search("mail"));
    const second = tools.executeTool(filter("mcp_connection"));
    expect(await first).toEqual(error("CANCELLED"));
    expect(await second).toEqual({ kind: "ok", action: "filter_catalog" });
    expect(tools.state.entries.map((row) => row.reference)).toEqual([8]);
  });

  it("rechecks cancellation after ready notification reenters session.lock", async () => {
    const { session, tools } = setup();
    tools.subscribe(() => { if (tools.state.phase === "ready") session.lock(); });
    expect(await tools.executeTool(search())).toEqual(error("CANCELLED"));
    expect(tools.state.entries).toEqual([]);
  });

  it("rechecks cancellation after busy notification unbinds", async () => {
    const { tools, unbind } = setup();
    tools.subscribe(() => { if (tools.state.phase === "busy") unbind(); });
    expect(await tools.executeTool(search())).toEqual(error("CANCELLED"));
    expect(tools.state.entries).toEqual([]);
  });

  it("a newer invalid command also cancels older pending metadata work", async () => {
    const { tools } = setup();
    const pending = tools.executeTool(search());
    expect(await tools.executeTool({ op: "unapproved" })).toEqual(error("INVALID_TOOL"));
    expect(await pending).toEqual(error("CANCELLED"));
    expect(tools.state.receipt).toEqual(error("INVALID_TOOL"));
    expect(tools.state.entries).toEqual([]);
  });

  it("a new command started by a ready subscriber owns both result and receipt", async () => {
    const { tools } = setup();
    let next: ReturnType<SyntheticVaultTools["executeTool"]> | undefined;
    let once = false;
    tools.subscribe(() => {
      if (!once && tools.state.phase === "ready") {
        once = true;
        next = tools.executeTool(filter("mcp_connection"));
      }
    });
    expect(await tools.executeTool(search("mail"))).toEqual(error("CANCELLED"));
    expect(await next).toEqual({ kind: "ok", action: "filter_catalog" });
    expect(tools.state.entries.map((row) => row.reference)).toEqual([8]);
  });

  it("a metadata read which locks then throws cannot publish a stale failure", async () => {
    const { session, tools } = setup();
    const row = { ...item(11) };
    Object.defineProperty(row, "itemName", { get() { session.lock(); throw new Error("SYNTHETIC_PRIVATE"); } });
    session.change("open", [row]);
    expect(await tools.executeTool(search())).toEqual(error("CANCELLED"));
    expect(tools.state).toEqual({ phase: "idle", entries: [], receipt: null });
  });
});

describe("synthetic local tools operations and receipts", () => {
  it("copies only reviewed local issuer fields while receipts reveal neither rows nor query", async () => {
    const { session, tools } = setup();
    const source = { ...item(42), issuerAccountIdentifier: "PRIVATE_ACCOUNT_FIXTURE",
      issuerOrganizationOrWorkspace: "PRIVATE_WORKSPACE_FIXTURE", issuerProject: "PRIVATE_PROJECT_FIXTURE",
      issuerEnvironment: "PRIVATE_ENVIRONMENT_FIXTURE",
      connections: [{ label: "LOCAL_CONNECTION", consumerType: "app" as const }], connectionCount: 1 };
    for (const field of ["notes", "issuerConsoleUrl", "secretValue", "toJSON"]) {
      Object.defineProperty(source, field, { enumerable: true, get() { throw new Error("UNREVIEWED_FIELD_READ"); } });
    }
    session.change("open", [source]);
    const receipt = await tools.executeTool(search("PRIVATE_ACCOUNT_FIXTURE"));
    expect(receipt).toEqual({ kind: "ok", action: "search_catalog" });
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_");
    const copied = tools.state.entries[0]!;
    // Compare identity as a boolean: assertion diagnostics may otherwise
    // inspect deliberately hostile test-only getters on the source object.
    expect(Object.is(copied, source)).toBe(false);
    expect(Object.is(copied.connections, source.connections)).toBe(false);
    expect(copied).toMatchObject({ issuerAccountIdentifier: "PRIVATE_ACCOUNT_FIXTURE",
      issuerOrganizationOrWorkspace: "PRIVATE_WORKSPACE_FIXTURE", issuerProject: "PRIVATE_PROJECT_FIXTURE",
      issuerEnvironment: "PRIVATE_ENVIRONMENT_FIXTURE" });
    expect(Object.isFrozen(copied)).toBe(true); expect(Object.isFrozen(copied.connections[0])).toBe(true);
    for (const field of ["notes", "issuerConsoleUrl", "secretValue", "toJSON"]) expect(copied).not.toHaveProperty(field);
    source.issuerAccountIdentifier = "changed"; source.connections[0]!.label = "changed";
    expect(copied.issuerAccountIdentifier).toBe("PRIVATE_ACCOUNT_FIXTURE");
    expect(copied.connections[0]!.label).toBe("LOCAL_CONNECTION");
    session.lock(); expect(tools.state.entries).toEqual([]);
  });
  it.each(["locked", "busy", "empty", "open", "error"] as const)("locks immediately while %s, without an await or unlock", async (phase) => {
    const { session, tools } = setup();
    session.change(phase);
    const result = tools.executeTool({ op: "lock_vault" });
    expect(session.lock).toHaveBeenCalledTimes(1);
    expect(session.state.phase).toBe("locked");
    expect(tools.state.entries).toEqual([]);
    expect(await result).toEqual({ kind: "ok", action: "lock_vault" });
  });

  it("lock cancels a pending search before it can publish rows", async () => {
    const { tools } = setup();
    const pending = tools.executeTool(search());
    expect(await tools.executeTool({ op: "lock_vault" })).toEqual({ kind: "ok", action: "lock_vault" });
    expect(await pending).toEqual(error("CANCELLED"));
    expect(tools.state.entries).toEqual([]);
  });

  it("normalizes a throwing lock without inspecting the error object", async () => {
    const fixture = new SessionFixture();
    const inspect = vi.fn(() => { throw new Error("DO_NOT_INSPECT"); });
    const session: Session = { get state() { return fixture.state; }, get viewGeneration() { return fixture.viewGeneration; },
      subscribe: fixture.subscribe, lock() { throw new Proxy({}, { get: inspect, getPrototypeOf: inspect }); } };
    const tools = new SyntheticVaultTools(session);
    tools.bindToSession();
    await tools.executeTool(search());
    expect(await tools.executeTool({ op: "lock_vault" })).toEqual(error("OPERATION_FAILED"));
    expect(tools.state.entries).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    ["mail", [4]], ["비밀번호", [4]], ["ＭＣＰ", [8]], ["runner", [2]], ["교체 필요", [2]], [".*", []],
  ])("reuses the local metadata search for %s", async (query, references) => {
    const { tools } = setup();
    expect(await tools.executeTool(search(query as string))).toEqual({ kind: "ok", action: "search_catalog" });
    expect(tools.state.entries.map((row) => row.reference)).toEqual(references);
  });

  it.each([
    ["all", [4, 8, 2]], ["has_connection", [8, 2]], ["no_connection", [4]], ["mcp_connection", [8]],
  ])("maps %s to the local connection filter", async (value, references) => {
    const { tools } = setup();
    expect(await tools.executeTool(filter(value as string))).toEqual({ kind: "ok", action: "filter_catalog" });
    expect(tools.state.entries.map((row) => row.reference)).toEqual(references);
  });

  it.each([search("", 0), filter("all", 0)])("honors a zero result cap: %j", async (input) => {
    const { tools } = setup();
    expect(await tools.executeTool(input)).toEqual({ kind: "ok", action: input.op });
    expect(tools.state.entries).toEqual([]);
  });

  it.each([search(), filter(), filter("has_connection"), filter("mcp_connection")])("caps results at 500 by default: %j", async (input) => {
    const { session, tools } = setup();
    session.change("open", Object.freeze(Array.from({ length: 510 }, (_, index) => item(index, {
      connectionCount: 1, mcpConnectionCount: 1, connections: entries[1]!.connections,
    }))));
    expect(await tools.executeTool(input)).toEqual({ kind: "ok", action: input.op });
    expect(tools.state.entries).toHaveLength(500);
    expect(tools.state.entries[499]?.reference).toBe(499);
  });

  it.each([search("", 1), filter("all", 1)])("honors smaller caps: %j", async (input) => {
    const { tools } = setup();
    await tools.executeTool(input);
    expect(tools.state.entries.map((row) => row.reference)).toEqual([4]);
  });

  it("uses indistinguishable success receipts for matches and no matches", async () => {
    const { tools } = setup();
    const matched = await tools.executeTool(search("mail"));
    expect(tools.state.entries).toHaveLength(1);
    const empty = await tools.executeTool(search("SYNTHETIC_NOT_PRESENT"));
    expect(tools.state.entries).toHaveLength(0);
    expect(matched).toEqual(empty);
    expect(Object.keys(matched).sort()).toEqual(["action", "kind"]);
    expect(JSON.stringify(matched)).toBe('{"kind":"ok","action":"search_catalog"}');
  });

  it("freezes UI state, local array and receipts without exposing the query", async () => {
    const { tools } = setup();
    const receipt = await tools.executeTool(search("mail"));
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(tools.state)).toBe(true);
    expect(Object.isFrozen(tools.state.entries)).toBe(true);
    expect(Object.keys(tools.state).sort()).toEqual(["entries", "phase", "receipt"]);
    expect(Object.keys(receipt).sort()).toEqual(["action", "kind"]);
  });

  it("never searches extra secret, notes, identifiers or serialization getters", async () => {
    const { session, tools } = setup();
    const row = { ...item(22) };
    const access = vi.fn(() => { throw new Error("SYNTHETIC_PRIVATE"); });
    for (const name of ["secret", "notes", "recordId", "toJSON"]) {
      Object.defineProperty(row, name, { get: access });
    }
    session.change("open", [Object.freeze(row)]);
    expect(await tools.executeTool(search("workbench"))).toEqual({ kind: "ok", action: "search_catalog" });
    expect(await tools.executeTool(search("SYNTHETIC_PRIVATE"))).toEqual({ kind: "ok", action: "search_catalog" });
    expect(tools.state.entries).toEqual([]);
    expect(access).not.toHaveBeenCalled();
  });

  it("normalizes failed metadata reads without exposing thrown content", async () => {
    const { session, tools } = setup();
    const row = { ...item(22) };
    const inspect = vi.fn(() => { throw new Error("DO_NOT_INSPECT"); });
    Object.defineProperty(row, "itemName", { get() { throw new Proxy({}, { get: inspect, getPrototypeOf: inspect }); } });
    session.change("open", [row]);
    expect(await tools.executeTool(search())).toEqual(error("OPERATION_FAILED"));
    expect(tools.state.entries).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    [{ op: "reveal_secret", query: "SYNTHETIC_PRIVATE" }, "INVALID_TOOL"],
    [{ op: "search_catalog", query: "SYNTHETIC_PRIVATE", provider: "unapproved" }, "INVALID_PAYLOAD"],
    [search("가".repeat(43)), "LIMIT_EXCEEDED"],
    [filter("all", 501), "LIMIT_EXCEEDED"],
    [null, "INVALID_PAYLOAD"],
  ])("rejects invalid commands without echoing fields: %j", async (input, code) => {
    const { tools } = setup();
    await tools.executeTool(search());
    const receipt = await tools.executeTool(input);
    expect(receipt).toEqual(error(code as string));
    expect(Object.keys(receipt).sort()).toEqual(["code", "kind"]);
    expect(tools.state.entries).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain("SYNTHETIC_PRIVATE");
  });
});
