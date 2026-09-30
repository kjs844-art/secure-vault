import { syntheticVault } from "../domain/syntheticVault";
import type { VaultCatalogRepository } from "./VaultCatalogRepository";

export class SyntheticVaultCatalogRepository
  implements VaultCatalogRepository
{
  list() {
    return syntheticVault.map(({ metadata }) => metadata);
  }
}
