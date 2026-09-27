import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  parseSyntheticToolAction,
  SYNTHETIC_TOOL_MAX_RESULTS,
  type SyntheticToolErrorCodeV1,
  type SyntheticToolFilterV1,
  type SyntheticToolReceiptV1,
} from "../../bridge/syntheticToolProtocol";
import type { SyntheticVaultSession } from "./SyntheticVaultSession";
import { searchLocalCatalog, type ConnectionFilter } from "./searchLocalCatalog";

export interface SyntheticVaultToolsState {
  readonly phase: "idle" | "busy" | "ready" | "error";
  /** Private local UI snapshot. Never send this state to an AI or transport. */
  readonly entries: readonly LocalCatalogEntryV1[];
  readonly receipt: SyntheticToolReceiptV1 | null;
}

type Session = Pick<SyntheticVaultSession, "state" | "viewGeneration" | "subscribe" | "lock">;
interface Binding {
  generation: number;
  ready: boolean;
  unsubscribe: (() => void) | null;
}
const EMPTY_ENTRIES: readonly LocalCatalogEntryV1[] = Object.freeze([]);
const IDLE: SyntheticVaultToolsState = Object.freeze({ phase: "idle", entries: EMPTY_ENTRIES, receipt: null });
const FILTERS: Readonly<Record<SyntheticToolFilterV1, ConnectionFilter>> = Object.freeze({
  all: "all", has_connection: "connected", no_connection: "unconnected", mcp_connection: "mcp",
});
const failure = (code: SyntheticToolErrorCodeV1): SyntheticToolReceiptV1 => Object.freeze({ kind: "error", code });

/** The private UI snapshot is separate from the fixed, metadata-free receipt. */
function snapshotLocalRow(entry: LocalCatalogEntryV1): LocalCatalogEntryV1 {
  return Object.freeze({
    reference: entry.reference, itemName: entry.itemName, providerName: entry.providerName,
    issuerAccountIdentifier: entry.issuerAccountIdentifier,
    issuerOrganizationOrWorkspace: entry.issuerOrganizationOrWorkspace,
    issuerProject: entry.issuerProject, issuerEnvironment: entry.issuerEnvironment,
    credentialType: entry.credentialType, status: entry.status,
    connectionCount: entry.connectionCount, secretFieldCount: entry.secretFieldCount,
    mcpConnectionCount: entry.mcpConnectionCount,
    connections: Object.freeze(entry.connections.map((connection) => Object.freeze({
      label: connection.label, consumerType: connection.consumerType,
    }))),
  });
}

/**
 * Local-only synthetic command controller, not an external AI authorization
 * boundary. Construction is inert; a mounted UI owns an explicit binding.
 * Commands return fixed receipts only. Displayable metadata stays in state.
 */
export class SyntheticVaultTools {
  readonly #session: Session;
  readonly #listeners = new Set<() => void>();
  #binding: Binding | null = null;
  #request = 0;
  #invocation = 0;
  #state: SyntheticVaultToolsState = IDLE;
  #viewGeneration: number | null = null;
  #requiresOpen = false;

  constructor(session: Session) { this.#session = session; }

  get state(): SyntheticVaultToolsState {
    if (!this.#binding?.ready) return IDLE;
    try {
      if (this.#viewGeneration !== null && this.#session.viewGeneration !== this.#viewGeneration) return IDLE;
      if (this.#requiresOpen && this.#session.state.phase !== "open") return IDLE;
      return this.#state;
    } catch {
      // Even a missed notification or failed session read must hide old rows.
      return IDLE;
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  bindToSession(): () => void {
    const previous = this.#binding;
    const binding: Binding = { generation: 0, ready: false, unsubscribe: null };
    this.#binding = binding;
    this.#request += 1;
    this.#clear();
    try { previous?.unsubscribe?.(); } catch { /* Old cleanup cannot affect the new binding. */ }
    try {
      binding.generation = this.#session.viewGeneration;
      const unsubscribe = this.#session.subscribe(() => { this.#sessionChanged(binding); });
      if (this.#binding !== binding) {
        try { unsubscribe(); } catch { /* A newer binding already owns the UI. */ }
      } else {
        binding.unsubscribe = unsubscribe;
        binding.ready = true;
        this.#sessionChanged(binding);
        this.#notify();
      }
    } catch {
      if (this.#binding === binding) {
        this.#binding = null;
        this.#request += 1;
        this.#clear();
      }
      try { binding.unsubscribe?.(); } catch { /* Keep the controller inert on partial setup failure. */ }
      this.#notify();
    }
    return () => {
      if (this.#binding !== binding) return;
      this.#binding = null;
      binding.ready = false;
      this.#request += 1;
      this.#clear();
      try { binding.unsubscribe?.(); } catch { /* Cleanup does not unlock or lock the session. */ }
      this.#notify();
    };
  }

  async executeTool(input: unknown): Promise<SyntheticToolReceiptV1> {
    const binding = this.#binding;
    if (!binding?.ready) return failure("NOT_READY");
    const request = ++this.#request;
    const invocation = ++this.#invocation;
    this.#clear();
    let generation = binding.generation;
    let explicitLock = false;
    try {
      generation = this.#session.viewGeneration;
      binding.generation = generation;
      const parsed = parseSyntheticToolAction(input);
      // Parsing an object may trigger Proxy traps that synchronously lock,
      // reopen, rebind, or start a newer command. Never trust the earlier view.
      if (!this.#current(binding, request, generation)) return failure("CANCELLED");
      if (!parsed.ok) return this.#publishError(parsed.code, binding, request, generation);
      const action = parsed.action;

      if (action.op === "lock_vault") {
        // Deliberately before the first await, including when another command
        // or the underlying session is busy. Lock never calls an unlock path.
        explicitLock = true;
        this.#session.lock();
        if (this.#binding !== binding || !binding.ready || invocation !== this.#invocation
            || this.#session.state.phase !== "locked") return failure("CANCELLED");
        // The explicit lock's own session notification invalidates requests.
        // Adopt that post-lock epoch only if no newer command took ownership.
        const lockedRequest = this.#request;
        const lockedGeneration = this.#session.viewGeneration;
        const receipt = Object.freeze({ kind: "ok" as const, action: action.op });
        this.#publish("ready", EMPTY_ENTRIES, receipt, lockedGeneration, false);
        return this.#current(binding, lockedRequest, lockedGeneration)
          && this.#session.state.phase === "locked" ? receipt : failure("CANCELLED");
      }

      const currentState = this.#session.state;
      if (currentState.phase !== "open") {
        return this.#publishError(currentState.phase === "locked" ? "VAULT_LOCKED" : "NOT_READY", binding, request, generation);
      }
      this.#publish("busy", EMPTY_ENTRIES, null, generation, true);
      if (!this.#current(binding, request, generation)) return failure("CANCELLED");
      await Promise.resolve();
      if (!this.#current(binding, request, generation) || this.#session.state.phase !== "open") return failure("CANCELLED");
      const rows = searchLocalCatalog(this.#session.state.entries,
        action.op === "search_catalog" ? action.query : "",
        action.op === "filter_catalog" ? FILTERS[action.filter] : "all");
      const localRows = Object.freeze(rows.slice(0, action.maxResults ?? SYNTHETIC_TOOL_MAX_RESULTS).map(snapshotLocalRow));
      if (!this.#current(binding, request, generation) || this.#session.state.phase !== "open") return failure("CANCELLED");
      const receipt = Object.freeze({ kind: "ok" as const, action: action.op });
      this.#publish("ready", localRows, receipt, generation, true);
      return this.#current(binding, request, generation) && this.#session.state.phase === "open"
        ? receipt : failure("CANCELLED");
    } catch {
      // Never read thrown .code/.message/.cause or reflect over the thrown value.
      if (this.#binding !== binding || invocation !== this.#invocation
          || (!explicitLock && request !== this.#request)) return failure("CANCELLED");
      const receipt = failure("OPERATION_FAILED");
      const failedRequest = this.#request;
      this.#publish("error", EMPTY_ENTRIES, receipt, generation, false);
      return this.#binding === binding && this.#request === failedRequest && this.#invocation === invocation
        ? receipt : failure("CANCELLED");
    }
  }

  #current(binding: Binding, request: number, generation: number): boolean {
    return this.#binding === binding && binding.ready && request === this.#request
      && generation === this.#session.viewGeneration;
  }

  #publishError(code: SyntheticToolErrorCodeV1, binding: Binding, request: number, generation: number): SyntheticToolReceiptV1 {
    const receipt = failure(code);
    this.#publish("error", EMPTY_ENTRIES, receipt, generation, false);
    return this.#current(binding, request, generation) ? receipt : failure("CANCELLED");
  }

  #publish(phase: SyntheticVaultToolsState["phase"], entries: readonly LocalCatalogEntryV1[],
    receipt: SyntheticToolReceiptV1 | null, generation: number, requiresOpen: boolean): void {
    this.#state = Object.freeze({ phase, entries, receipt });
    this.#viewGeneration = generation;
    this.#requiresOpen = requiresOpen;
    this.#notify();
  }

  #sessionChanged(binding: Binding): void {
    if (this.#binding !== binding) return;
    try {
      const generation = this.#session.viewGeneration;
      if (generation === binding.generation && this.#session.state.phase === "open") return;
      binding.generation = generation;
    } catch { /* A failed session read is also a reason to discard the local view. */ }
    this.#request += 1;
    this.#clear();
    this.#notify();
  }

  #clear(): void {
    this.#state = IDLE;
    this.#viewGeneration = null;
    this.#requiresOpen = false;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* Local UI subscribers cannot break cancellation. */ }
    }
  }
}
