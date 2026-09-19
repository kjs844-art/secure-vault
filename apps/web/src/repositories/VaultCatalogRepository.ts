import type { VaultItemMetadata } from "../domain/vault";

/**
 * Read-only catalog boundary. Secret material intentionally has no place in
 * this contract, so list and AI features cannot request it by accident.
 */
export interface VaultCatalogRepository {
  list(): readonly VaultItemMetadata[];
}
