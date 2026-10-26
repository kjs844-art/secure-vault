import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { normalizeReviewWorkspaceContext, type ReviewWorkspace, type ReviewWorkspaceLease,
  type ReviewWorkspaceSnapshot } from "../../domain/review-client/workspace";
import { createReviewConfirmRequest, createReviewDeleteRequest, createReviewGetRequest,
  createReviewPreviewRequest, createReviewRejectRequest, snapshotReviewRequest,
  type ReviewPreviewRequest, type ReviewRequestValues } from "../../domain/review-client/requests";
import type { ReviewPreparedCommand } from "../../domain/review-client/command-owner";
import { parseReviewDraftFields, toReviewDraftFields, type ReviewDraftFields } from "../../domain/review-draft-form";
import { selectReviewedBenefitHistory, type ReviewedBenefitHistoryMode } from "../../domain/reviewed-benefit-history";
import type { ReviewedBenefitView } from "../../domain/reviewed-benefit-view";
import { useReviewWorkspace, type ReviewWorkspaceReactView } from "../../hooks/useReviewWorkspace";
import { ReviewedBenefitDetails } from "./ReviewedBenefitDetails";

export interface ReviewWorkspacePanelProps {
  readonly workspace: ReviewWorkspace;
  readonly context: unknown;
  /** Exact {bindingId,dataGeneration,request:ReviewPreviewRequest}. Not email source content. */
  readonly draft: unknown;
  readonly referenceTime: number;
  /** Trusted, collision-resistant ID port, called only on an explicit confirm/delete action. */
  readonly createOperationId: () => unknown;
  /** Optional in-memory selection fence. Not authentication; never gates reconciliation of an already sent mutation. */
  readonly validateDraft?: () => boolean;
  /** Rendered only inside the active, scope-bound panel. No second lifecycle hook. */
  readonly children?: ReactNode;
}
const FIELDS: readonly [keyof ReviewRequestValues, string][] = [
  ["name", "혜택 이름"], ["kind", "종류"], ["unit", "단위"], ["grantedAmount", "기록된 지급량"],
  ["remainingAmount", "기록된 잔량"], ["trialDaysStated", "기록된 체험 일수"],
  ["remainingDaysStated", "기록된 남은 일수"], ["expiresAt", "기록된 만료일"], ["observedAt", "관찰 시각"],
];
const KINDS = ["membership", "trial", "coupon", "credit", "point", "storage", "receipt", "expiration", "other"] as const;
const LIST_STATUS = {
  ready: "아직 목록을 불러오지 않았습니다.", loading: "목록을 불러오는 중입니다.",
  more: "불러온 일부 기록입니다. 다음 페이지가 있습니다.",
  retry_required: "같은 페이지를 명시적으로 다시 요청할 수 있습니다.",
  restart_required: "기록이 달라졌거나 순회를 이어갈 수 없습니다. 목록 새로 확인을 선택하세요.",
  end_observed: "이번 순회의 끝을 관찰했습니다. 전체 최신 계정이나 잔액의 증명은 아닙니다.",
} as const;
const text = (value: string | number | null) => value === null ? "모름" : String(value);

function scopedDraft(input: unknown, snapshot: ReviewWorkspaceSnapshot): ReviewPreviewRequest | null {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input), descriptors = Object.getOwnPropertyDescriptors(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 3 || keys.some((key) => typeof key !== "string" || !["bindingId", "dataGeneration", "request"].includes(key))) return null;
    for (const key of keys) {
      const descriptor = descriptors[key as string]!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    }
    const context = normalizeReviewWorkspaceContext({ bindingId: descriptors.bindingId!.value as unknown,
      dataGeneration: descriptors.dataGeneration!.value as unknown });
    if (!context || context.bindingId !== snapshot.context.bindingId || context.dataGeneration !== snapshot.context.dataGeneration) return null;
    const request = snapshotReviewRequest(descriptors.request!.value as unknown);
    return request.action === "preview" ? request : null;
  } catch { return null; }
}

/** Functional integration consumer, not a public route or authentication gate.
 * The host supplies a fresh authorized context and scope-bound selected draft.
 * Current public routes remain closed; all current verification is synthetic. */
export function ReviewWorkspacePanel(props: ReviewWorkspacePanelProps) {
  const titleId = useId(), view = useReviewWorkspace(props.workspace, props.context), snapshot = view.snapshot;
  return <section aria-labelledby={titleId} data-testid="review-workspace-panel"
    data-open={snapshot ? "yes" : "no"} data-preview={snapshot?.preview.phase ?? "closed"} data-list={snapshot?.list.phase ?? "closed"}>
    <h2 id={titleId}>혜택 검토와 저장된 기록</h2>
    <p>메일에서 추출되거나 사용자가 수정한 관찰 기록입니다. 계정 보유 여부와 현재 잔액은 확인되지 않았습니다.</p>
    {snapshot === null ? <p role="status">검토 화면이 닫혀 있습니다. 인증된 새 화면 범위에서 명시적으로 다시 열어야 합니다.</p>
      : <ActivePanel {...props} view={view} snapshot={snapshot} />}
  </section>;
}

interface Owned {
  readonly lease: ReviewWorkspaceLease;
  readonly command: ReviewPreparedCommand;
  readonly view: ReviewWorkspaceReactView;
  readonly action: "preview" | "reject" | "get" | "confirm" | "delete";
  readonly facts?: readonly (readonly [string, string])[];
  busy: boolean;
}
type Saved = Extract<ReviewedBenefitView, { readonly outcome: "saved" }>;
interface DetailSelection {
  readonly lease: ReviewWorkspaceLease;
  readonly record: Saved;
  readonly mode: ReviewedBenefitHistoryMode;
  readonly opener: HTMLButtonElement;
}
function ActivePanel({ workspace, draft: input, referenceTime, createOperationId, validateDraft, children, view, snapshot }:
  ReviewWorkspacePanelProps & { view: ReviewWorkspaceReactView; snapshot: ReviewWorkspaceSnapshot }) {
  const id = useId(), draft = scopedDraft(input, snapshot), sourceKey = draft ? JSON.stringify(draft) : null;
  // A -> B -> A is a new selection, not authority for callbacks from the first A.
  const source = useMemo(() => Object.freeze({ lease: snapshot.lease, sourceKey }), [snapshot.lease, sourceKey]);
  const initial = useMemo(() => draft ? toReviewDraftFields(draft.body.values) : null, [sourceKey]);
  const [form, setForm] = useState<{ source: typeof source; fields: ReviewDraftFields } | null>(null);
  const fields = form?.source === source ? form.fields : initial;
  const [filter, setFilter] = useState<{ lease: ReviewWorkspaceLease; mode: ReviewedBenefitHistoryMode } | null>(null);
  const mode = filter?.lease === snapshot.lease ? filter.mode : "review";
  const [notice, setNotice] = useState<{ lease: ReviewWorkspaceLease; message: string } | null>(null);
  const [operation, setOperation] = useState<{ lease: ReviewWorkspaceLease; busy: boolean } | null>(null);
  const [transientBusy, setTransientBusy] = useState(false);
  const [deletion, setDeletion] = useState<{ lease: ReviewWorkspaceLease; record: Saved; typed: string } | null>(null);
  const [details, setDetails] = useState<DetailSelection | null>(null);
  const detailSelection = useRef<DetailSelection | null>(null), detailNode = useRef<HTMLDivElement | null>(null);
  const mutation = useRef<Owned | null>(null), transient = useRef<Owned | null>(null), starting = useRef(false);
  const marker = useRef<{ source: typeof source; fields: ReviewDraftFields } | null>(null);
  const committed = useRef<{ source: typeof source; fields: ReviewDraftFields | null } | null>(null);
  const alive = useRef(false);
  const statusNode = useRef<HTMLParagraphElement | null>(null);
  const previewNode = useRef<HTMLDivElement | null>(null), deletionNode = useRef<HTMLDivElement | null>(null);
  const previewRef = useCallback((node: HTMLDivElement | null) => {
    if (!node && previewNode.current?.contains(document.activeElement)
      && workspace.getSnapshot()?.lease === source.lease) statusNode.current?.focus();
    previewNode.current = node;
  }, [workspace, source.lease]);
  const deletionRef = useCallback((node: HTMLDivElement | null) => {
    if (!node && deletionNode.current?.contains(document.activeElement)
      && workspace.getSnapshot()?.lease === source.lease) statusNode.current?.focus();
    deletionNode.current = node;
  }, [workspace, source.lease]);
  const detailRef = useCallback((node: HTMLDivElement | null) => {
    if (!node && detailNode.current?.contains(document.activeElement)
      && workspace.getSnapshot()?.lease === source.lease) statusNode.current?.focus({ preventScroll: true });
    detailNode.current = node;
  }, [workspace, source.lease]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const owned of [mutation.current, transient.current]) if (owned) workspace.release(owned.lease, owned.command);
      mutation.current = null; transient.current = null; marker.current = null;
      detailSelection.current = null;
    };
  }, [workspace, snapshot.lease]);
  useLayoutEffect(() => {
    const old = committed.current;
    committed.current = { source, fields };
    if (old?.source.lease === snapshot.lease && old.source !== source) {
      marker.current = null;
      view.cancelPreview();
      const owned = transient.current;
      if (owned?.action === "preview") { transient.current = null; workspace.release(owned.lease, owned.command); setTransientBusy(false); }
    }
  }, [workspace, snapshot.lease, source, fields, view]);

  const current = () => alive.current && workspace.getSnapshot() === snapshot
    && committed.current?.source === source && committed.current.fields === fields;
  const inLifetime = (owned: Owned) => alive.current && workspace.getSnapshot()?.lease === owned.lease;
  const say = (message: string) => setNotice({ lease: snapshot.lease, message });
  const pendingMutation = operation?.lease === snapshot.lease ? operation : null;
  const locked = pendingMutation !== null || transientBusy;
  const preview = snapshot.preview.phase === "ready" && marker.current?.source === source
    && marker.current.fields === fields ? snapshot.preview.preview : null;
  const selectedDeletion = deletion?.lease === snapshot.lease
    && snapshot.list.entries.some((entry) => entry === deletion.record) ? deletion : null;
  const history = selectReviewedBenefitHistory(snapshot.list.entries, mode, referenceTime);
  const selectedDetails = details !== null && detailSelection.current === details
    && details.lease === snapshot.lease && details.mode === mode
    && snapshot.list.entries.some((entry) => entry === details.record)
    && history?.records.some(({ record }) => record.benefitId === details.record.benefitId) ? details : null;
  useLayoutEffect(() => {
    if (details && selectedDetails === null) {
      if (detailSelection.current === details) detailSelection.current = null;
      setDetails((value) => value === details ? null : value);
    }
  }, [details, selectedDetails]);

  function cancelTransient() {
    const old = transient.current; transient.current = null;
    if (old) workspace.release(old.lease, old.command);
    setTransientBusy(false);
  }
  function settleActionFocus() {
    // A native disabled button can lose focus before its group is removed.
    // Move only the explicitly activated decision's focus, never async delivery
    // focus: the user can move elsewhere while the operation is pending.
    if (previewNode.current?.contains(document.activeElement) || deletionNode.current?.contains(document.activeElement)) {
      statusNode.current?.focus({ preventScroll: true });
    }
  }
  function edit(key: keyof ReviewDraftFields, value: string) {
    if (!current() || !fields || sourceKey === null || mutation.current !== null || starting.current) return;
    marker.current = null; view.cancelPreview(); cancelTransient();
    setForm({ source, fields: Object.freeze({ ...fields, [key]: value }) });
    say("내용을 변경했습니다. 저장 전에 새 미리보기가 필요합니다.");
  }
  async function runTransient(action: "preview" | "reject" | "get", request: unknown) {
    if (!current() || mutation.current !== null || starting.current) return;
    cancelTransient();
    if (!current() || mutation.current !== null || starting.current) return;
    const prepared = view.prepare(request);
    if (!current()) {
      if (prepared.kind === "prepared") workspace.release(snapshot.lease, prepared.command);
      return;
    }
    if (prepared.kind !== "prepared") { say("요청을 준비하지 못했습니다. 입력과 화면 범위를 확인하세요."); return; }
    const owned: Owned = { lease: snapshot.lease, command: prepared.command, view, action, busy: true };
    if (action === "reject") settleActionFocus();
    transient.current = owned; setTransientBusy(true);
    if (action === "preview" && fields && sourceKey) marker.current = { source, fields };
    say(action === "preview" ? "미리보기를 요청했습니다. 아직 저장되지 않았습니다." : "요청 결과를 확인하는 중입니다.");
    try {
      const result = await owned.view.execute(owned.command);
      if (!inLifetime(owned) || transient.current !== owned || result.kind === "stale") return;
      if (result.kind === "success") say(action === "preview" ? "미리보기를 확인하세요. 아직 저장되지 않았습니다."
        : action === "reject" ? "이 미리보기를 거절했습니다. 기존 기록과 원본 메일은 삭제하지 않았습니다." : "현재 저장 관찰을 다시 확인했습니다.");
      else say("처리 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 새로 요청할지 확인하세요.");
    } catch {
      if (inLifetime(owned) && transient.current === owned) say("처리 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다.");
    } finally {
      workspace.release(owned.lease, owned.command);
      if (transient.current === owned) { transient.current = null; if (inLifetime(owned)) setTransientBusy(false); }
    }
  }
  function requestPreview() {
    if (!current() || !draft || !fields || mutation.current || starting.current) return;
    if (!selectionCurrent() || !current()) return;
    const parsed = parseReviewDraftFields(fields);
    if (parsed.kind !== "valid") { say("입력을 확인하세요. 숫자·날짜·단위 형식이 맞지 않거나 정밀도를 보존할 수 없습니다."); return; }
    try { void runTransient("preview", createReviewPreviewRequest(draft.body.candidateId, draft.body.candidateRevision,
      draft.body.serviceId, draft.body.serviceRevision, parsed.values)); }
    catch { say("미리보기 요청을 준비하지 못했습니다."); }
  }
  async function executeMutation(owned: Owned) {
    if (!inLifetime(owned) || mutation.current !== owned || owned.busy) return;
    settleActionFocus();
    owned.busy = true; setOperation({ lease: owned.lease, busy: true });
    say("요청을 보냈습니다. 응답이 없어도 서버에 반영됐을 수 있습니다.");
    let result: Awaited<ReturnType<ReviewWorkspaceReactView["execute"]>> | null = null;
    try { result = await owned.view.execute(owned.command); }
    catch { /* Unknown outcome: keep the original command, never infer rollback. */ }
    if (!inLifetime(owned) || mutation.current !== owned || result?.kind === "stale") return;
    owned.busy = false;
    if (result?.kind === "success") {
      workspace.release(owned.lease, owned.command); mutation.current = null; setOperation(null); setDeletion(null);
      say(result.success.kind === "view" && result.success.view.outcome === "deleted"
        ? "현재 결과는 삭제된 기록입니다. 삭제 표식을 유지하며 내용은 표시하지 않습니다."
        : "기록 저장 결과를 확인했습니다. 계정 보유·현재 잔액이 검증된 것은 아닙니다.");
    } else {
      setOperation({ lease: owned.lease, busy: false });
      say("처리 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요. 새 저장·삭제는 보류합니다.");
    }
  }
  function startMutation(action: "confirm" | "delete") {
    if (!current() || mutation.current || transient.current || starting.current) return;
    if (action === "confirm" && (!selectionCurrent() || !current())) return;
    if (action === "confirm" && (!preview || !workspace.checkExpiry(snapshot.lease, snapshot.preview) || !current())) return;
    if (action === "delete" && (!selectedDeletion || selectedDeletion.typed !== "삭제")) return;
    starting.current = true;
    try {
      const operationId = createOperationId();
      if (!current()) return;
      const request = action === "confirm" ? createReviewConfirmRequest(preview!.previewId, operationId)
        : createReviewDeleteRequest(selectedDeletion!.record.benefitId, selectedDeletion!.record.benefitRevision, operationId);
      const prepared = view.prepare(request);
      if (!current()) {
        if (prepared.kind === "prepared") workspace.release(snapshot.lease, prepared.command);
        return;
      }
      if (prepared.kind !== "prepared") { say("요청을 준비하지 못했습니다. 새로고침 후 다시 확인하세요."); return; }
      const facts: readonly (readonly [string, string])[] = action === "confirm"
        ? [["동작", "검토한 내용으로 기록 저장"], ["서비스", preview!.content.serviceName], ["미리보기 ID", preview!.previewId],
          ...FIELDS.map(([key, label]) => [label, text(preview!.content.values[key])] as const)]
        : [["동작", "앱 기록 내용 삭제"], ["혜택 이름", selectedDeletion!.record.content.values.name],
          ["서비스", selectedDeletion!.record.content.serviceNameAtReview], ["기록 ID", selectedDeletion!.record.benefitId],
          ["버전", String(selectedDeletion!.record.benefitRevision)]];
      const owned: Owned = { lease: snapshot.lease, command: prepared.command, view, action, facts, busy: false };
      mutation.current = owned; void executeMutation(owned);
    } catch { say("요청 식별자를 준비하지 못했습니다. 아무 요청도 보내지 않았습니다."); }
    finally { starting.current = false; }
  }
  async function nextPage() {
    if (!current() || starting.current) return;
    const lease = snapshot.lease;
    try {
      const result = await view.nextPage();
      if (!alive.current || workspace.getSnapshot()?.lease !== lease || result.kind === "stale") return;
      say(result.kind === "success" ? "불러온 범위의 기록을 표시합니다." : "목록을 확인하지 못했습니다. 표시된 목록 상태를 확인하세요.");
    } catch {
      if (alive.current && workspace.getSnapshot()?.lease === lease) say("목록을 확인하지 못했습니다. 자동 재시도하지 않습니다.");
    }
  }
  function cancelPreview() {
    if (!current() || mutation.current !== null || starting.current) return;
    marker.current = null; view.cancelPreview(); cancelTransient(); say("화면의 미리보기를 닫았습니다. 서버 거절이나 기록 삭제는 아닙니다.");
  }
  function chooseDeletion(record: Saved) {
    if (!current() || mutation.current !== null || transient.current !== null || starting.current) return;
    // The history selector defensively decodes/copies rows. Retain the exact
    // displayed workspace observation, not that copy, for later identity checks.
    const canonical = snapshot.list.entries.find((entry) => entry.outcome === "saved"
      && entry.benefitId === record.benefitId && entry.benefitRevision === record.benefitRevision
      && entry.dataGeneration === record.dataGeneration);
    if (canonical?.outcome === "saved") setDeletion({ lease: snapshot.lease, record: canonical, typed: "" });
  }
  function openDetails(record: Saved, opener: HTMLButtonElement) {
    if (!current()) return;
    const canonical = snapshot.list.entries.find((entry) => entry.outcome === "saved"
      && entry.benefitId === record.benefitId && entry.benefitRevision === record.benefitRevision
      && entry.dataGeneration === record.dataGeneration);
    if (canonical?.outcome !== "saved") return;
    const selected = { lease: snapshot.lease, record: canonical, mode, opener };
    detailSelection.current = selected;
    setDetails(selected);
  }
  function closeDetails() {
    if (!current() || !selectedDetails || detailSelection.current !== selectedDetails) return;
    // Revoke the old disclosure before focus can synchronously invoke host code.
    detailSelection.current = null;
    if (detailNode.current?.contains(document.activeElement) && selectedDetails.opener.isConnected) {
      selectedDetails.opener.focus({ preventScroll: true });
    }
    setDetails((value) => value === selectedDetails ? null : value);
  }
  function filterRecords(next: ReviewedBenefitHistoryMode) {
    if (!current()) return;
    detailSelection.current = null; setDetails(null);
    setFilter({ lease: snapshot.lease, mode: next });
  }
  function selectionCurrent(): boolean {
    try { if (!validateDraft || validateDraft()) return true; } catch { /* Fail closed without disclosing input. */ }
    marker.current = null; view.cancelPreview(); cancelTransient();
    say("후보 또는 서비스 관찰이 달라졌거나 만료되었습니다. 다시 선택하세요.");
    return false;
  }
  const canPage = ["ready", "more", "retry_required"].includes(snapshot.list.phase);
  return <div data-testid="review-workspace-content" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    {children}
    <button type="button" onClick={() => { if (current()) view.clear(); }}>검토 화면 닫기</button>
    <p>화면을 닫거나 숨기면 요청 기록도 화면 메모리에서 비웁니다. 이미 반영된 서버 작업을 취소하는 것은 아닙니다.</p>
    <p ref={statusNode} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" data-testid="review-panel-status">
      {notice?.lease === snapshot.lease ? notice.message : "선택한 초안의 내용을 검토하세요. 자동 저장하지 않습니다."}</p>
    {pendingMutation && <div role="group" aria-label="결과 재확인">
      <p>원래 요청을 보관 중입니다. 미리보기가 만료되어도 이 요청의 결과를 확인할 수 있습니다.</p>
      <dl>{mutation.current?.facts?.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <button type="button" disabled={pendingMutation.busy} onClick={() => {
        const owned = mutation.current; if (current() && owned) void executeMutation(owned);
      }}>같은 요청의 결과 다시 확인</button>
    </div>}
    {draft && fields ? <form onSubmit={(event) => { event.preventDefault(); requestPreview(); }} aria-label="선택한 혜택 초안">
      <h3>선택한 초안 수정</h3>
      <p>아래 값은 선택한 초안이며 원본 메일 전체가 아닙니다. 비밀번호·API 키·메일 원문을 입력하지 마세요.</p>
      <p id={`${id}-format`}>선택 항목을 비우면 모름입니다. 0은 실제 숫자 0입니다. 날짜는 YYYY-MM-DD 또는 시간대가 있는 ISO 시각을 그대로 입력하세요.</p>
      <fieldset disabled={pendingMutation !== null}><legend>검토할 값</legend>
        {FIELDS.map(([key, label]) => <div key={key}>
          <label htmlFor={`${id}-${key}`}>{label}</label>{key === "kind"
            ? <select id={`${id}-${key}`} value={fields.kind} onChange={(event) => edit(key, event.target.value)}>
              {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
            : <input id={`${id}-${key}`} type="text" value={fields[key]} autoComplete="off" spellCheck={false}
              aria-describedby={`${id}-format`} maxLength={key === "name" ? 160 : key === "unit" ? 40 : key === "expiresAt" || key === "observedAt" ? 40 : 64}
              style={{ maxWidth: "100%", boxSizing: "border-box" }} onChange={(event) => edit(key, event.target.value)} />}
        </div>)}
      </fieldset>
      <button type="submit" disabled={locked}>미리보기 요청</button>
    </form> : <p role="status">이 화면 범위에 맞는 초안이 없습니다. 다른 계정의 초안은 표시하지 않습니다.</p>}
    <button type="button" disabled={snapshot.preview.phase === "idle" || pendingMutation !== null} onClick={cancelPreview}>미리보기 화면 닫기</button>
    {snapshot.preview.phase === "expired" && <p role="status">미리보기가 만료되었습니다. 새 미리보기를 요청하세요.</p>}
    {preview && <div ref={previewRef} role="group" aria-label="저장 전 검토" data-testid="review-panel-preview" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); cancelPreview(); }
    }}>
      <h3>저장 전 미리보기: {preview.content.serviceName}</h3>
      <p>아직 저장되지 않았습니다. 확인 버튼은 아래 값의 기록 저장이며 외부 서비스 이용·결제·잔액 검증이 아닙니다.</p>
      <dl>{FIELDS.map(([key, label]) => <div key={key}><dt>{label}</dt>
        <dd data-testid={`review-panel-preview-${key}`}>{text(preview.content.values[key])}</dd>
        <dd>{preview.content.valueOrigins[key] === "user-corrected" ? "사용자가 수정한 값" : "메일에서 추출된 값"}</dd></div>)}
        <div><dt>수신 시각</dt><dd>{text(preview.content.receivedAt)}</dd></div>
        <div><dt>추출 시각</dt><dd>{preview.content.extractedAt}</dd></div>
        <div><dt>원래 관찰 시각</dt><dd>{text(preview.content.sourceObservedAt)}</dd></div>
        <div><dt>미리보기 만료 시각</dt><dd>{new Date(preview.expiresAt).toISOString()}</dd></div>
      </dl>
      <p>계정 보유 여부: 확인되지 않음 · 현재 잔액: 확인되지 않음 · 원문 보관: 하지 않음</p>
      <ul>{preview.content.reviewReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <button type="button" disabled={locked} onClick={() => void runTransient("reject", createReviewRejectRequest(preview.previewId, preview.previewRevision))}>이 미리보기 거절</button>
      <button type="button" disabled={locked} onClick={() => startMutation("confirm")}>이 내용으로 기록 저장</button>
    </div>}
    <h3>불러온 저장 기록</h3>
    <p role="status">{LIST_STATUS[snapshot.list.phase]}</p>
    <div role="group" aria-label="목록 조회" style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
      <button type="button" disabled={!canPage} onClick={() => void nextPage()}>{snapshot.list.phase === "retry_required" ? "같은 페이지 재시도"
        : snapshot.list.pagesAccepted === 0 ? "첫 페이지 불러오기" : "다음 페이지 불러오기"}</button>
      <button type="button" disabled={snapshot.list.phase !== "loading"} onClick={() => { if (current()) view.cancelPage(); }}>페이지 요청 취소</button>
      <button type="button" onClick={() => { if (current()) view.restartList(); }}>목록 새로 확인</button>
      <button type="button" aria-pressed={mode === "review"} onClick={() => filterRecords("review")}>불러온 확인할 기록</button>
      <button type="button" aria-pressed={mode === "history"} onClick={() => filterRecords("history")}>불러온 지난 기록</button>
    </div>
    {history ? <>
      <p data-testid="review-panel-counts">불러온 기록 {history.totalLiveCount}개 · 확인할 기록 {history.reviewCount}개 · 지난 기록 {history.historyCount}개. 서버 전체 개수가 아닙니다.</p>
      <p>분류 기준 시각: {new Date(history.referenceMs).toISOString()} · 지난 기록 숨김은 삭제가 아닙니다.</p>
      {history.records.length === 0 && <p>불러온 범위에 선택한 기록이 없습니다. 다음 페이지가 남아 있을 수 있습니다.</p>}
      <ul data-testid="review-panel-rows">{history.records.map(({ record }) => <li key={record.benefitId}>
        <h4>{record.content.values.name}</h4><p>검토 당시 서비스: {record.content.serviceNameAtReview}</p>
        <p>기록된 잔량: {text(record.content.values.remainingAmount)} {record.content.values.unit ?? ""}</p>
        <p>기록된 만료일: {text(record.content.values.expiresAt)}</p>
        <button type="button" data-testid="review-detail-toggle"
          aria-expanded={selectedDetails?.record.benefitId === record.benefitId}
          aria-controls={`${id}-observation-${record.benefitId}`}
          onClick={(event) => selectedDetails?.record.benefitId === record.benefitId
            ? closeDetails() : openDetails(record, event.currentTarget)}>저장된 관찰 상세 보기</button>
        {selectedDetails?.record.benefitId === record.benefitId && <div ref={detailRef}
          id={`${id}-observation-${record.benefitId}`} role="group" aria-label="저장된 관찰 상세"
          data-testid="review-record-details" onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); closeDetails(); }
          }}>
          <ReviewedBenefitDetails record={selectedDetails.record} />
          <button type="button" onClick={closeDetails}>상세 보기 닫기</button>
        </div>}
        <button type="button" disabled={locked} onClick={() => void runTransient("get", createReviewGetRequest(record.benefitId))}>이 기록 다시 확인</button>
        <button type="button" disabled={locked} onClick={() => chooseDeletion(record)}>기록 삭제 검토</button>
      </li>)}</ul>
    </> : <p role="alert">분류 기준이나 기록을 확인하지 못했습니다. 기록은 삭제하지 않았습니다.</p>}
    {selectedDeletion && <div ref={deletionRef} role="group" aria-label="앱 기록 삭제 확인" onKeyDown={(event) => {
      if (event.key === "Escape" && pendingMutation === null) { event.preventDefault(); setDeletion(null); }
    }}>
      <h4>삭제 대상: {selectedDeletion.record.content.values.name}</h4>
      <p>서비스: {selectedDeletion.record.content.serviceNameAtReview} · 기록 ID: {selectedDeletion.record.benefitId} · 버전: {selectedDeletion.record.benefitRevision}</p>
      <p id={`${id}-delete-impact`}>이 앱의 해당 기록 내용을 삭제합니다. 되돌리기 기능은 없습니다. 재생 방지용 최소 표식은 남습니다.
        외부 서비스 계정·잔액·원본 메일을 삭제하지 않습니다.</p>
      <button type="button" disabled={pendingMutation !== null} onClick={() => { if (current()) setDeletion(null); }}>삭제 취소</button>
      <label htmlFor={`${id}-delete`}>삭제 확인 문구</label>
      <input id={`${id}-delete`} value={selectedDeletion.typed} autoComplete="off" aria-describedby={`${id}-delete-impact`}
        disabled={locked} maxLength={2} onChange={(event) => {
          if (current() && !locked) setDeletion({ ...selectedDeletion, typed: event.target.value });
        }} />
      <button type="button" disabled={locked || selectedDeletion.typed !== "삭제"} onClick={() => startMutation("delete")}>앱 기록 삭제</button>
    </div>}
  </div>;
}
