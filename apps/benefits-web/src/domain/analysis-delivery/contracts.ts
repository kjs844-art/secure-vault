export const CANDIDATE_BATCH_SAVED_SCHEMA = "keyatlas.candidate-batch-saved.v1" as const;

/** A saved observation/lookup locator, never authentication or account proof. */
export interface CandidateBatchSavedReceipt {
  readonly schema: typeof CANDIDATE_BATCH_SAVED_SCHEMA;
  readonly state: "saved";
  readonly batchReference: string;
  readonly dataGeneration: number;
}
export interface AnalysisDeliveryContext {
  readonly bindingId: string;
  readonly dataGeneration: number;
}
export interface AnalysisDeliveryBinding {
  /** External workspace identity only; never frozen or changed by this owner. */
  readonly lease: object;
  readonly context: AnalysisDeliveryContext;
}
declare const ticketBrand: unique symbol;
export type AnalysisDeliveryTicket = { readonly [ticketBrand]: true };
export type AnalysisDeliveryPhase = "idle" | "receiving" | "saved" | "selected" | "unconfirmed" | "expired";
export interface AnalysisDeliverySnapshot extends AnalysisDeliveryBinding {
  readonly phase: AnalysisDeliveryPhase;
  readonly receipt: CandidateBatchSavedReceipt | null;
  readonly selectedReference: string | null;
}
