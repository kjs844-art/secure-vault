import type { CatalogServiceView } from "./catalog-client/responses";
import { MAX_CATALOG_VIEW_ENTRIES } from "./catalog-client/view-state";

export const MAX_CATALOG_DETAIL_QUERY_LENGTH = 160;
export type CatalogDetailSearchResult =
  | { readonly kind: "ready"; readonly rows: readonly CatalogServiceView[]; readonly loadedCount: number }
  | { readonly kind: "invalid" };
const INVALID: CatalogDetailSearchResult = Object.freeze({ kind: "invalid" });

export function isCatalogDetailSearchQuery(query: unknown): query is string {
  return typeof query === "string" && query.length <= MAX_CATALOG_DETAIL_QUERY_LENGTH;
}

/** A local display filter over an already validated, bounded source. This is not
 * a DTO decoder or authority gate. Only visible live names/IDs are searched, with
 * no trim, Unicode normalization, regex, clock or I/O. Original row identity and
 * order survive; private profile details must never become search evidence. */
export function searchCatalogDetailRows(rows: readonly CatalogServiceView[], query: unknown): CatalogDetailSearchResult {
  if (!isCatalogDetailSearchQuery(query) || !Array.isArray(rows) || rows.length > MAX_CATALOG_VIEW_ENTRIES) return INVALID;
  const needle = query.toLowerCase(), matches: CatalogServiceView[] = [];
  let loadedCount = 0;
  for (const row of rows) {
    if (row.state !== "live" || row.profile === null) continue;
    loadedCount++;
    if (row.profile.name.toLowerCase().includes(needle) || row.serviceId.toLowerCase().includes(needle)) matches.push(row);
  }
  return Object.freeze({ kind: "ready", rows: Object.freeze(matches), loadedCount });
}
