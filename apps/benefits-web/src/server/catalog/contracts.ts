import type { SubscriptionStatus } from "../../domain/benefits";
import type { ReviewAuthority, ReviewServiceRow, ReviewTransaction } from "../review/contracts";

export const CATALOG_SCHEMA = "keyatlas.service-catalog.v1" as const;
export const DELETED_SERVICE_NAME = "삭제된 서비스";
export const MAX_SERVICE_PAGE = 50;

/** User-reported organization metadata, never authenticated account proof. */
export interface ServiceProfile {
  readonly name: string;
  readonly provider: string | null;
  readonly planName: string | null;
  readonly accountLabel: string | null;
  readonly timezone: string | null;
  readonly subscriptionStatus: SubscriptionStatus;
  readonly trialEndsAt: string | null;
  readonly notes: string | null;
}
export interface CatalogServiceRow extends ReviewServiceRow {
  // Live: name === profile.name. Deleted: fixed name placeholder + null profile.
  readonly profile: ServiceProfile | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface CatalogOperation {
  readonly ownerId: string;
  readonly dataGeneration: number;
  readonly operationId: string;
  readonly kind: "create" | "update" | "delete";
  readonly requestFingerprint: string;
  readonly serviceId: string;
}
export interface CatalogCursor {
  readonly afterId: string;
  readonly catalogRevision: number;
  readonly dataGeneration: number;
}
export interface CatalogView {
  readonly schema: typeof CATALOG_SCHEMA;
  readonly dataGeneration: number;
  readonly serviceId: string;
  readonly serviceRevision: number;
  readonly state: "live" | "deleted";
  readonly profile: ServiceProfile | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly provenance: "user-reported";
  readonly accountProof: "not-established";
}
export interface CatalogReceipt {
  readonly operationId: string;
  readonly replayed: boolean;
  readonly service: CatalogView;
}
export interface CatalogPage {
  readonly schema: typeof CATALOG_SCHEMA;
  readonly dataGeneration: number;
  readonly catalogRevision: number;
  readonly services: readonly CatalogView[];
  readonly nextCursor: CatalogCursor | null;
}
export interface CatalogTransaction extends ReviewTransaction {
  getCatalogService(id: string): Promise<CatalogServiceRow | null>;
  // Live rows only, ascending binary/code-unit ASCII ID order. Return <= take
  // rows strictly after the ID, under the SAME snapshot as catalog revision.
  listCatalogServices(afterId: string | null, take: number): Promise<readonly CatalogServiceRow[]>;
  getCatalogRevision(): Promise<number>;
  // Every profile/create/delete mutation advances this owner/generation revision.
  advanceCatalogRevision(expected: number): Promise<boolean>;
  insertCatalogService(row: CatalogServiceRow): Promise<boolean>;
  updateCatalogService(row: CatalogServiceRow, expectedRevision: number): Promise<boolean>;
  getCatalogOperation(operationId: string): Promise<CatalogOperation | null>;
  // Unique (ownerId, operationId) in the catalog-command namespace; no raw body.
  insertCatalogOperation(row: CatalogOperation): Promise<boolean>;
  // The reference check and service mutation must be serializable with confirm.
  hasLiveServiceBenefits(serviceId: string): Promise<boolean>;
  // Erase pending preview payloads atomically on edit; all on service deletion.
  eraseServicePreviews(serviceId: string, scope: "pending" | "all"): Promise<void>;
}
export interface CatalogDependencies {
  readAuthority(): Promise<unknown>;
  // Verify actual app owner/session/revision/generation/expiry at entry+commit;
  // enforce deadline, unique, reference constraints and CAS atomically. Roll back
  // all writes on callback failure. Only return after committed completion.
  transaction<T>(authority: ReviewAuthority, action: (tx: CatalogTransaction) => Promise<T>): Promise<T>;
  now(): number;
  newId(): string;
}
