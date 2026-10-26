import { decodeCatalogSuccess, type CatalogServiceView } from "../../src/domain/catalog-client/responses.ts";
import type { CandidateBatchDisplay } from "../../src/domain/candidate-batch-view.ts";
import { createServiceCatalog } from "../../src/server/catalog/service-catalog.ts";
import { createCandidateInbox } from "../../src/server/inbox/candidate-inbox.ts";
import { createCandidateBatchReferences } from "../../src/server/inbox/batch-references.ts";
import { projectCandidateBatch } from "../../src/server/inbox/presentation.ts";
import { type MailAnalysisAdapters } from "../../src/server/mail/run-analysis.ts";
import { deliverMailAnalysis } from "../../src/server/mail/deliver-analysis.ts";
import type { ReviewResult } from "../../src/server/review/contracts.ts";
import { REVIEW_NOW, analysisAuthority, createReviewMemoryStore, reviewAuthority, stagingGrant } from "./review-memory-store.ts";

// Server-test support only. Serialize ONLY batch/services, never this fixture,
// its store, raw mail, private analysis authority, grants or operation metadata.
// Real orchestration + synthetic in-memory ports is not real Gmail/auth/DB proof.
function successful<T>(result: ReviewResult<T>): T {
  if (!result.ok) throw new Error(`CANDIDATE_SELECTION_FIXTURE_${result.code}`);
  return result.value;
}

export async function createCandidateSelectionFixture(now = REVIEW_NOW, pendingWindowMs = 86400000, newReference?: () => string, seedServices = true) {
  if (typeof seedServices !== "boolean") throw new Error("CANDIDATE_SELECTION_FIXTURE_SEED_INVALID");
  if (!Number.isSafeInteger(now) || Object.is(now, -0) || now < 0 || now > 253402214399999) {
    throw new Error("CANDIDATE_SELECTION_FIXTURE_CLOCK_INVALID");
  }
  if (!Number.isSafeInteger(pendingWindowMs) || pendingWindowMs < 1 || pendingWindowMs > 86400000) {
    throw new Error("CANDIDATE_SELECTION_FIXTURE_WINDOW_INVALID");
  }
  const store = createReviewMemoryStore();
  // Remove the support factory's unrelated seeds before running any operation.
  // Every candidate/service used below is then created by its real controller.
  store.rows.candidates.clear();
  store.rows.services.clear();
  store.controls.now = now;
  store.controls.authority = reviewAuthority({ expiresAt: now + 600000 });
  const authority = analysisAuthority({ sessionExpiresAt: now + 600000, grantExpiresAt: now + 600000 });
  store.controls.analysisAuthority = authority;
  store.controls.stagingGrant = stagingGrant({ expiresAt: now + 600000, pendingAccessUntil: now + pendingWindowMs });

  const catalog = createServiceCatalog(store.catalogDependencies);
  for (const [index, name] of (seedServices ? ["Synthetic Service", "Synthetic Service Plus"] : []).entries()) {
    successful(await catalog.create({ operationId: `synthetic-selection-service-${index + 1}`, decision: "create",
      profile: { name, provider: null, planName: null, accountLabel: null, timezone: null,
        subscriptionStatus: "unknown", trialEndsAt: null, notes: null } }));
  }
  const catalogPage = decodeCatalogSuccess("list", successful(await catalog.list({ limit: 50, cursor: null })));
  if (catalogPage?.kind !== "page" || catalogPage.page.services.length !== (seedServices ? 2 : 0) || catalogPage.page.nextCursor !== null) {
    throw new Error("CANDIDATE_SELECTION_FIXTURE_CATALOG_INVALID");
  }
  const services: readonly CatalogServiceView[] = catalogPage.page.services;

  const bodies = ["Synthetic Service grants 100 credits.",
    "Synthetic Service Plus offers Synthetic trial offer for 14 days."];
  let quotaCalls = 0, mailboxCalls = 0, analysisCalls = 0;
  const adapters: MailAnalysisAdapters = {
    readAuthority: async () => ({ ...authority, grantOwnerId: authority.ownerId,
      grantSessionId: authority.sessionId, grantMailboxBindingId: authority.mailboxBindingId }),
    reserveQuota: async ({ authority: current }) => { quotaCalls++; return ({ status: "granted", ownerId: current.ownerId,
      sessionId: current.sessionId, sessionRevision: current.sessionRevision, dataGeneration: current.dataGeneration,
      mailboxBindingId: current.mailboxBindingId, recipientId: current.recipientId, policyVersion: current.policyVersion,
      grantId: current.grantId, grantRevision: current.grantRevision, operationId: current.operationId, remaining: 0 }); },
    readMailbox: async () => { mailboxCalls++; return JSON.stringify(bodies.map((body, index) => ({
      id: `synthetic-selection-mail-not-retained-${index + 1}`, payload: { mimeType: "text/plain",
        headers: [{ name: "Subject", value: index === 0 ? "Synthetic Service credit notice" : "Synthetic Service Plus trial notice" }],
        body: { data: Buffer.from(body).toString("base64url") } },
    }))); },
    analyze: async () => { analysisCalls++; return JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: [
      { evidence_message_index: 0, confidence: "high", benefit_kind: "credit",
        service_name: { value: "Synthetic Service", part: "subject", quote: "Synthetic Service" },
        benefit_name: null, unit: { value: "credits", part: "body", quote: "100 credits" },
        granted_amount: { value: 100, part: "body", quote: "grants 100 credits" }, remaining_amount: null,
        trial_days: null, remaining_days: null, expires_at: null, observed_at: null },
      { evidence_message_index: 1, confidence: "medium", benefit_kind: "trial",
        service_name: { value: "Synthetic Service Plus", part: "subject", quote: "Synthetic Service Plus" },
        benefit_name: { value: "Synthetic trial offer", part: "body", quote: "Synthetic trial offer" },
        unit: null, granted_amount: null, remaining_amount: null,
        trial_days: { value: 14, part: "body", quote: "14 days" }, remaining_days: null, expires_at: null, observed_at: null },
    ] }); },
    now: () => store.controls.now,
  };
  const referenceDependencies = { ...store.referenceDependencies,
    ...(newReference === undefined ? {} : { newReference }) };
  // The product coordinator carries the actual runner object directly into the
  // same-transaction staging/reference path. No reconstructed handoff or seed.
  const delivery = await deliverMailAnalysis({ analysis: adapters, references: referenceDependencies }, {
    operationId: authority.operationId, mailboxBindingId: authority.mailboxBindingId, recipientId: authority.recipientId,
  });
  if (!delivery.ok) throw new Error(`CANDIDATE_SELECTION_FIXTURE_${delivery.code}`);
  const inbox = createCandidateInbox(store.inboxDependencies);
  const references = createCandidateBatchReferences(referenceDependencies);
  const locator = Object.freeze({ batchReference: delivery.value.batchReference, dataGeneration: delivery.value.dataGeneration });
  const refresh = async (): Promise<CandidateBatchDisplay> => projectCandidateBatch(
    successful(await inbox.listBatch({ analysisOperationId: authority.operationId })), store.controls.now);
  const batch = await refresh();
  const readAnalysisCounts = () => Object.freeze({ quota: quotaCalls, mailbox: mailboxCalls, analysis: analysisCalls });
  return Object.freeze({ store, inbox, references, locator, completionReceipt: delivery.value, batch, services, refresh, readAnalysisCounts });
}
