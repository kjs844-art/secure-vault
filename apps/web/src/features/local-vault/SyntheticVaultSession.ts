import {
  CATALOG_ERROR_CODES_V1,
  CatalogAdapterError,
  type LocalCatalogEntryV1,
} from "../../bridge/catalogProtocol";
import {
  projectRotationChecklistV1,
  type LocalRotationChecklistV1,
} from "../../bridge/rotationProtocol";
import {
  MAX_SYNTHETIC_CONFLICT_ARCHIVES,
  MAX_SYNTHETIC_ARCHIVE_BYTES,
  SyntheticStorageError,
  type SyntheticCiphertextStore,
  type SyntheticConflictArchive,
  type SyntheticConflictCiphertextStore,
  type SyntheticConflictPreservationResult,
  type SyntheticConflictPreservingCasResult,
} from "../../storage/SyntheticCiphertextStore";
import { parseSyntheticRegistration, type SyntheticRegistrationSelection } from "./syntheticRegistration";
import { parseSyntheticConnectionEdit, type SyntheticConnectionEditSelection } from "./syntheticConnectionEdit";
import { parseSyntheticRotationSelection, type SyntheticRotationSelection } from "./syntheticRotation";
import { projectRotationStageV1, type LocalRotationStageV1 } from "../../bridge/rotationStageProtocol";
import { parseSyntheticRotationStageSelection, type SyntheticRotationStageSelection } from "./syntheticRotationStage";

export interface SyntheticVaultWorker {
  create(): Promise<Uint8Array>;
  open(bytes: Uint8Array): Promise<readonly LocalCatalogEntryV1[]>;
  cancel(): void;
}

export interface SyntheticRegistrationWorker extends SyntheticVaultWorker {
  append(bytes: Uint8Array, selection: SyntheticRegistrationSelection): Promise<Uint8Array>;
}

export interface SyntheticConnectionEditWorker extends SyntheticVaultWorker {
  editConnections(bytes: Uint8Array, selection: SyntheticConnectionEditSelection): Promise<Uint8Array>;
}

export interface SyntheticRotationWorker extends SyntheticVaultWorker {
  inspectRotation(
    bytes: Uint8Array,
    selection: SyntheticRotationSelection,
  ): Promise<LocalRotationChecklistV1>;
  createRotationCutover(
    bytes: Uint8Array,
    selection: SyntheticRotationSelection,
  ): Promise<Uint8Array>;
}

export interface SyntheticRotationStageWorker extends SyntheticVaultWorker {
  inspectRotationStage(bytes: Uint8Array, reference: number): Promise<LocalRotationStageV1 | null>;
  saveRotationStage(bytes: Uint8Array, selection: SyntheticRotationStageSelection): Promise<Uint8Array>;
  createRotationCutoverFromStage(bytes: Uint8Array, reference: number): Promise<Uint8Array>;
}

export interface SyntheticRotationStageReviewState {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly reviewVersion: number;
  readonly stage: LocalRotationStageV1 | null;
  readonly errorCode: string | null;
}

export interface SyntheticRotationStageReceipt {
  readonly reviewVersion: number;
  readonly reference: number;
  readonly stage: LocalRotationStageV1 | null;
}

type RotationWrite = { readonly kind: "cutover"; readonly selection: SyntheticRotationSelection }
  | { readonly kind: "stage"; readonly selection: SyntheticRotationStageSelection }
  | { readonly kind: "saved-cutover"; readonly reference: number };

function stageReviewState(
  phase: SyntheticRotationStageReviewState["phase"], reviewVersion: number,
  stage: LocalRotationStageV1 | null = null, errorCode: string | null = null,
): SyntheticRotationStageReviewState {
  return Object.freeze({ phase, reviewVersion, stage, errorCode });
}

class RegistrationStateError extends Error {
  constructor(readonly code: "REGISTRATION_UNAVAILABLE" | "CONNECTION_EDIT_UNAVAILABLE"
    | "ROTATION_UNAVAILABLE" | "CONFLICT_REVIEW_UNAVAILABLE" | "CONFLICT_REVIEW_STALE"
    | "STORAGE_CONFLICT" | "STORAGE_CONFLICT_PRESERVED" | "STORAGE_MISSING") {
    super(code);
  }
}

export interface SyntheticVaultSessionState {
  readonly phase: "locked" | "busy" | "empty" | "open" | "error";
  readonly entries: readonly LocalCatalogEntryV1[];
  readonly errorCode: string | null;
}

export interface SyntheticConflictReviewItem {
  /** Ephemeral position scoped to reviewVersion, never a stored conflict ID. */
  readonly reference: number;
  readonly entries: readonly LocalCatalogEntryV1[];
}

export interface SyntheticConflictReviewState {
  readonly phase: "idle" | "loading" | "ready" | "confirm-discard"
    | "discarding" | "discarded" | "error";
  readonly reviewVersion: number;
  readonly items: readonly SyntheticConflictReviewItem[];
  readonly pendingReference: number | null;
  readonly errorCode: string | null;
}

export interface SyntheticRotationReviewState {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly reviewVersion: number;
  readonly checklist: LocalRotationChecklistV1 | null;
  readonly errorCode: string | null;
}

/** Returned only when this exact review is still ready after all notifications. */
export interface SyntheticRotationInspectionReceipt {
  readonly reviewVersion: number;
  readonly selection: SyntheticRotationSelection;
}

const EMPTY_ENTRIES: readonly LocalCatalogEntryV1[] = Object.freeze([]);
const EMPTY_CONFLICT_REVIEW_ITEMS: readonly SyntheticConflictReviewItem[] = Object.freeze([]);
const STORAGE_ERROR_CODES = new Set([
  "unavailable", "blocked", "incompatible", "corrupt", "invalid-bytes",
  "invalid-conflict-id", "outbox-full", "quota", "aborted", "failed",
]);
const CATALOG_ERROR_CODES = new Set<string>(CATALOG_ERROR_CODES_V1);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "byteLength",
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "buffer",
)!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "byteOffset",
)!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength",
)!.get!;
const typedArrayFill = Uint8Array.prototype.fill;

function hasExclusiveArrayBuffer(value: Uint8Array): boolean {
  try {
    const buffer = typedArrayBuffer.call(value) as ArrayBufferLike;
    arrayBufferByteLength.call(buffer);
    return true;
  } catch { return false; }
}

function copyArchive(value: Uint8Array): Uint8Array {
  let length: number;
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error();
    if (!hasExclusiveArrayBuffer(value)) throw new Error();
    // Own byteLength/length properties cannot replace the native view's bounds.
    length = typedArrayByteLength.call(value) as number;
  } catch {
    throw new CatalogAdapterError("INVALID_ARCHIVE");
  }
  if (length < 1) throw new CatalogAdapterError("INVALID_ARCHIVE");
  if (length > MAX_SYNTHETIC_ARCHIVE_BYTES) throw new CatalogAdapterError("LIMITS_EXCEEDED");
  try { return new Uint8Array(value); }
  catch { throw new CatalogAdapterError("INVALID_ARCHIVE"); }
}

/** Best-effort wipe without consulting an injected value's own properties. */
function wipeArchive(value: unknown): void {
  try {
    const buffer = typedArrayBuffer.call(value) as ArrayBufferLike;
    // Reject SharedArrayBuffer and detached/foreign backing stores before a
    // byte-wise view is constructed.
    arrayBufferByteLength.call(buffer);
    const byteOffset = typedArrayByteOffset.call(value) as number;
    const byteLength = typedArrayByteLength.call(value) as number;
    if (byteLength < 1) return;
    const bytes = new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength);
    typedArrayFill.call(bytes, 0);
  } catch { /* Hostile, shared or detached values cannot be safely wiped here. */ }
}

async function withArchiveCopy<T>(
  source: Uint8Array,
  use: (copy: Uint8Array) => Promise<T>,
): Promise<T> {
  const copy = new Uint8Array(source);
  try { return await use(copy); }
  finally { wipeArchive(copy); }
}

async function withArchivePair<T>(
  first: Uint8Array,
  second: Uint8Array,
  use: (firstCopy: Uint8Array, secondCopy: Uint8Array) => Promise<T>,
): Promise<T> {
  const firstCopy = new Uint8Array(first);
  const secondCopy = new Uint8Array(second);
  try { return await use(firstCopy, secondCopy); }
  finally {
    wipeArchive(firstCopy);
    wipeArchive(secondCopy);
  }
}

function sameArchive(left: Uint8Array, right: Uint8Array): boolean {
  try {
    if (!(left instanceof Uint8Array) || Object.getPrototypeOf(left) !== Uint8Array.prototype
        || !(right instanceof Uint8Array) || Object.getPrototypeOf(right) !== Uint8Array.prototype
        || !hasExclusiveArrayBuffer(left) || !hasExclusiveArrayBuffer(right)) return false;
    const length = typedArrayByteLength.call(left) as number;
    if (length < 1 || length > MAX_SYNTHETIC_ARCHIVE_BYTES || length !== typedArrayByteLength.call(right)) return false;
    for (let index = 0; index < length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  } catch { return false; }
}

function parseConflictPreservingResult(value: unknown): SyntheticConflictPreservingCasResult {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    const read = (key: string): unknown => {
      const descriptor = fields[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      return descriptor.value;
    };
    const kind = read("kind");
    if (kind === "updated" || kind === "missing") {
      if (Reflect.ownKeys(fields).length !== 1) throw new Error();
      return Object.freeze({ kind });
    }
    if (kind === "conflict-preserved") {
      if (Reflect.ownKeys(fields).length !== 2) throw new Error();
      const conflictId = read("conflictId");
      if (typeof conflictId !== "string" || !/^[0-9a-f]{32}$/.test(conflictId)) throw new Error();
      return Object.freeze({ kind, conflictId });
    }
  } catch { /* Normalize hostile result objects without reading their values or messages. */ }
  throw new Error("INVALID_STORAGE_RESULT");
}

function parseConflictPreservationResult(value: unknown): SyntheticConflictPreservationResult {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    const read = (key: string): unknown => {
      const descriptor = fields[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      return descriptor.value;
    };
    const kind = read("kind");
    if (kind === "already-current" || kind === "missing") {
      if (Reflect.ownKeys(fields).length !== 1) throw new Error();
      return Object.freeze({ kind });
    }
    if (kind === "conflict-preserved") {
      if (Reflect.ownKeys(fields).length !== 2) throw new Error();
      const conflictId = read("conflictId");
      if (typeof conflictId !== "string" || !/^[0-9a-f]{32}$/.test(conflictId)) throw new Error();
      return Object.freeze({ kind, conflictId });
    }
  } catch { /* Normalize hostile result objects without reading their values or messages. */ }
  throw new Error("INVALID_STORAGE_RESULT");
}

function parseConflictArchives(value: unknown): readonly SyntheticConflictArchive[] {
  const copied: SyntheticConflictArchive[] = [];
  try {
    if (!Array.isArray(value)) throw new Error();
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SYNTHETIC_CONFLICT_ARCHIVES) {
      throw new Error();
    }
    const seen = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      const entry = descriptor.value;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) throw new Error();
      const fields = Object.getOwnPropertyDescriptors(entry);
      if (Reflect.ownKeys(fields).length !== 2) throw new Error();
      const idDescriptor = fields.conflictId;
      const bytesDescriptor = fields.bytes;
      if (!idDescriptor || !("value" in idDescriptor) || !idDescriptor.enumerable
          || !bytesDescriptor || !("value" in bytesDescriptor) || !bytesDescriptor.enumerable) {
        throw new Error();
      }
      const conflictId = idDescriptor.value;
      if (typeof conflictId !== "string" || !/^[0-9a-f]{32}$/.test(conflictId)
          || seen.has(conflictId)) throw new Error();
      seen.add(conflictId);
      copied.push(Object.freeze({ conflictId, bytes: copyArchive(bytesDescriptor.value as Uint8Array) }));
    }
    return Object.freeze(copied);
  } catch {
    for (const conflict of copied) conflict.bytes.fill(0);
    throw new SyntheticStorageError("corrupt");
  }
}

function emptyState(phase: "locked" | "busy" | "empty" | "error", errorCode: string | null = null): SyntheticVaultSessionState {
  return Object.freeze({ phase, entries: EMPTY_ENTRIES, errorCode });
}

function conflictReviewState(
  phase: SyntheticConflictReviewState["phase"],
  reviewVersion: number,
  items: readonly SyntheticConflictReviewItem[] = EMPTY_CONFLICT_REVIEW_ITEMS,
  pendingReference: number | null = null,
  errorCode: string | null = null,
): SyntheticConflictReviewState {
  return Object.freeze({ phase, reviewVersion, items, pendingReference, errorCode });
}

function rotationReviewState(
  phase: SyntheticRotationReviewState["phase"],
  reviewVersion: number,
  checklist: LocalRotationChecklistV1 | null = null,
  errorCode: string | null = null,
): SyntheticRotationReviewState {
  return Object.freeze({ phase, reviewVersion, checklist, errorCode });
}

function fixedErrorCode(error: unknown): string {
  try {
    if (error instanceof RegistrationStateError) return error.code;
    if (error instanceof CatalogAdapterError) {
      const code = error.code;
      if (CATALOG_ERROR_CODES.has(code)) return code;
    }
    if (error instanceof SyntheticStorageError) {
      const code = error.code;
      if (STORAGE_ERROR_CODES.has(code)) return code;
    }
  } catch {
    // A thrown proxy or a hostile error-code accessor is still untrusted data.
  }
  return "OPERATION_FAILED";
}

/** Snapshot only the locally displayable fields; never retain worker-owned rows. */
function snapshotEntries(entries: readonly LocalCatalogEntryV1[]): readonly LocalCatalogEntryV1[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    reference: entry.reference,
    itemName: entry.itemName,
    providerName: entry.providerName,
    issuerAccountIdentifier: entry.issuerAccountIdentifier,
    issuerOrganizationOrWorkspace: entry.issuerOrganizationOrWorkspace,
    issuerProject: entry.issuerProject,
    issuerEnvironment: entry.issuerEnvironment,
    credentialType: entry.credentialType,
    status: entry.status,
    connectionCount: entry.connectionCount,
    secretFieldCount: entry.secretFieldCount,
    mcpConnectionCount: entry.mcpConnectionCount,
    connections: Object.freeze(entry.connections.map((connection) => Object.freeze({
      label: connection.label,
      consumerType: connection.consumerType,
    }))),
  })));
}

/**
 * Owns one synthetic local-vault UI session. Lock invalidates every pending
 * continuation; a write already committing may finish ciphertext-only, but can
 * never repopulate this session. JS strings retained by callers cannot be erased.
 */
export class SyntheticVaultSession {
  readonly #store: SyntheticCiphertextStore & Partial<SyntheticConflictCiphertextStore>;
  readonly #worker: SyntheticVaultWorker
    & Partial<SyntheticRegistrationWorker & SyntheticConnectionEditWorker & SyntheticRotationWorker & SyntheticRotationStageWorker>;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #state: SyntheticVaultSessionState = emptyState("locked");
  // Owned, bounded ciphertext only. Never exposed through state, tools, or rows.
  #displayedArchive: Uint8Array | undefined;
  #reviewVersion = 0;
  #conflictReviewState: SyntheticConflictReviewState = conflictReviewState("idle", 0);
  // Storage IDs and exact ciphertext snapshots stay private. UI receives only
  // reviewVersion-scoped positions and authenticated catalog projections.
  readonly #conflictReviewSnapshots = new Map<number, {
    readonly conflictId: string;
    readonly expectedBytes: Uint8Array;
  }>();
  #rotationReviewVersion = 0;
  #rotationReviewState: SyntheticRotationReviewState = rotationReviewState("idle", 0);
  #rotationReviewSnapshot: {
    readonly expectedBytes: Uint8Array;
    readonly selection: SyntheticRotationSelection;
  } | undefined;
  #stageReviewVersion = 0;
  #stageReviewState: SyntheticRotationStageReviewState = stageReviewState("idle", 0);
  #stageReviewSnapshot: { readonly expectedBytes: Uint8Array; readonly reference: number } | undefined;

  constructor(
    store: SyntheticCiphertextStore & Partial<SyntheticConflictCiphertextStore>,
    worker: SyntheticVaultWorker
      & Partial<SyntheticRegistrationWorker & SyntheticConnectionEditWorker & SyntheticRotationWorker & SyntheticRotationStageWorker>,
  ) {
    this.#store = store;
    this.#worker = worker;
  }

  get state(): SyntheticVaultSessionState { return this.#state; }

  get conflictReviewState(): SyntheticConflictReviewState { return this.#conflictReviewState; }

  get rotationReviewState(): SyntheticRotationReviewState { return this.#rotationReviewState; }
  get rotationStageReviewState(): SyntheticRotationStageReviewState { return this.#stageReviewState; }

  // Ephemeral UI identity only, never a stored record ID or authorization token.
  // A fresh key lets React discard view-local search state even if it batches
  // an intervening lock and reopen into one committed render.
  get viewGeneration(): number { return this.#generation; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async create(): Promise<void> { await this.#run(true); }
  async open(): Promise<void> { await this.#run(false); }

  /** Authenticate every candidate before publishing any conflict projection. */
  async loadConflictReviews(expectedVaultGeneration: number): Promise<void> {
    if (this.#state.phase !== "open" || expectedVaultGeneration !== this.#generation
        || !this.#displayedArchive || this.#conflictReviewState.phase === "discarding") return;
    const vaultGeneration = this.#generation;
    const reviewVersion = this.#startConflictReview("loading");
    let candidates: readonly SyntheticConflictArchive[] | undefined;
    let snapshotsOwnedBySession = false;
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
      const list = this.#store.listConflictArchives;
      if (typeof list !== "function") {
        throw new RegistrationStateError("CONFLICT_REVIEW_UNAVAILABLE");
      }
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
      const raw = await list.call(this.#store);
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
      candidates = parseConflictArchives(raw);
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;

      const items: SyntheticConflictReviewItem[] = [];
      for (let reference = 0; reference < candidates.length; reference += 1) {
        const candidate = candidates[reference]!;
        const entries = await this.#worker.open(new Uint8Array(candidate.bytes));
        if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
        const snapshot = snapshotEntries(entries);
        if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
        items.push(Object.freeze({ reference, entries: snapshot }));
      }
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;

      for (let reference = 0; reference < candidates.length; reference += 1) {
        const candidate = candidates[reference]!;
        this.#conflictReviewSnapshots.set(reference, Object.freeze({
          conflictId: candidate.conflictId,
          expectedBytes: candidate.bytes,
        }));
      }
      snapshotsOwnedBySession = true;
      this.#conflictReviewState = conflictReviewState(
        "ready", reviewVersion, Object.freeze(items), null, null,
      );
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
      const errorCode = fixedErrorCode(error);
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
      this.#conflictReviewState = conflictReviewState("error", reviewVersion,
        EMPTY_CONFLICT_REVIEW_ITEMS, null, errorCode);
      this.#notify();
    } finally {
      if (!snapshotsOwnedBySession && candidates) {
        for (const candidate of candidates) candidate.bytes.fill(0);
      }
    }
  }

  /** First explicit discard step. This never touches storage. */
  requestConflictDiscard(expectedReviewVersion: number, reference: number): void {
    if (this.#conflictReviewState.phase !== "ready"
        || expectedReviewVersion !== this.#reviewVersion
        || !Number.isSafeInteger(reference) || reference < 0
        || !this.#conflictReviewSnapshots.has(reference)) return;
    this.#conflictReviewState = conflictReviewState(
      "confirm-discard", this.#reviewVersion, this.#conflictReviewState.items, reference, null,
    );
    this.#notify();
  }

  cancelConflictDiscard(expectedReviewVersion: number): void {
    if (this.#conflictReviewState.phase !== "confirm-discard"
        || expectedReviewVersion !== this.#reviewVersion) return;
    this.#conflictReviewState = conflictReviewState(
      "ready", this.#reviewVersion, this.#conflictReviewState.items, null, null,
    );
    this.#notify();
  }

  /** Second explicit discard step. Delete only the exact reviewed ciphertext. */
  async confirmConflictDiscard(expectedReviewVersion: number, reference: number): Promise<void> {
    if (this.#state.phase !== "open"
        || this.#conflictReviewState.phase !== "confirm-discard"
        || expectedReviewVersion !== this.#reviewVersion
        || this.#conflictReviewState.pendingReference !== reference) return;
    const snapshot = this.#conflictReviewSnapshots.get(reference);
    if (!snapshot) return;
    const vaultGeneration = this.#generation;
    const reviewVersion = this.#reviewVersion;
    const expectedBytes = new Uint8Array(snapshot.expectedBytes);
    this.#conflictReviewState = conflictReviewState(
      "discarding", reviewVersion, this.#conflictReviewState.items, reference, null,
    );
    try {
      this.#notify();
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)
          || this.#conflictReviewState.phase !== "discarding") return;
      const remove = this.#store.deleteConflictArchiveIfEqual;
      if (typeof remove !== "function") {
        throw new RegistrationStateError("CONFLICT_REVIEW_UNAVAILABLE");
      }
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)
          || this.#conflictReviewState.phase !== "discarding") return;
      const result = await remove.call(this.#store, snapshot.conflictId, expectedBytes);
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)
          || this.#conflictReviewState.phase !== "discarding") return;
      if (result !== "deleted" && result !== "missing" && result !== "changed") {
        throw new Error("INVALID_STORAGE_RESULT");
      }
      if (result !== "deleted") throw new RegistrationStateError("CONFLICT_REVIEW_STALE");
      this.#finishConflictReview("discarded", null);
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
      const errorCode = fixedErrorCode(error);
      if (!this.#isReviewCurrent(vaultGeneration, reviewVersion)) return;
      this.#finishConflictReview("error", errorCode);
      this.#notify();
    } finally {
      expectedBytes.fill(0);
    }
  }

  /** Inspect one exact authenticated display snapshot without changing its vault generation. */
  async inspectRotation(
    expectedVaultGeneration: number,
    input: unknown,
  ): Promise<SyntheticRotationInspectionReceipt | null> {
    if (this.#state.phase !== "open" || expectedVaultGeneration !== this.#generation
        || !this.#displayedArchive || this.#conflictReviewState.phase === "discarding") return null;
    const vaultGeneration = this.#generation;
    const before = new Uint8Array(this.#displayedArchive);
    const reviewVersion = this.#startRotationReview("loading");
    let snapshotOwnedBySession = false;
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isRotationReviewCurrent(vaultGeneration, reviewVersion)) return null;
      const selection = parseSyntheticRotationSelection(input);
      if (!this.#isRotationReviewCurrent(vaultGeneration, reviewVersion)) return null;
      if (!this.#isApiKeyReference(selection.reference)) throw new CatalogAdapterError("INVALID_ARCHIVE");
      const inspect = this.#worker.inspectRotation;
      if (!this.#isRotationReviewCurrent(vaultGeneration, reviewVersion)) return null;
      if (typeof inspect !== "function") {
        throw new RegistrationStateError("ROTATION_UNAVAILABLE");
      }
      const rawChecklist = await withArchiveCopy(
        before,
        (inspectionInput) => inspect.call(this.#worker, inspectionInput, selection),
      );
      if (!this.#isRotationReviewCurrent(vaultGeneration, reviewVersion)) return null;
      const checklist = projectRotationChecklistV1(rawChecklist);
      if (!this.#isRotationReviewCurrent(vaultGeneration, reviewVersion)) return null;
      this.#rotationReviewSnapshot = Object.freeze({
        expectedBytes: before,
        selection,
      });
      snapshotOwnedBySession = true;
      this.#rotationReviewState = rotationReviewState(
        "ready", reviewVersion, checklist, null,
      );
      this.#notify();
      if (!this.#isRotationReviewCurrent(vaultGeneration, reviewVersion)
          || this.#rotationReviewState.phase !== "ready") return null;
      return Object.freeze({
        reviewVersion,
        selection: Object.freeze({ ...selection }),
      });
    } catch (error: unknown) {
      if (!this.#isRotationReviewCurrent(vaultGeneration, reviewVersion)) return null;
      const errorCode = fixedErrorCode(error);
      if (!this.#isRotationReviewCurrent(vaultGeneration, reviewVersion)) return null;
      this.#rotationReviewState = rotationReviewState("error", reviewVersion, null, errorCode);
      this.#notify();
      return null;
    } finally {
      if (!snapshotOwnedBySession) before.fill(0);
    }
  }

  /**
   * Commit only the exact reviewed archive and selection. A generated candidate
   * is not success until atomic storage, authoritative reread and reauthentication.
   */
  async commitRotationCutover(
    expectedVaultGeneration: number,
    expectedReviewVersion: number,
  ): Promise<void> {
    const review = this.#rotationReviewState;
    const reviewed = this.#rotationReviewSnapshot;
    if (this.#state.phase !== "open" || expectedVaultGeneration !== this.#generation
        || review.phase !== "ready" || expectedReviewVersion !== this.#rotationReviewVersion
        || review.reviewVersion !== expectedReviewVersion
        || review.checklist?.readinessState !== "ready"
        || !reviewed || !this.#displayedArchive
        || !sameArchive(this.#displayedArchive, reviewed.expectedBytes)) return;

    const before = new Uint8Array(reviewed.expectedBytes);
    const selection = parseSyntheticRotationSelection(reviewed.selection);
    if (!this.#isApiKeyReference(selection.reference)) { before.fill(0); return; }
    await this.#commitRotationCandidate(before, { kind: "cutover", selection });
  }

  /** Save ciphertext progress without advancing the canonical credential head. */
  async saveRotationStage(expectedVaultGeneration: number, input: unknown): Promise<void> {
    if (!this.#canSaveRotationStage(expectedVaultGeneration)) return;
    let selection: SyntheticRotationStageSelection;
    try { selection = parseSyntheticRotationStageSelection(input); }
    catch { return; }
    // A hostile selection Proxy can reenter even descriptor-only parsers.
    if (!this.#canSaveRotationStage(expectedVaultGeneration) || !this.#displayedArchive
        || !this.#isApiKeyReference(selection.reference)) return;
    const before = new Uint8Array(this.#displayedArchive);
    await this.#commitRotationCandidate(before, { kind: "stage", selection });
  }

  /** A receipt belongs to these exact displayed bytes, reference and review. */
  async inspectRotationStage(expectedVaultGeneration: number, reference: number): Promise<SyntheticRotationStageReceipt | null> {
    if (this.#state.phase !== "open" || expectedVaultGeneration !== this.#generation
        || !this.#displayedArchive || this.#conflictReviewState.phase === "discarding"
        || !Number.isSafeInteger(reference) || Object.is(reference, -0) || reference < 0 || reference > 127
        || !this.#isApiKeyReference(reference)) return null;
    const before = new Uint8Array(this.#displayedArchive);
    this.#invalidateAuxiliaryReviews();
    const reviewVersion = this.#stageReviewVersion;
    this.#stageReviewState = stageReviewState("loading", reviewVersion);
    let owned = false;
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isStageReviewCurrent(expectedVaultGeneration, reviewVersion)) return null;
      const inspect = this.#worker.inspectRotationStage;
      if (!this.#isStageReviewCurrent(expectedVaultGeneration, reviewVersion)) return null;
      if (typeof inspect !== "function") throw new RegistrationStateError("ROTATION_UNAVAILABLE");
      const raw = await withArchiveCopy(before, (bytes) => inspect.call(this.#worker, bytes, reference));
      if (!this.#isStageReviewCurrent(expectedVaultGeneration, reviewVersion)) return null;
      const stage = raw === null ? null : projectRotationStageV1(raw);
      if (!this.#isStageReviewCurrent(expectedVaultGeneration, reviewVersion)) return null;
      this.#stageReviewSnapshot = Object.freeze({ expectedBytes: before, reference });
      owned = true;
      this.#stageReviewState = stageReviewState("ready", reviewVersion, stage);
      this.#notify();
      if (!this.#isStageReviewCurrent(expectedVaultGeneration, reviewVersion)
          || this.#stageReviewState.phase !== "ready") return null;
      return Object.freeze({ reviewVersion, reference, stage });
    } catch (error: unknown) {
      if (!this.#isStageReviewCurrent(expectedVaultGeneration, reviewVersion)) return null;
      const code = fixedErrorCode(error);
      if (!this.#isStageReviewCurrent(expectedVaultGeneration, reviewVersion)) return null;
      this.#stageReviewState = stageReviewState("error", reviewVersion, null, code);
      this.#notify();
      return null;
    } finally { if (!owned) before.fill(0); }
  }

  async commitRotationCutoverFromStage(expectedVaultGeneration: number, expectedReviewVersion: number): Promise<void> {
    const review = this.#stageReviewState;
    const reviewed = this.#stageReviewSnapshot;
    if (this.#state.phase !== "open" || expectedVaultGeneration !== this.#generation
        || expectedReviewVersion !== this.#stageReviewVersion || review.phase !== "ready"
        || review.reviewVersion !== expectedReviewVersion || !review.stage?.readyForCutover
        || !reviewed || !this.#displayedArchive
        || !sameArchive(this.#displayedArchive, reviewed.expectedBytes)
        || !this.#isApiKeyReference(reviewed.reference)) return;
    await this.#commitRotationCandidate(new Uint8Array(reviewed.expectedBytes), {
      kind: "saved-cutover", reference: reviewed.reference,
    });
  }

  /** Shared CAS/outbox/readback path; no write mode can skip authentication. */
  async #commitRotationCandidate(before: Uint8Array, operation: RotationWrite): Promise<void> {
    const generation = ++this.#generation;
    this.#invalidateAuxiliaryReviews();
    this.#forgetArchive();
    this.#state = emptyState("busy");
    let candidate: Uint8Array | undefined;
    let authenticatedArchive: Uint8Array | undefined;
    let rawCandidate: unknown;
    let saved: unknown;
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isCurrent(generation)) return;
      const createCandidate = operation.kind === "cutover" ? this.#worker.createRotationCutover
        : operation.kind === "stage" ? this.#worker.saveRotationStage
          : this.#worker.createRotationCutoverFromStage;
      const open = this.#worker.open;
      const read = this.#store.read;
      const preservingCas = this.#store.compareAndSwapArchivePreservingConflict;
      const preserveAfterReadback = this.#store.preserveConflictArchiveIfCurrentDiffers;
      if (!this.#isCurrent(generation)) return;
      if (typeof createCandidate !== "function" || typeof open !== "function"
          || typeof read !== "function" || typeof preservingCas !== "function"
          || typeof preserveAfterReadback !== "function") {
        throw new RegistrationStateError("ROTATION_UNAVAILABLE");
      }
      rawCandidate = await withArchiveCopy(
        before,
        (cutoverInput) => {
          // The discriminated operation selects the exact method argument.
          if (operation.kind === "saved-cutover") return (createCandidate as SyntheticRotationStageWorker["createRotationCutoverFromStage"])
            .call(this.#worker, cutoverInput, operation.reference);
          if (operation.kind === "stage") return (createCandidate as SyntheticRotationStageWorker["saveRotationStage"])
            .call(this.#worker, cutoverInput, operation.selection);
          return (createCandidate as SyntheticRotationWorker["createRotationCutover"])
            .call(this.#worker, cutoverInput, operation.selection);
        },
      );
      if (!this.#isCurrent(generation)) return;
      candidate = copyArchive(rawCandidate as Uint8Array);
      wipeArchive(rawCandidate);
      rawCandidate = undefined;
      if (sameArchive(before, candidate)) {
        throw new CatalogAdapterError("INVALID_ARCHIVE");
      }
      if (!this.#isCurrent(generation)) return;
      // Authenticate the complete candidate before any storage write. This
      // projection is deliberately discarded.
      await withArchiveCopy(
        candidate,
        (authenticationInput) => open.call(this.#worker, authenticationInput),
      );
      if (!this.#isCurrent(generation)) return;
      const rawCommitted = await withArchivePair(
        before,
        candidate,
        (expectedInput, candidateInput) => preservingCas.call(
          this.#store, expectedInput, candidateInput,
        ),
      );
      if (!this.#isCurrent(generation)) return;
      const committed = parseConflictPreservingResult(rawCommitted);
      if (!this.#isCurrent(generation)) return;
      if (committed.kind === "missing") {
        throw new RegistrationStateError("STORAGE_MISSING");
      }
      if (committed.kind === "conflict-preserved") {
        throw new RegistrationStateError("STORAGE_CONFLICT_PRESERVED");
      }

      saved = await read.call(this.#store);
      if (!this.#isCurrent(generation)) return;
      if (saved === null) throw new RegistrationStateError("STORAGE_MISSING");
      const readbackMatches = sameArchive(candidate, saved as Uint8Array);
      if (!this.#isCurrent(generation)) return;
      if (!readbackMatches) {
        wipeArchive(saved);
        saved = undefined;
        const rawPreserved = await withArchiveCopy(
          candidate,
          (candidateInput) => preserveAfterReadback.call(this.#store, candidateInput),
        );
        if (!this.#isCurrent(generation)) return;
        const preserved = parseConflictPreservationResult(rawPreserved);
        if (!this.#isCurrent(generation)) return;
        if (preserved.kind === "missing") {
          throw new RegistrationStateError("STORAGE_MISSING");
        }
        if (preserved.kind === "conflict-preserved") {
          throw new RegistrationStateError("STORAGE_CONFLICT_PRESERVED");
        }
        throw new RegistrationStateError("STORAGE_CONFLICT");
      }

      authenticatedArchive = copyArchive(saved as Uint8Array);
      wipeArchive(saved);
      saved = undefined;
      if (!sameArchive(candidate, authenticatedArchive)) {
        throw new RegistrationStateError("STORAGE_CONFLICT");
      }
      if (!this.#isCurrent(generation)) return;
      const entries = await withArchiveCopy(
        authenticatedArchive,
        (authenticationInput) => open.call(this.#worker, authenticationInput),
      );
      if (!this.#isCurrent(generation)) return;
      const snapshot = snapshotEntries(entries);
      if (!this.#isCurrent(generation)) return;
      this.#displayedArchive = authenticatedArchive;
      authenticatedArchive = undefined;
      this.#state = Object.freeze({ phase: "open", entries: snapshot, errorCode: null });
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return;
      const code = fixedErrorCode(error);
      if (!this.#isCurrent(generation)) return;
      this.#state = emptyState("error", code);
      this.#notify();
    } finally {
      wipeArchive(before);
      wipeArchive(rawCandidate);
      wipeArchive(candidate);
      wipeArchive(saved);
      wipeArchive(authenticatedArchive);
    }
  }

  /** No implicit unlock, retry or create. Only the reread/authenticated saved result is shown. */
  async register(input: unknown): Promise<void> {
    if (this.#state.phase !== "open" || !this.#displayedArchive) return;
    // Bind the registration intent to the exact authenticated snapshot that is
    // currently displayed. A newer, unseen storage value must not silently
    // become the base for this mutation.
    const before = new Uint8Array(this.#displayedArchive);
    const generation = ++this.#generation;
    this.#invalidateAuxiliaryReviews();
    this.#forgetArchive();
    this.#state = emptyState("busy");
    let current: unknown;
    let rawCandidate: unknown;
    let candidate: Uint8Array | undefined;
    let saved: unknown;
    let authenticatedArchive: Uint8Array | undefined;
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isCurrent(generation)) return;
      const selection = parseSyntheticRegistration(input);
      if (!this.#isCurrent(generation)) return;
      const append = this.#worker.append;
      const open = this.#worker.open;
      const read = this.#store.read;
      const plainCas = this.#store.compareAndSwapArchive;
      const preservingCas = this.#store.compareAndSwapArchivePreservingConflict;
      const preserveAfterReadback = this.#store.preserveConflictArchiveIfCurrentDiffers;
      const hasConflictOutbox = typeof preservingCas === "function"
        && typeof preserveAfterReadback === "function";
      if (typeof append !== "function" || typeof open !== "function"
          || typeof read !== "function"
          || (!hasConflictOutbox && typeof plainCas !== "function")) {
        throw new RegistrationStateError("REGISTRATION_UNAVAILABLE");
      }

      if (!hasConflictOutbox) {
        // Compatibility path for injected/older stores. The production browser
        // store takes the atomic conflict-preserving path and skips this stale-
        // prone pre-CAS read.
        current = await read.call(this.#store);
        if (!this.#isCurrent(generation)) return;
        if (current === null) throw new RegistrationStateError("STORAGE_MISSING");
        if (!sameArchive(before, current as Uint8Array)) {
          throw new RegistrationStateError("STORAGE_CONFLICT");
        }
        wipeArchive(current);
        current = undefined;
      }

      // Rust authenticates every existing envelope before producing an append candidate.
      rawCandidate = await withArchiveCopy(
        before,
        (appendInput) => append.call(this.#worker, appendInput, selection),
      );
      if (!this.#isCurrent(generation)) return;
      candidate = copyArchive(rawCandidate as Uint8Array);
      wipeArchive(rawCandidate);
      rawCandidate = undefined;
      if (sameArchive(before, candidate)) {
        throw new CatalogAdapterError("INVALID_ARCHIVE");
      }
      if (!this.#isCurrent(generation)) return;

      // Authenticate the complete candidate before any storage write. The
      // projection is deliberately discarded and never reaches public state.
      await withArchiveCopy(
        candidate,
        (authenticationInput) => open.call(this.#worker, authenticationInput),
      );
      if (!this.#isCurrent(generation)) return;

      if (hasConflictOutbox) {
        const rawCommitted = await withArchivePair(
          before,
          candidate,
          (expectedInput, candidateInput) => preservingCas.call(
            this.#store, expectedInput, candidateInput,
          ),
        );
        if (!this.#isCurrent(generation)) return;
        const committed = parseConflictPreservingResult(rawCommitted);
        if (!this.#isCurrent(generation)) return;
        if (committed.kind === "missing") {
          throw new RegistrationStateError("STORAGE_MISSING");
        }
        if (committed.kind === "conflict-preserved") {
          throw new RegistrationStateError("STORAGE_CONFLICT_PRESERVED");
        }
      } else {
        const committed = await withArchivePair(
          before,
          candidate,
          (expectedInput, candidateInput) => plainCas!.call(
            this.#store, expectedInput, candidateInput,
          ),
        );
        if (!this.#isCurrent(generation)) return;
        if (committed !== "updated") {
          throw new RegistrationStateError(
            committed === "missing" ? "STORAGE_MISSING" : "STORAGE_CONFLICT",
          );
        }
      }

      saved = await read.call(this.#store);
      if (!this.#isCurrent(generation)) return;
      if (saved === null) throw new RegistrationStateError("STORAGE_MISSING");
      // A later writer may already have changed storage. Do not confirm our candidate
      // based on a different archive, silently retry, or discard our exact candidate.
      if (!sameArchive(candidate, saved as Uint8Array)) {
        wipeArchive(saved);
        saved = undefined;
        if (hasConflictOutbox) {
          const rawPreserved = await withArchiveCopy(
            candidate,
            (candidateInput) => preserveAfterReadback.call(this.#store, candidateInput),
          );
          if (!this.#isCurrent(generation)) return;
          const preserved = parseConflictPreservationResult(rawPreserved);
          if (!this.#isCurrent(generation)) return;
          if (preserved.kind === "missing") {
            throw new RegistrationStateError("STORAGE_MISSING");
          }
          if (preserved.kind === "conflict-preserved") {
            throw new RegistrationStateError("STORAGE_CONFLICT_PRESERVED");
          }
        }
        throw new RegistrationStateError("STORAGE_CONFLICT");
      }

      authenticatedArchive = copyArchive(saved as Uint8Array);
      wipeArchive(saved);
      saved = undefined;
      if (!sameArchive(candidate, authenticatedArchive)) {
        throw new RegistrationStateError("STORAGE_CONFLICT");
      }
      if (!this.#isCurrent(generation)) return;
      const entries = await withArchiveCopy(
        authenticatedArchive,
        (authenticationInput) => open.call(this.#worker, authenticationInput),
      );
      if (!this.#isCurrent(generation)) return;
      const snapshot = snapshotEntries(entries);
      if (!this.#isCurrent(generation)) return;
      this.#displayedArchive = authenticatedArchive;
      authenticatedArchive = undefined;
      this.#state = Object.freeze({ phase: "open", entries: snapshot, errorCode: null });
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return;
      const code = fixedErrorCode(error);
      if (!this.#isCurrent(generation)) return;
      this.#state = emptyState("error", code);
      this.#notify();
    } finally {
      wipeArchive(before);
      wipeArchive(current);
      wipeArchive(rawCandidate);
      wipeArchive(candidate);
      wipeArchive(saved);
      wipeArchive(authenticatedArchive);
    }
  }

  /**
   * Bind a positional reference to the exact archive used for the selected view.
   * No implicit unlock, retry, overwrite, merge or conflict-candidate display.
   */
  async editConnections(expectedGeneration: number, input: unknown): Promise<void> {
    if (this.#state.phase !== "open" || expectedGeneration !== this.#generation || !this.#displayedArchive) return;
    const displayedEntries = this.#state.entries;
    const before = new Uint8Array(this.#displayedArchive);
    const generation = ++this.#generation;
    this.#invalidateAuxiliaryReviews();
    this.#forgetArchive();
    this.#state = emptyState("busy");
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isCurrent(generation)) return;
      const selection = parseSyntheticConnectionEdit(input);
      if (!this.#isCurrent(generation)) return;
      if (!displayedEntries.some((entry) => entry.reference === selection.reference && entry.credentialType === "api_key")) {
        throw new CatalogAdapterError("INVALID_ARCHIVE");
      }
      if (!this.#worker.editConnections) {
        throw new RegistrationStateError("CONNECTION_EDIT_UNAVAILABLE");
      }
      const preservingCas = this.#store.compareAndSwapArchivePreservingConflict;
      const preserveAfterReadback = this.#store.preserveConflictArchiveIfCurrentDiffers;
      if (!this.#isCurrent(generation)) return;
      let candidate: Uint8Array;
      const hasConflictOutbox = typeof preservingCas === "function"
        && typeof preserveAfterReadback === "function";
      if (hasConflictOutbox) {
        // The authenticated displayed snapshot is enough to build the candidate.
        // Avoid a separate pre-CAS read whose result could immediately become stale.
        const edited = await this.#worker.editConnections(new Uint8Array(before), selection);
        if (!this.#isCurrent(generation)) return;
        candidate = copyArchive(edited);
        if (!this.#isCurrent(generation)) return;
        // Authenticate the complete candidate before any storage write. The
        // projection is deliberately discarded and never reaches public state.
        await this.#worker.open(new Uint8Array(candidate));
        if (!this.#isCurrent(generation)) return;
        const rawCommitted = await preservingCas.call(
          this.#store, new Uint8Array(before), new Uint8Array(candidate),
        );
        if (!this.#isCurrent(generation)) return;
        const committed = parseConflictPreservingResult(rawCommitted);
        if (!this.#isCurrent(generation)) return;
        if (committed.kind === "missing") throw new RegistrationStateError("STORAGE_MISSING");
        if (committed.kind === "conflict-preserved") {
          throw new RegistrationStateError("STORAGE_CONFLICT_PRESERVED");
        }
      } else {
        // Conservative compatibility for injected/older stores. The browser
        // store exposes the atomic conflict-preserving capability above.
        if (!this.#store.compareAndSwapArchive) {
          throw new RegistrationStateError("CONNECTION_EDIT_UNAVAILABLE");
        }
        const current = await this.#store.read();
        if (!this.#isCurrent(generation)) return;
        if (current === null) throw new RegistrationStateError("STORAGE_MISSING");
        if (!sameArchive(before, current)) throw new RegistrationStateError("STORAGE_CONFLICT");
        if (!this.#isCurrent(generation)) return;
        const edited = await this.#worker.editConnections(new Uint8Array(before), selection);
        if (!this.#isCurrent(generation)) return;
        candidate = copyArchive(edited);
        if (!this.#isCurrent(generation)) return;
        await this.#worker.open(new Uint8Array(candidate));
        if (!this.#isCurrent(generation)) return;
        const committed = await this.#store.compareAndSwapArchive(
          new Uint8Array(before), new Uint8Array(candidate),
        );
        if (!this.#isCurrent(generation)) return;
        if (committed !== "updated") {
          throw new RegistrationStateError(committed === "missing" ? "STORAGE_MISSING" : "STORAGE_CONFLICT");
        }
      }
      const saved = await this.#store.read();
      if (!this.#isCurrent(generation)) return;
      if (saved === null) throw new RegistrationStateError("STORAGE_MISSING");
      if (!sameArchive(candidate, saved)) {
        if (hasConflictOutbox) {
          const rawPreserved = await preserveAfterReadback.call(
            this.#store, new Uint8Array(candidate),
          );
          if (!this.#isCurrent(generation)) return;
          const preserved = parseConflictPreservationResult(rawPreserved);
          if (!this.#isCurrent(generation)) return;
          if (preserved.kind === "missing") throw new RegistrationStateError("STORAGE_MISSING");
          if (preserved.kind === "conflict-preserved") {
            throw new RegistrationStateError("STORAGE_CONFLICT_PRESERVED");
          }
        }
        throw new RegistrationStateError("STORAGE_CONFLICT");
      }
      const authenticatedArchive = copyArchive(saved);
      if (!sameArchive(candidate, authenticatedArchive)) throw new RegistrationStateError("STORAGE_CONFLICT");
      if (!this.#isCurrent(generation)) return;
      const entries = await this.#worker.open(new Uint8Array(authenticatedArchive));
      if (!this.#isCurrent(generation)) return;
      const snapshot = snapshotEntries(entries);
      if (!this.#isCurrent(generation)) return;
      this.#displayedArchive = authenticatedArchive;
      this.#state = Object.freeze({ phase: "open", entries: snapshot, errorCode: null });
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return;
      const code = fixedErrorCode(error);
      if (!this.#isCurrent(generation)) return;
      this.#state = emptyState("error", code);
      this.#notify();
    }
  }

  lock(): void {
    this.#generation += 1;
    this.#invalidateAuxiliaryReviews();
    this.#forgetArchive();
    this.#state = emptyState("locked");
    try { this.#worker.cancel(); } catch { /* Cleared state stays locked even if cleanup fails. */ }
    this.#notify();
  }

  async #run(allowCreation: boolean): Promise<void> {
    const generation = ++this.#generation;
    this.#invalidateAuxiliaryReviews();
    this.#forgetArchive();
    this.#state = emptyState("busy");
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isCurrent(generation)) return;

      let bytes = await this.#store.read();
      if (!this.#isCurrent(generation)) return;
      if (bytes === null && allowCreation) {
        const candidate = await this.#worker.create();
        if (!this.#isCurrent(generation)) return;
        await this.#store.createIfAbsent(candidate);
        if (!this.#isCurrent(generation)) return;
        // Another tab may have won the atomic create. Always open the saved
        // archive, never the uncommitted candidate or an in-memory substitute.
        bytes = await this.#store.read();
        if (!this.#isCurrent(generation)) return;
        if (bytes === null) throw new Error("OPERATION_FAILED");
      }

      if (bytes === null) {
        this.#state = emptyState("empty");
      } else {
        const authenticatedArchive = copyArchive(bytes);
        if (!this.#isCurrent(generation)) return;
        const entries = await this.#worker.open(new Uint8Array(authenticatedArchive));
        if (!this.#isCurrent(generation)) return;
        const snapshot = snapshotEntries(entries);
        if (!this.#isCurrent(generation)) return;
        this.#displayedArchive = authenticatedArchive;
        this.#state = Object.freeze({ phase: "open", entries: snapshot, errorCode: null });
      }
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return;
      const errorCode = fixedErrorCode(error);
      if (!this.#isCurrent(generation)) return;
      this.#state = emptyState("error", errorCode);
      this.#notify();
    }
  }

  #isCurrent(generation: number): boolean { return generation === this.#generation; }

  #isReviewCurrent(vaultGeneration: number, reviewVersion: number): boolean {
    return vaultGeneration === this.#generation && reviewVersion === this.#reviewVersion
      && this.#state.phase === "open";
  }

  #isRotationReviewCurrent(vaultGeneration: number, reviewVersion: number): boolean {
    return vaultGeneration === this.#generation
      && reviewVersion === this.#rotationReviewVersion
      && this.#state.phase === "open";
  }

  #startConflictReview(phase: "loading"): number {
    this.#invalidateStageReview();
    this.#invalidateRotationReview();
    this.#invalidateConflictReview();
    this.#conflictReviewState = conflictReviewState(phase, this.#reviewVersion);
    return this.#reviewVersion;
  }

  #startRotationReview(phase: "loading"): number {
    this.#invalidateStageReview();
    this.#invalidateConflictReview();
    this.#invalidateRotationReview();
    this.#rotationReviewState = rotationReviewState(phase, this.#rotationReviewVersion);
    return this.#rotationReviewVersion;
  }

  #finishConflictReview(phase: "discarded" | "error", errorCode: string | null): void {
    this.#invalidateConflictReview();
    this.#conflictReviewState = conflictReviewState(
      phase, this.#reviewVersion, EMPTY_CONFLICT_REVIEW_ITEMS, null, errorCode,
    );
  }

  #invalidateConflictReview(): void {
    this.#reviewVersion += 1;
    for (const snapshot of this.#conflictReviewSnapshots.values()) {
      snapshot.expectedBytes.fill(0);
    }
    this.#conflictReviewSnapshots.clear();
    this.#conflictReviewState = conflictReviewState("idle", this.#reviewVersion);
  }

  #invalidateRotationReview(): void {
    this.#rotationReviewVersion += 1;
    this.#rotationReviewSnapshot?.expectedBytes.fill(0);
    this.#rotationReviewSnapshot = undefined;
    this.#rotationReviewState = rotationReviewState("idle", this.#rotationReviewVersion);
  }

  #invalidateAuxiliaryReviews(): void {
    this.#invalidateConflictReview();
    this.#invalidateRotationReview();
    this.#invalidateStageReview();
  }

  #isStageReviewCurrent(generation: number, reviewVersion: number): boolean {
    return generation === this.#generation && reviewVersion === this.#stageReviewVersion
      && this.#state.phase === "open";
  }

  /** UX/session guard only; authenticated Rust admission remains authoritative. */
  #isApiKeyReference(reference: number): boolean {
    return this.#state.phase === "open" && this.#state.entries.some(
      (entry) => entry.reference === reference && entry.credentialType === "api_key",
    );
  }

  #canSaveRotationStage(generation: number): boolean {
    return this.#state.phase === "open" && generation === this.#generation
      && this.#displayedArchive !== undefined && this.#conflictReviewState.phase !== "discarding";
  }

  #invalidateStageReview(): void {
    this.#stageReviewVersion += 1;
    this.#stageReviewSnapshot?.expectedBytes.fill(0);
    this.#stageReviewSnapshot = undefined;
    this.#stageReviewState = stageReviewState("idle", this.#stageReviewVersion);
  }

  #forgetArchive(): void {
    this.#displayedArchive?.fill(0);
    this.#displayedArchive = undefined;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* UI subscribers cannot corrupt the storage operation. */ }
    }
  }
}
