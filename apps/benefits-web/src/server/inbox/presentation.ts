import { CANDIDATE_BATCH_VIEW_SCHEMA, MAX_CANDIDATE_BATCH_DISPLAY, decodeCandidateBatchDisplay,
  type CandidateBatchDisplay } from "../../domain/candidate-batch-view";
import { REVIEW_SCHEMA } from "../review/contracts";
import { INBOX_SCHEMA, type CandidateBatchView } from "./contracts";

/**
 * Trusted internal result AFTER inbox authority/transaction guards, not a request
 * parser or new authorization. Caller supplies a current trusted clock sample.
 * Names/values/remaining IDs may still be personal; this is not anonymization.
 * Expired access is hidden, not physical erasure or recall of returned snapshots.
 */
export function projectCandidateBatch(batch: CandidateBatchView, now: number): CandidateBatchDisplay {
  try {
    if (!Number.isSafeInteger(now) || Object.is(now, -0) || now < 0 || now > 253402300799999
      || batch.schema !== INBOX_SCHEMA || !Array.isArray(batch.candidates)
      || batch.candidates.length > MAX_CANDIDATE_BATCH_DISPLAY) throw new Error();
    const projected = decodeCandidateBatchDisplay({ schema: CANDIDATE_BATCH_VIEW_SCHEMA,
      dataGeneration: batch.dataGeneration, candidates: batch.candidates.map((row) => {
        const state = row.state === "pending" && row.expiresAt <= now ? "expired" : row.state;
        const identity = { candidateId: row.id, candidateRevision: row.revision, state, accessExpiresAt: row.expiresAt };
        if (state !== "pending") return { ...identity, content: null };
        const source = row.content;
        if (!source || source.schema !== REVIEW_SCHEMA || source.evidenceAvailability !== "not-retained") throw new Error();
        return { ...identity, content: {
          serviceName: source.serviceName, extractionConfidence: source.extractionConfidence,
          values: { name: source.values.name, kind: source.values.kind, unit: source.values.unit,
            grantedAmount: source.values.grantedAmount, remainingAmount: source.values.remainingAmount,
            trialDaysStated: source.values.trialDaysStated, remainingDaysStated: source.values.remainingDaysStated,
            expiresAt: source.values.expiresAt, observedAt: source.values.observedAt },
          receivedAt: source.receivedAt, extractedAt: source.extractedAt, reviewReasons: source.reviewReasons,
          evidenceAvailability: source.evidenceAvailability, reviewStatus: "pending-review",
          accountProof: "not-established", currentBalanceProof: "not-established",
        } };
      }) });
    if (projected === null) throw new Error();
    return projected;
  } catch { throw new Error("CANDIDATE_BATCH_PRESENTATION_INVALID"); }
}
