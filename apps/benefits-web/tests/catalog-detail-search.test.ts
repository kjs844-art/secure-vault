import assert from "node:assert/strict";
import { test } from "node:test";
import { isCatalogDetailSearchQuery, MAX_CATALOG_DETAIL_QUERY_LENGTH, searchCatalogDetailRows } from "../src/domain/catalog-detail-search.ts";
import { CATALOG_VIEW_SCHEMA, decodeCatalogSuccess, type CatalogServiceProfileView, type CatalogServiceView } from "../src/domain/catalog-client/responses.ts";
import { MAX_CATALOG_VIEW_ENTRIES } from "../src/domain/catalog-client/view-state.ts";

function record(serviceId: string, name: string, extra: Partial<CatalogServiceProfileView> = {}): CatalogServiceView {
  const decoded = decodeCatalogSuccess("get", { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1,
    serviceId, serviceRevision: 1, state: "live", createdAt: 0, updatedAt: 0,
    provenance: "user-reported", accountProof: "not-established", profile: {
      name, provider: null, planName: null, accountLabel: null, timezone: null,
      subscriptionStatus: "unknown", trialEndsAt: null, notes: null, ...extra,
    } });
  assert.equal(decoded?.kind, "view");
  if (decoded?.kind !== "view") throw Error("SYNTHETIC_SEARCH_FIXTURE_INVALID");
  return decoded.view;
}
function ready(rows: readonly CatalogServiceView[], query: unknown) {
  const result = searchCatalogDetailRows(rows, query);
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") throw Error("SYNTHETIC_SEARCH_UNEXPECTED_INVALID");
  return result;
}

test("empty search includes only loaded live rows and preserves their exact order and references", () => {
  const a = record("synthetic-z", "Synthetic Z"), b = record("synthetic-a", "Synthetic A");
  const deleted: CatalogServiceView = Object.freeze({ ...a, state: "deleted", profile: null });
  const missing: CatalogServiceView = Object.freeze({ ...a, profile: null });
  const rows = Object.freeze([a, deleted, b, missing]), result = ready(rows, "");
  assert.deepEqual(result.rows, [a, b]);
  assert.equal(result.rows[0], a); assert.equal(result.rows[1], b);
  assert.equal(result.loadedCount, 2);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.rows));
  assert.deepEqual(rows, [a, deleted, b, missing]);
});

test("name and service ID matching are case-insensitive substrings without reordering", () => {
  const a = record("SYNTHETIC-FIRST-ID", "Alpha service"), b = record("synthetic-second-id", "ALPHABET service");
  const c = record("synthetic-third-id", "Beta service"), rows = [a, b, c];
  assert.deepEqual(ready(rows, "aLpHa").rows, [a, b]);
  assert.deepEqual(ready(rows, "FIRST-id").rows, [a]);
  assert.deepEqual(ready(rows, "second").rows, [b]);
  assert.equal(ready(rows, "missing").loadedCount, 3);
  assert.deepEqual(ready(rows, "missing").rows, []);
});

test("regex metacharacters are literal text, never a pattern", () => {
  const a = record("synthetic-symbols", "Synthetic .*[x]+? service");
  const b = record("synthetic-plain", "Synthetic alphabet service");
  assert.deepEqual(ready([a, b], ".*[x]+?").rows, [a]);
  assert.deepEqual(ready([a, b], "^").rows, []);
  assert.deepEqual(ready([a, b], "[").rows, [a]);
});

test("queries are not trimmed and repeated spaces and whitespace-only values stay literal", () => {
  const a = record("synthetic-double", "Synthetic  service"), b = record("synthetic-single", "Synthetic service");
  assert.deepEqual(ready([a, b], "  ").rows, [a]);
  assert.deepEqual(ready([a, b], "Synthetic service").rows, [b]);
  assert.deepEqual(ready([a, b], " Synthetic").rows, []);
  assert.deepEqual(ready([a, b], "service ").rows, []);
  assert.deepEqual(ready([a, b], "\t").rows, []);
  assert.deepEqual(ready([a, b], "").rows, [a, b]);
});

test("Unicode normalization is not invented by the local display filter", () => {
  const composed = record("synthetic-composed", "Synthetic caf\u00e9");
  const decomposed = record("synthetic-decomposed", "Synthetic cafe\u0301");
  assert.deepEqual(ready([composed, decomposed], "CAF\u00c9").rows, [composed]);
  assert.deepEqual(ready([composed, decomposed], "cafe\u0301").rows, [decomposed]);
});

test("hidden profile values and provenance never become search evidence", () => {
  const row = record("synthetic-visible-id", "Synthetic visible name", {
    provider: "HIDDEN_PROVIDER", planName: "HIDDEN_PLAN", accountLabel: "HIDDEN_ACCOUNT",
    timezone: "Asia/Seoul", subscriptionStatus: "active", trialEndsAt: "2028-02-29", notes: "HIDDEN_NOTES",
  });
  for (const query of ["HIDDEN_PROVIDER", "HIDDEN_PLAN", "HIDDEN_ACCOUNT", "Asia/Seoul", "active",
    "2028-02-29", "HIDDEN_NOTES", "user-reported", "not-established"])
    assert.deepEqual(ready([row], query).rows, []);
  assert.deepEqual(ready([row], "visible").rows, [row]);
});

test("filter does not even read unopened profile fields or row metadata", () => {
  const base = record("synthetic-opaque-id", "Synthetic visible name");
  const profile = { name: base.profile!.name } as CatalogServiceProfileView;
  for (const field of ["provider", "planName", "accountLabel", "timezone", "subscriptionStatus", "trialEndsAt", "notes"])
    Object.defineProperty(profile, field, { get() { throw Error("UNOPENED_SEARCH_FIELD_READ"); } });
  const row = { state: "live", profile: Object.freeze(profile), serviceId: base.serviceId } as CatalogServiceView;
  for (const field of ["schema", "dataGeneration", "serviceRevision", "createdAt", "updatedAt", "provenance", "accountProof"])
    Object.defineProperty(row, field, { get() { throw Error("UNRELATED_SEARCH_METADATA_READ"); } });
  Object.freeze(row);
  assert.equal(ready([row], "VISIBLE").rows[0], row);
  assert.equal(ready([row], "opaque-id").rows[0], row);
  assert.deepEqual(ready([row], "not-present").rows, []);
});

test("duplicate display names do not collapse distinct service row identities", () => {
  const a = record("synthetic-duplicate-first", "Synthetic duplicate");
  const b = record("synthetic-duplicate-second", "Synthetic duplicate");
  const result = ready([b, a], "duplicate");
  assert.equal(result.rows.length, 2); assert.equal(result.rows[0], b); assert.equal(result.rows[1], a);
});

test("query cap is exactly 160 UTF-16 code units including surrogate pairs", () => {
  assert.equal(MAX_CATALOG_DETAIL_QUERY_LENGTH, 160);
  for (const query of ["", "a".repeat(160), "\u{1f600}".repeat(80)])
    assert.equal(isCatalogDetailSearchQuery(query), true);
  for (const query of ["a".repeat(161), "\u{1f600}".repeat(80) + "a"])
    assert.equal(isCatalogDetailSearchQuery(query), false);
  const row = record("synthetic-query-bound", "Synthetic small name");
  assert.equal(searchCatalogDetailRows([row], "a".repeat(160)).kind, "ready");
  assert.equal(searchCatalogDetailRows([row], "a".repeat(161)).kind, "invalid");
});

test("invalid query values are rejected before inspecting rows or calling conversions", () => {
  let conversions = 0, rowReads = 0;
  const input = { toString() { conversions++; throw Error("NO_QUERY_CONVERSION"); } };
  const rows = new Proxy([] as CatalogServiceView[], { get() { rowReads++; throw Error("NO_INVALID_QUERY_ROW_READ"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const query of [undefined, null, false, 1, 1n, Symbol("synthetic"), input, revoked.proxy, "x".repeat(161)]) {
    assert.equal(isCatalogDetailSearchQuery(query), false);
    assert.equal(searchCatalogDetailRows(rows, query).kind, "invalid");
  }
  assert.equal(conversions, 0); assert.equal(rowReads, 0);
});

test("existing catalog bound is enforced before any oversized-array row read", () => {
  assert.equal(MAX_CATALOG_VIEW_ENTRIES, 1000);
  const row = record("synthetic-source-bound", "Synthetic bounded service");
  const allowed = Object.freeze(Array.from({ length: MAX_CATALOG_VIEW_ENTRIES }, () => row));
  const result = ready(allowed, "bounded");
  assert.equal(result.loadedCount, MAX_CATALOG_VIEW_ENTRIES); assert.equal(result.rows.length, MAX_CATALOG_VIEW_ENTRIES);
  const oversized = Array<CatalogServiceView>(MAX_CATALOG_VIEW_ENTRIES + 1);
  Object.defineProperty(oversized, "0", { get() { throw Error("OVERSIZED_SOURCE_ROW_READ"); } });
  assert.equal(searchCatalogDetailRows(oversized, "").kind, "invalid");
  assert.equal(searchCatalogDetailRows({ length: 1 } as unknown as readonly CatalogServiceView[], "").kind, "invalid");
});

test("pure display search has no transport, clock, timer or operation-ID side effects", (t) => {
  const row = record("synthetic-inert-id", "Synthetic inert service"), rows = Object.freeze([row]);
  const before = JSON.stringify(rows);
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_SEARCH_FETCH"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SEARCH_CLOCK"); });
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SEARCH_TIMEOUT"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_SEARCH_INTERVAL"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SEARCH_OPERATION_ID"); });
  assert.equal(ready(rows, "INERT").rows[0], row);
  assert.deepEqual(ready(rows, "absent").rows, []);
  assert.equal(JSON.stringify(rows), before);
});
