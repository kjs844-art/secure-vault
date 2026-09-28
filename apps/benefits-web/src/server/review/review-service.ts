import {
  PREVIEW_TTL_MS, REVIEW_SCHEMA,
  type BenefitContent, type CandidateRow, type PreviewContent, type PreviewRow, type PreviewView,
  type ReviewAuthority, type ReviewDependencies, type ReviewDraft, type ReviewedBenefitRow,
  type ReviewOperation, type ReviewReceipt, type ReviewResult, type ReviewServiceRow,
  type ReviewTransaction, type ReviewValues,
} from "./contracts";
import {
  ReviewFailure, failReview, parseAuthority, parseCandidateContent, parseConfirm,
  parseDelete, parseDraft, parseId, parseRevision, parseRevoke, parseValues,
} from "./validation";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function persisted<T>(read: () => T): T {
  try { return read(); }
  catch { return failReview("REVIEW_STORE_UNAVAILABLE"); }
}
function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    return failReview("REVIEW_CONFLICT");
  }
  return revision + 1;
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function instant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || new Date(value).toISOString() !== value) return failReview("REVIEW_STORE_UNAVAILABLE");
  return value;
}
function name(value: unknown): string {
  // Reuse bounded label validation without inventing a separate display policy.
  return parseValues({ name: value, kind: "other", unit: null, grantedAmount: null,
    remainingAmount: null, trialDaysStated: null, remainingDaysStated: null,
    expiresAt: null, observedAt: null }).name;
}
function owned<T extends { id: string; ownerId: string; dataGeneration: number; revision: number }>(
  row: T | null, id: string, auth: ReviewAuthority,
): T {
  if (!row || row.id !== id || row.ownerId !== auth.ownerId || row.dataGeneration !== auth.dataGeneration) {
    return failReview("REVIEW_NOT_FOUND");
  }
  persisted(() => parseRevision(row.revision));
  return row;
}
function candidateSnapshot(row: CandidateRow): CandidateRow {
  return persisted(() => {
    if (!["pending", "accepted", "deleted"].includes(row.state)
      || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0 || row.expiresAt > 253402300799999
      || (row.state === "deleted" ? row.content !== null : row.content === null)) {
      return failReview("REVIEW_STORE_UNAVAILABLE");
    }
    return freeze({ id: row.id, ownerId: row.ownerId, dataGeneration: row.dataGeneration,
      revision: row.revision, expiresAt: row.expiresAt, state: row.state,
      content: row.content === null ? null : parseCandidateContent(row.content) });
  });
}
function serviceSnapshot(row: ReviewServiceRow): ReviewServiceRow {
  return persisted(() => {
    if (row.state !== "live" && row.state !== "deleted") return failReview("REVIEW_STORE_UNAVAILABLE");
    return freeze({ id: row.id, ownerId: row.ownerId, dataGeneration: row.dataGeneration,
      revision: row.revision, state: row.state, name: name(row.name) });
  });
}
function previewSnapshot(row: PreviewRow): PreviewRow {
  return persisted(() => {
    if (!["pending", "consumed", "revoked", "deleted"].includes(row.state)
      || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0 || row.expiresAt > 253402300799999
      || ((row.state === "pending" || row.state === "consumed") ? row.content === null : row.content !== null)) {
      return failReview("REVIEW_STORE_UNAVAILABLE");
    }
    let content: PreviewContent | null = null;
    if (row.content !== null) {
      const draft = parseDraft({ candidateId: row.content.candidateId,
        candidateRevision: row.content.candidateRevision, serviceId: row.content.serviceId,
        serviceRevision: row.content.serviceRevision, values: row.content.values });
      if (draft.candidateId !== row.candidateId) return failReview("REVIEW_STORE_UNAVAILABLE");
      content = freeze({ ...draft, serviceName: name(row.content.serviceName),
        source: parseCandidateContent(row.content.source) });
    }
    return freeze({ id: row.id, ownerId: row.ownerId, dataGeneration: row.dataGeneration,
      revision: row.revision, sessionId: parseId(row.sessionId), sessionRevision: parseRevision(row.sessionRevision),
      expiresAt: row.expiresAt, state: row.state, candidateId: parseId(row.candidateId), content });
  });
}
function origins(values: ReviewValues, source: BenefitContent["source"]): BenefitContent["valueOrigins"] {
  const fields = Object.keys(values) as Array<keyof ReviewValues>;
  return freeze(Object.fromEntries(fields.map((field) => [field,
    values[field] === source.values[field] ? "email-extracted" : "user-corrected",
  ])) as Record<keyof ReviewValues, "email-extracted" | "user-corrected">);
}
function benefitSnapshot(row: ReviewedBenefitRow): ReviewedBenefitRow {
  return persisted(() => {
    if (row.state !== "live" && row.state !== "deleted") return failReview("REVIEW_STORE_UNAVAILABLE");
    if (row.state === "deleted") {
      if (row.content !== null || row.deletedAt === null) return failReview("REVIEW_STORE_UNAVAILABLE");
      return freeze({ id: row.id, ownerId: row.ownerId, dataGeneration: row.dataGeneration,
        revision: row.revision, candidateId: parseId(row.candidateId), state: "deleted" as const,
        content: null, deletedAt: instant(row.deletedAt) });
    }
    const raw = row.content;
    if (!raw || row.deletedAt !== null || raw.schema !== REVIEW_SCHEMA
      || raw.candidateId !== row.candidateId || raw.reviewStatus !== "accepted-by-user"
      || raw.accountProof !== "not-established" || raw.currentBalanceProof !== "not-established") {
      return failReview("REVIEW_STORE_UNAVAILABLE");
    }
    const values = parseValues(raw.values);
    const source = parseCandidateContent(raw.source);
    const valueOrigins = origins(values, source);
    // JSON object key order is not a persistence invariant (e.g. JSONB adapters).
    const storedOrigins = raw.valueOrigins;
    const fields = Object.keys(valueOrigins) as Array<keyof ReviewValues>;
    if (!storedOrigins || Object.keys(storedOrigins).length !== fields.length
      || fields.some((field) => !Object.hasOwn(storedOrigins, field) || storedOrigins[field] !== valueOrigins[field])) {
      return failReview("REVIEW_STORE_UNAVAILABLE");
    }
    const content: BenefitContent = freeze({ schema: REVIEW_SCHEMA, serviceId: parseId(raw.serviceId),
      serviceNameAtReview: name(raw.serviceNameAtReview), candidateId: parseId(raw.candidateId),
      candidateRevision: parseRevision(raw.candidateRevision), values, valueOrigins, source,
      reviewedAt: instant(raw.reviewedAt), reviewStatus: "accepted-by-user",
      accountProof: "not-established", currentBalanceProof: "not-established" });
    return freeze({ id: row.id, ownerId: row.ownerId, dataGeneration: row.dataGeneration,
      revision: row.revision, candidateId: row.candidateId, state: "live" as const,
      content, deletedAt: null });
  });
}
function receipt(row: ReviewedBenefitRow, operationId: string, replayed: boolean): ReviewReceipt {
  return freeze({ schema: REVIEW_SCHEMA, dataGeneration: row.dataGeneration, operationId,
    outcome: row.state === "deleted" ? "deleted" : "saved", benefitId: row.id,
    benefitRevision: row.revision, replayed, content: row.content });
}

/**
 * Internal provider-independent confirmation controller. No DB/auth adapter or
 * public route is supplied here. A success is meaningful only when transaction()
 * actually guarantees commit; synthetic adapters are not persistence evidence.
 */
export function createReviewService(deps: ReviewDependencies) {
  async function execute<Input, Output>(input: unknown, parse: (value: unknown) => Input,
    act: (tx: ReviewTransaction, auth: ReviewAuthority, request: Input, clock: () => number,
      guard: () => Promise<void>) => Promise<Output>,
    finalize: (value: Output, now: number) => Output = (value) => value): Promise<ReviewResult<Output>> {
    try {
      // Parse and copy before the first await: callers cannot mutate a reviewed command.
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
        if (!same(auth, current)) return failReview("REVIEW_AUTHORITY_CHANGED");
      };
      const result = await deps.transaction(auth, async (tx) => {
        tx.limitCommitTime(auth.expiresAt);
        await guard();
        const value = await act(tx, auth, request, clock, guard);
        await guard();
        return freeze({ ok: true as const, value });
      });
      // Commit acknowledgement can be delayed too. Do not return a payload to
      // authority revoked while awaiting it; failure is NOT proof of rollback.
      await guard();
      return freeze({ ok: true as const, value: finalize(result.value, clock()) });
    } catch (error) {
      // A commit may have happened before an adapter failure. Never claim rollback.
      return freeze({ ok: false, code: error instanceof ReviewFailure ? error.code : "REVIEW_STORE_UNAVAILABLE" });
    }
  }

  async function loadCandidate(tx: ReviewTransaction, auth: ReviewAuthority, id: string) {
    return candidateSnapshot(owned(await tx.getCandidate(id), id, auth));
  }
  async function loadService(tx: ReviewTransaction, auth: ReviewAuthority, id: string) {
    return serviceSnapshot(owned(await tx.getService(id), id, auth));
  }
  async function loadPreview(tx: ReviewTransaction, auth: ReviewAuthority, id: string) {
    return previewSnapshot(owned(await tx.getPreview(id), id, auth));
  }
  async function loadBenefit(tx: ReviewTransaction, auth: ReviewAuthority, id: string) {
    return benefitSnapshot(owned(await tx.getBenefit(id), id, auth));
  }
  async function replay(tx: ReviewTransaction, auth: ReviewAuthority, operationId: string,
    kind: ReviewOperation["kind"], requestKey: string): Promise<ReviewReceipt | null> {
    const existing = await tx.getOperation(operationId);
    if (existing === null) return null;
    if (existing.ownerId !== auth.ownerId || existing.operationId !== operationId) return failReview("REVIEW_NOT_FOUND");
    if (existing.kind !== kind || existing.requestKey !== requestKey || existing.dataGeneration !== auth.dataGeneration) {
      return failReview("REVIEW_OPERATION_CONFLICT");
    }
    const benefitId = persisted(() => parseId(existing.benefitId));
    return receipt(await loadBenefit(tx, auth, benefitId), operationId, true);
  }
  async function requirePending(tx: ReviewTransaction, auth: ReviewAuthority, draft: ReviewDraft, now: number) {
    const candidate = await loadCandidate(tx, auth, draft.candidateId);
    const service = await loadService(tx, auth, draft.serviceId);
    if (candidate.state !== "pending" || candidate.expiresAt <= now || service.state !== "live"
      || candidate.revision !== draft.candidateRevision || service.revision !== draft.serviceRevision) {
      return failReview("REVIEW_CONFLICT");
    }
    tx.limitCommitTime(candidate.expiresAt);
    return { candidate, service };
  }
  function pendingPreview(preview: PreviewRow, auth: ReviewAuthority, now: number) {
    if (preview.state !== "pending" || preview.content === null) return failReview("REVIEW_PREVIEW_UNAVAILABLE");
    if (preview.revision !== 1) return failReview("REVIEW_CONFLICT");
    if (preview.sessionId !== auth.sessionId || preview.sessionRevision !== auth.sessionRevision) {
      return failReview("REVIEW_AUTHORITY_CHANGED");
    }
    if (preview.expiresAt <= now) return failReview("REVIEW_PREVIEW_EXPIRED");
    return preview.content;
  }

  return Object.freeze({
    preview(input: unknown): Promise<ReviewResult<PreviewView>> {
      return execute(input, parseDraft, async (tx, auth, draft, clock, guard) => {
        const { candidate, service } = await requirePending(tx, auth, draft, clock());
        const content: PreviewContent = freeze({ ...draft, serviceName: service.name, source: candidate.content! });
        await guard();
        const row: PreviewRow = freeze({ id: parseId(deps.newId()), ownerId: auth.ownerId,
          dataGeneration: auth.dataGeneration, revision: 1, sessionId: auth.sessionId,
          sessionRevision: auth.sessionRevision, expiresAt: Math.min(clock() + PREVIEW_TTL_MS, auth.expiresAt, candidate.expiresAt),
          state: "pending", candidateId: candidate.id, content });
        tx.limitCommitTime(row.expiresAt);
        if (!await tx.insertPreview(row)) return failReview("REVIEW_CONFLICT");
        if (clock() >= row.expiresAt) return failReview("REVIEW_PREVIEW_EXPIRED");
        return freeze({ id: row.id, revision: row.revision, expiresAt: row.expiresAt, content,
          accountProof: "not-established" as const, currentBalanceProof: "not-established" as const });
      }, (view, now) => {
        if (view.expiresAt <= now) return failReview("REVIEW_PREVIEW_EXPIRED");
        return view;
      });
    },
    confirm(input: unknown): Promise<ReviewResult<ReviewReceipt>> {
      return execute(input, parseConfirm, async (tx, auth, request, clock, guard) => {
        const requestKey = JSON.stringify(request);
        const previous = await replay(tx, auth, request.operationId, "confirm", requestKey);
        if (previous) return previous;
        const preview = await loadPreview(tx, auth, request.previewId);
        const draft = pendingPreview(preview, auth, clock());
        tx.limitCommitTime(preview.expiresAt);
        const { candidate, service } = await requirePending(tx, auth, draft, clock());
        if (!same(candidate.content, draft.source) || service.name !== draft.serviceName) return failReview("REVIEW_CONFLICT");
        const candidateRevision = nextRevision(candidate.revision);
        const previewRevision = nextRevision(preview.revision);
        await guard();
        pendingPreview(preview, auth, clock());
        const content: BenefitContent = freeze({ schema: REVIEW_SCHEMA, serviceId: service.id,
          serviceNameAtReview: service.name, candidateId: candidate.id, candidateRevision: candidate.revision,
          values: draft.values, valueOrigins: origins(draft.values, draft.source), source: draft.source,
          reviewedAt: new Date(clock()).toISOString(), reviewStatus: "accepted-by-user",
          accountProof: "not-established", currentBalanceProof: "not-established" });
        const benefit: ReviewedBenefitRow = freeze({ id: parseId(deps.newId()), ownerId: auth.ownerId,
          dataGeneration: auth.dataGeneration, revision: 1, state: "live", candidateId: candidate.id,
          content, deletedAt: null });
        if (!await tx.insertBenefit(benefit)
          || !await tx.updateCandidate(freeze({ ...candidate, revision: candidateRevision, state: "accepted" }), candidate.revision)
          || !await tx.updatePreview(freeze({ ...preview, revision: previewRevision, state: "consumed" }), preview.revision)
          || !await tx.insertOperation(freeze({ ownerId: auth.ownerId, operationId: request.operationId,
            dataGeneration: auth.dataGeneration, kind: "confirm", requestKey, benefitId: benefit.id }))) {
          return failReview("REVIEW_CONFLICT");
        }
        pendingPreview(preview, auth, clock());
        return receipt(benefit, request.operationId, false);
      });
    },
    reject(input: unknown): Promise<ReviewResult<{ readonly previewId: string; readonly state: "revoked" }>> {
      return execute(input, parseRevoke, async (tx, auth, request, _clock, guard) => {
        const preview = await loadPreview(tx, auth, request.previewId);
        if (preview.sessionId !== auth.sessionId || preview.sessionRevision !== auth.sessionRevision) {
          return failReview("REVIEW_AUTHORITY_CHANGED");
        }
        if (preview.revision !== request.expectedRevision) return failReview("REVIEW_CONFLICT");
        if (preview.state !== "pending") return failReview("REVIEW_PREVIEW_UNAVAILABLE");
        await guard();
        if (!await tx.updatePreview(freeze({ ...preview, revision: nextRevision(preview.revision),
          state: "revoked", content: null }), preview.revision)) return failReview("REVIEW_CONFLICT");
        return freeze({ previewId: preview.id, state: "revoked" as const });
      });
    },
    remove(input: unknown): Promise<ReviewResult<ReviewReceipt>> {
      return execute(input, parseDelete, async (tx, auth, request, clock, guard) => {
        const requestKey = JSON.stringify(request);
        const previous = await replay(tx, auth, request.operationId, "delete", requestKey);
        if (previous) return previous;
        const benefit = await loadBenefit(tx, auth, request.benefitId);
        if (benefit.revision !== request.expectedRevision || benefit.state !== "live") return failReview("REVIEW_CONFLICT");
        const candidate = await loadCandidate(tx, auth, benefit.candidateId);
        if (candidate.state !== "accepted") return failReview("REVIEW_CONFLICT");
        const benefitRevision = nextRevision(benefit.revision);
        const candidateRevision = nextRevision(candidate.revision);
        await guard();
        const deleted: ReviewedBenefitRow = freeze({ ...benefit, revision: benefitRevision,
          state: "deleted", content: null, deletedAt: new Date(clock()).toISOString() });
        if (!await tx.updateBenefit(deleted, benefit.revision)
          || !await tx.updateCandidate(freeze({ ...candidate, revision: candidateRevision, state: "deleted", content: null }), candidate.revision)) {
          return failReview("REVIEW_CONFLICT");
        }
        await tx.eraseCandidatePreviews(candidate.id);
        if (!await tx.insertOperation(freeze({ ownerId: auth.ownerId, operationId: request.operationId,
          dataGeneration: auth.dataGeneration, kind: "delete", requestKey, benefitId: benefit.id }))) {
          return failReview("REVIEW_CONFLICT");
        }
        return receipt(deleted, request.operationId, false);
      });
    },
  });
}
