import {
  CATALOG_SCHEMA, DELETED_SERVICE_NAME,
  type CatalogDependencies, type CatalogOperation, type CatalogPage, type CatalogReceipt,
  type CatalogServiceRow, type CatalogTransaction, type CatalogView,
} from "./contracts";
import { parseCreate, parseGet, parseList, parseRemove, parseServiceProfile, parseUpdate } from "./validation";
import type { ReviewAuthority, ReviewResult } from "../review/contracts";
import { ReviewFailure, failReview, parseAuthority, parseId, parseRevision } from "../review/validation";

function persisted<T>(read: () => T): T {
  try { return read(); }
  catch { return failReview("REVIEW_STORE_UNAVAILABLE"); }
}
function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    return failReview("REVIEW_CONFLICT");
  }
  return value + 1;
}
function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) return failReview("REVIEW_STORE_UNAVAILABLE");
  return value;
}
function snapshot(row: CatalogServiceRow | null, id: string, auth: ReviewAuthority): CatalogServiceRow {
  if (!row || row.id !== id || row.ownerId !== auth.ownerId || row.dataGeneration !== auth.dataGeneration) {
    return failReview("REVIEW_NOT_FOUND");
  }
  return persisted(() => {
    const createdAt = timestamp(row.createdAt);
    const updatedAt = timestamp(row.updatedAt);
    const profile = row.profile === null ? null : parseServiceProfile(row.profile);
    if ((row.state !== "live" && row.state !== "deleted") || updatedAt < createdAt
      || (row.state === "live" ? profile === null || row.name !== profile.name
        : profile !== null || row.name !== DELETED_SERVICE_NAME)) return failReview("REVIEW_STORE_UNAVAILABLE");
    return Object.freeze({ id: parseId(row.id), ownerId: auth.ownerId, dataGeneration: auth.dataGeneration,
      revision: parseRevision(row.revision), state: row.state, name: row.name, profile, createdAt, updatedAt });
  });
}
function view(row: CatalogServiceRow): CatalogView {
  return Object.freeze({ schema: CATALOG_SCHEMA, dataGeneration: row.dataGeneration,
    serviceId: row.id, serviceRevision: row.revision, state: row.state, profile: row.profile,
    createdAt: row.createdAt, updatedAt: row.updatedAt, provenance: "user-reported", accountProof: "not-established" });
}
function receipt(row: CatalogServiceRow, operationId: string, replayed: boolean): CatalogReceipt {
  return Object.freeze({ operationId, replayed, service: view(row) });
}
async function fingerprint(input: unknown): Promise<string> {
  // Input is the bounded immutable canonical parser projection, never raw request JSON.
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Internal organization metadata controller, not a public route or actual DB/auth adapter. */
export function createServiceCatalog(deps: CatalogDependencies) {
  async function execute<Input, Output>(input: unknown, parse: (value: unknown) => Input,
    act: (tx: CatalogTransaction, auth: ReviewAuthority, request: Input, clock: () => number) => Promise<Output>,
  ): Promise<ReviewResult<Output>> {
    try {
      const request = parse(input);
      let lastTime = -1;
      const clock = () => {
        const time = deps.now();
        if (!Number.isSafeInteger(time) || time < lastTime || time < 0 || time > 253402300799999) {
          return failReview("REVIEW_AUTHORITY_CHANGED");
        }
        lastTime = time;
        return time;
      };
      const auth = parseAuthority(await deps.readAuthority(), clock());
      const guard = async () => {
        let current: ReviewAuthority;
        try { current = parseAuthority(await deps.readAuthority(), clock()); }
        catch { return failReview("REVIEW_AUTHORITY_CHANGED"); }
        if (JSON.stringify(auth) !== JSON.stringify(current)) return failReview("REVIEW_AUTHORITY_CHANGED");
      };
      const value = await deps.transaction(auth, async (tx) => {
        tx.limitCommitTime(auth.expiresAt);
        await guard();
        const result = await act(tx, auth, request, clock);
        await guard();
        return result;
      });
      // Delayed acknowledgement may outlive the session. Suppress payload, but do
      // not claim this failure rolled back an already committed operation.
      await guard();
      return Object.freeze({ ok: true, value });
    } catch (error) {
      return Object.freeze({ ok: false, code: error instanceof ReviewFailure ? error.code : "REVIEW_STORE_UNAVAILABLE" });
    }
  }
  async function load(tx: CatalogTransaction, auth: ReviewAuthority, id: string) {
    return snapshot(await tx.getCatalogService(id), id, auth);
  }
  async function replay(tx: CatalogTransaction, auth: ReviewAuthority, operationId: string,
    kind: CatalogOperation["kind"], requestFingerprint: string): Promise<CatalogReceipt | null> {
    const previous = await tx.getCatalogOperation(operationId);
    if (previous === null) return null;
    if (previous.ownerId !== auth.ownerId || previous.operationId !== operationId) return failReview("REVIEW_NOT_FOUND");
    if (previous.dataGeneration !== auth.dataGeneration || previous.kind !== kind
      || previous.requestFingerprint !== requestFingerprint) return failReview("REVIEW_OPERATION_CONFLICT");
    const id = persisted(() => parseId(previous.serviceId));
    return receipt(await load(tx, auth, id), operationId, true);
  }
  async function revision(tx: CatalogTransaction): Promise<number> {
    const value = await tx.getCatalogRevision();
    return persisted(() => parseRevision(value));
  }
  async function record(tx: CatalogTransaction, auth: ReviewAuthority, row: CatalogServiceRow,
    operationId: string, kind: CatalogOperation["kind"], requestFingerprint: string, collectionRevision: number) {
    nextRevision(collectionRevision);
    if (!await tx.advanceCatalogRevision(collectionRevision)
      || !await tx.insertCatalogOperation(Object.freeze({ ownerId: auth.ownerId, dataGeneration: auth.dataGeneration,
        operationId, kind, requestFingerprint, serviceId: row.id }))) return failReview("REVIEW_CONFLICT");
    return receipt(row, operationId, false);
  }
  function requireLive(row: CatalogServiceRow, expectedRevision: number, tx: CatalogTransaction) {
    if (row.state !== "live" || row.revision !== expectedRevision) return failReview("REVIEW_CONFLICT");
    tx.requireServiceVersion(row.id, expectedRevision);
  }
  function updatedTime(row: CatalogServiceRow, clock: () => number) {
    const now = clock();
    if (now < row.updatedAt) return failReview("REVIEW_CONFLICT");
    return now;
  }

  return Object.freeze({
    create(input: unknown) {
      return execute(input, parseCreate, async (tx, auth, request, clock): Promise<CatalogReceipt> => {
        const digest = await fingerprint(request);
        const previous = await replay(tx, auth, request.operationId, "create", digest);
        if (previous) return previous;
        const collectionRevision = await revision(tx);
        const now = clock();
        const id = persisted(() => parseId(deps.newId()));
        const row: CatalogServiceRow = Object.freeze({ id, ownerId: auth.ownerId, dataGeneration: auth.dataGeneration,
          revision: 1, state: "live", name: request.profile.name, profile: request.profile, createdAt: now, updatedAt: now });
        // Never auto-deduplicate on display name; two accounts may use one service.
        if (!await tx.insertCatalogService(row)) return failReview("REVIEW_CONFLICT");
        return record(tx, auth, row, request.operationId, "create", digest, collectionRevision);
      });
    },
    update(input: unknown) {
      return execute(input, parseUpdate, async (tx, auth, request, clock): Promise<CatalogReceipt> => {
        const digest = await fingerprint(request);
        const previous = await replay(tx, auth, request.operationId, "update", digest);
        if (previous) return previous;
        const current = await load(tx, auth, request.serviceId);
        requireLive(current, request.expectedRevision, tx);
        const collectionRevision = await revision(tx);
        const row: CatalogServiceRow = Object.freeze({ ...current, name: request.profile.name, profile: request.profile,
          revision: nextRevision(current.revision), updatedAt: updatedTime(current, clock) });
        if (!await tx.updateCatalogService(row, current.revision)) return failReview("REVIEW_CONFLICT");
        await tx.eraseServicePreviews(row.id, "pending");
        return record(tx, auth, row, request.operationId, "update", digest, collectionRevision);
      });
    },
    remove(input: unknown) {
      return execute(input, parseRemove, async (tx, auth, request, clock): Promise<CatalogReceipt> => {
        const digest = await fingerprint(request);
        const previous = await replay(tx, auth, request.operationId, "delete", digest);
        if (previous) return previous;
        const current = await load(tx, auth, request.serviceId);
        requireLive(current, request.expectedRevision, tx);
        if (await tx.hasLiveServiceBenefits(current.id)) return failReview("REVIEW_CONFLICT");
        const collectionRevision = await revision(tx);
        const row: CatalogServiceRow = Object.freeze({ ...current, state: "deleted", profile: null, name: DELETED_SERVICE_NAME,
          revision: nextRevision(current.revision), updatedAt: updatedTime(current, clock) });
        if (!await tx.updateCatalogService(row, current.revision)) return failReview("REVIEW_CONFLICT");
        await tx.eraseServicePreviews(row.id, "all");
        return record(tx, auth, row, request.operationId, "delete", digest, collectionRevision);
      });
    },
    get(input: unknown) {
      return execute(input, parseGet, async (tx, auth, request) => view(await load(tx, auth, request.serviceId)));
    },
    list(input: unknown) {
      return execute(input, parseList, async (tx, auth, request): Promise<CatalogPage> => {
        const collectionRevision = await revision(tx);
        const { cursor, limit } = request;
        if (cursor && (cursor.dataGeneration !== auth.dataGeneration || cursor.catalogRevision !== collectionRevision)) {
          return failReview("REVIEW_CONFLICT");
        }
        const rows = await tx.listCatalogServices(cursor?.afterId ?? null, limit + 1);
        if (!Array.isArray(rows) || rows.length > limit + 1) return failReview("REVIEW_STORE_UNAVAILABLE");
        let after = cursor?.afterId ?? "";
        const projected: CatalogView[] = [];
        for (const raw of rows) {
          const row = snapshot(raw, raw.id, auth);
          if (row.state !== "live" || row.id <= after) return failReview("REVIEW_STORE_UNAVAILABLE");
          after = row.id;
          projected.push(view(row));
        }
        const services = Object.freeze(projected.slice(0, limit));
        const nextCursor = projected.length > limit ? Object.freeze({ afterId: services[services.length - 1]!.serviceId,
          catalogRevision: collectionRevision, dataGeneration: auth.dataGeneration }) : null;
        return Object.freeze({ schema: CATALOG_SCHEMA, dataGeneration: auth.dataGeneration,
          catalogRevision: collectionRevision, services, nextCursor });
      });
    },
  });
}
