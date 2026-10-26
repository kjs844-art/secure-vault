import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createCatalogCreateRequest, type CatalogCreateRequest } from "../../domain/catalog-client/requests";
import { createCatalogViewStore, type CatalogViewLease } from "../../domain/catalog-client/view-store";
import type { CatalogViewCommand, CatalogViewControllerConfig } from "../../domain/catalog-client/view-controller";
import type { CatalogCallResult } from "../../domain/catalog-client/client";
import { normalizeReviewWorkspaceContext, type ReviewWorkspace, type ReviewWorkspaceLease } from "../../domain/review-client/workspace";

export interface CatalogServiceCreatePanelProps {
  readonly workspace: ReviewWorkspace;
  readonly context: unknown;
  /** Stable operator-supplied transport; not an authentication implementation.
   * Replacing it requires a fresh outer review lease. */
  readonly client: CatalogViewControllerConfig;
  readonly createOperationId: () => unknown;
  /** Clear the separately loaded selection. This callback must not auto-fetch. */
  readonly onCatalogInvalidated: (lease: ReviewWorkspaceLease) => void;
  readonly onAuthorityRejected: (lease: ReviewWorkspaceLease) => void;
}
const serverSnapshot = (): null => null;
interface Fields {
  readonly name: string; readonly provider: string;
  readonly planName: string; readonly accountLabel: string;
  readonly timezone: string; readonly subscriptionStatus: string; readonly trialEndsAt: string;
  readonly notes: string;
}
const EMPTY: Fields = Object.freeze({ name: "", provider: "", planName: "", accountLabel: "",
  timezone: "", subscriptionStatus: "unknown", trialEndsAt: "", notes: "" });
type Phase = "preview" | "pending" | "uncertain";
const SUBSCRIPTION_OPTIONS = [
  ["unknown", "모름"], ["active", "사용 중으로 기록"], ["trial", "체험 중으로 기록"],
  ["trial_ended", "체험 종료로 기록"], ["paused", "일시 중지로 기록"], ["cancelled", "해지로 기록"],
] as const;
const PROFILE_LABELS = [
  ["name", "서비스 이름"], ["provider", "제공자"], ["planName", "요금제 이름"],
  ["accountLabel", "계정 표시 이름"], ["timezone", "시간대"], ["subscriptionStatus", "구독 상태"],
  ["trialEndsAt", "체험 종료일"], ["notes", "메모"],
] as const;

/** A narrow create consumer using the existing command store, not another
 * command framework. One outer review lease owns it; receipt uncertainty is
 * reconciled only with the same immutable request/opaque command. */
export function CatalogServiceCreatePanel(props: CatalogServiceCreatePanelProps) {
  const id = useId(), workspace = props.workspace;
  const store = useMemo(() => createCatalogViewStore(props.client), [props.client]);
  const active = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);
  const catalog = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
  const context = normalizeReviewWorkspaceContext(props.context);
  const bindingId = context?.bindingId ?? null, generation = context?.dataGeneration ?? null;
  const lease = active && active.context.bindingId === bindingId && active.context.dataGeneration === generation ? active.lease : null;
  const frame = useMemo(() => Object.freeze({ workspace, store, lease, bindingId, generation }), [workspace, store, lease, bindingId, generation]);
  type Frame = typeof frame;
  type Pending = { readonly frame: Frame; readonly catalogLease: CatalogViewLease; readonly command: CatalogViewCommand;
    readonly request: CatalogCreateRequest; readonly fields: Fields; phase: Phase };
  type Outcome = { readonly frame: Frame; readonly serviceId: string; readonly replayed: boolean };
  const committed = useRef<Frame | null>(null);
  const previousCommit = useRef<Frame | null>(null);
  const owned = useRef<{ frame: Frame; catalogLease: CatalogViewLease } | null>(null);
  const command = useRef<Pending | null>(null), preparing = useRef(false);
  const callbacks = useRef({ createOperationId: props.createOperationId, onCatalogInvalidated: props.onCatalogInvalidated,
    onAuthorityRejected: props.onAuthorityRejected });
  const [form, setForm] = useState<{ frame: Frame; fields: Fields } | null>(null);
  const fields = form?.frame === frame ? form.fields : EMPTY;
  const currentFields = useRef<Fields | null>(null);
  const [operation, setOperation] = useState<{ record: Pending; phase: Phase } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const currentOutcome = useRef<Outcome | null>(null);
  const [notice, setNotice] = useState<{ frame: Frame; text: string } | null>(null);
  const [transportClosed, setTransportClosed] = useState(false);
  const status = useRef<HTMLParagraphElement | null>(null), formNode = useRef<HTMLFieldSetElement | null>(null);
  const decisionNode = useRef<HTMLDivElement | null>(null);
  const resultNode = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    committed.current = frame; currentFields.current = fields;
    callbacks.current = { createOperationId: props.createOperationId, onCatalogInvalidated: props.onCatalogInvalidated,
      onAuthorityRejected: props.onAuthorityRejected };
    const previous = previousCommit.current;
    previousCommit.current = frame;
    if (lease !== null && previous?.workspace === workspace && previous.lease === lease && previous.store !== store) {
      // A changed transport is a changed security boundary, not a harmless form
      // reset. End the outer lease instead of losing an uncertain command and
      // silently enabling a second create with a new operation ID.
      setTransportClosed(true); workspace.deactivate(lease);
    } else if (lease !== null && previous?.lease !== lease) setTransportClosed(false);
  });
  useLayoutEffect(() => {
    let retired = false, catalogLease: CatalogViewLease | null = null;
    const matches = () => {
      const current = workspace.getSnapshot();
      return lease !== null && current?.lease === lease && current.context.bindingId === bindingId
        && current.context.dataGeneration === generation;
    };
    const retire = () => {
      retired = true;
      if (owned.current?.frame === frame) owned.current = null;
      if (command.current?.frame === frame) command.current = null;
      if (currentOutcome.current?.frame === frame) currentOutcome.current = null;
      if (catalogLease) store.deactivate(catalogLease);
    };
    const detach = workspace.subscribe(() => { if (!matches()) retire(); });
    if (matches() && bindingId !== null && generation !== null) {
      catalogLease = store.activate({ bindingId, dataGeneration: generation });
      if (!retired && matches() && catalogLease) owned.current = { frame, catalogLease };
      else retire();
    }
    return () => {
      detach(); retire();
      if (committed.current === frame) { committed.current = null; currentFields.current = null; }
    };
  }, [frame, workspace, store, lease, bindingId, generation]);

  const visible = lease && catalog && catalog.context.bindingId === bindingId && catalog.context.dataGeneration === generation
    && owned.current?.frame === frame && owned.current.catalogLease === catalog.lease ? catalog : null;
  const pending = operation?.record.frame === frame && command.current === operation.record ? operation : null;
  const completed = outcome?.frame === frame ? outcome : null;
  const row = completed && visible ? visible.state.entries.find((entry) => entry.serviceId === completed.serviceId) ?? null : null;
  const phase = !visible ? "closed" : pending?.phase ?? (completed ? "completed" : "editing");
  const current = () => {
    const currentWorkspace = workspace.getSnapshot(), binding = owned.current, latest = store.getSnapshot();
    return committed.current === frame && lease !== null && currentWorkspace?.lease === lease
      && currentWorkspace.context.bindingId === bindingId && currentWorkspace.context.dataGeneration === generation
      && binding?.frame === frame && latest?.lease === binding.catalogLease;
  };
  const owns = (record: Pending) => current() && record.frame === frame && command.current === record
    && owned.current?.catalogLease === record.catalogLease;
  const say = (text: string) => { if (current()) setNotice({ frame, text }); };
  const moveOwnedFocus = () => {
    if (typeof document !== "undefined" && (formNode.current?.contains(document.activeElement)
      || decisionNode.current?.contains(document.activeElement)
      || resultNode.current?.contains(document.activeElement))) status.current?.focus({ preventScroll: true });
  };
  function invalidate(): boolean {
    if (!current() || lease === null) return false;
    try { callbacks.current.onCatalogInvalidated(lease); }
    catch { say("서비스 목록의 선택을 해제하지 못했습니다. 화면을 다시 열어 확인하세요. 이미 보낸 요청이 있다면 서버 저장은 되돌아가지 않습니다."); return false; }
    return current();
  }
  function rejectAuthority() {
    if (!current() || lease === null) return;
    const binding = owned.current;
    // Revoke local content before invoking an external host callback.
    owned.current = null; command.current = null;
    if (binding) store.deactivate(binding.catalogLease);
    try { callbacks.current.onAuthorityRejected(lease); } catch { /* Local data remains closed. */ }
  }
  function edit(key: keyof Fields, value: string) {
    if (!current() || currentFields.current !== fields || command.current || preparing.current || completed) return;
    const next = Object.freeze({ ...fields, [key]: value });
    currentFields.current = next; setForm({ frame, fields: next });
  }
  function preview() {
    if (!current() || currentFields.current !== fields || command.current || preparing.current || completed) return;
    preparing.current = true;
    try {
      // Every fact is manually reported. Do not infer dates, timezone or status
      // from the device, a mailbox, another field or a provider.
      const profile = { name: fields.name, provider: fields.provider === "" ? null : fields.provider,
        planName: fields.planName === "" ? null : fields.planName,
        accountLabel: fields.accountLabel === "" ? null : fields.accountLabel,
        timezone: fields.timezone === "" ? null : fields.timezone,
        subscriptionStatus: fields.subscriptionStatus,
        trialEndsAt: fields.trialEndsAt === "" ? null : fields.trialEndsAt,
        notes: fields.notes === "" ? null : fields.notes };
      const request = createCatalogCreateRequest(callbacks.current.createOperationId(), profile);
      if (!current() || currentFields.current !== fields || command.current) return;
      const binding = owned.current!;
      const prepared = store.prepare(binding.catalogLease, request);
      if (!current() || currentFields.current !== fields || command.current) {
        if (prepared.kind === "prepared") store.release(binding.catalogLease, prepared.command);
        return;
      }
      if (prepared.kind !== "prepared") { say("등록 요청을 준비하지 못했습니다. 입력과 화면 상태를 확인해 주세요."); return; }
      const record: Pending = { frame, catalogLease: binding.catalogLease, command: prepared.command, request, fields, phase: "preview" };
      moveOwnedFocus();
      // focus() can synchronously invoke a host listener which closes or swaps
      // the review scope. Never install a prepared old-scope command afterwards.
      if (!current() || currentFields.current !== fields || command.current) {
        store.release(binding.catalogLease, prepared.command); return;
      }
      command.current = record; setOperation({ record, phase: "preview" });
      say("아래 내용 그대로 앱에 기록합니다. 아직 요청을 보내지 않았습니다.");
    } catch { say("서비스 이름은 필수이며 비울 수 없습니다. 서비스 이름·제공자·요금제 이름·계정 표시 이름은 각각 160자, 메모는 UTF-16 기준 2048자 이내인지 확인해 주세요. 앞뒤 공백·금지 문자는 허용하지 않습니다. 입력은 자동 수정하거나 잘라내지 않았습니다. 시간대는 지원되는 64자 이내 이름, 체험 종료일은 유효한 40자 이내 날짜 또는 Z·오프셋이 있는 일시인지 확인하세요. 구독 상태는 제공된 여섯 선택지 중 하나여야 합니다."); }
    finally { preparing.current = false; }
  }
  function cancelPreview() {
    const record = pending?.record;
    if (!record || !owns(record) || record.phase !== "preview") return;
    // Focus listeners run synchronously and may click the old confirm button.
    // Revoke that command before moving focus; cancellation must never dispatch.
    command.current = null; store.release(record.catalogLease, record.command); setOperation(null);
    moveOwnedFocus();
    say("미리보기를 취소했습니다. 서버에 등록 요청을 보내지 않았습니다.");
  }
  async function execute(record: Pending) {
    if (!owns(record) || (record.phase !== "preview" && record.phase !== "uncertain")) return;
    const previousPhase = record.phase;
    record.phase = "pending"; moveOwnedFocus(); setOperation({ record, phase: "pending" });
    // Synchronous host revocation wins over dispatch, including reentrant calls.
    if (!invalidate() || !owns(record)) {
      if (owns(record)) { record.phase = previousPhase; setOperation({ record, phase: previousPhase }); }
      return;
    }
    say("등록 요청을 보냈습니다. 응답이 없어도 서버에 저장됐을 수 있습니다.");
    let result: CatalogCallResult | null = null;
    try { result = await store.execute(record.catalogLease, record.command); }
    catch { /* Unknown acknowledgement: retain this exact immutable command. */ }
    if (!owns(record) || result?.kind === "stale") return;
    const selectionInvalidated = invalidate();
    if (!owns(record)) return;
    if (result?.kind === "error" && ["API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_REQUEST_REJECTED"].includes(result.code)) {
      rejectAuthority(); return;
    }
    // Receipt acknowledgement and the host's list cleanup are separate outcomes.
    // Preserve the latter warning without changing the original command or retry.
    const cleanupWarning = selectionInvalidated ? ""
      : " 다만 서비스 목록의 선택을 해제하지 못했습니다. 목록 상태를 다시 확인해 주세요.";
    const latest = store.getSnapshot();
    const receipt = result?.kind === "success" && result.success.kind === "receipt" ? result.success.receipt : null;
    const currentRow = receipt && latest?.lease === record.catalogLease
      ? latest.state.entries.find((entry) => entry.serviceId === receipt.service.serviceId && entry.dataGeneration === generation) : null;
    if (receipt && receipt.operationId === record.request.body.operationId && currentRow) {
      command.current = null; store.release(record.catalogLease, record.command); setOperation(null);
      const nextOutcome: Outcome = Object.freeze({ frame, serviceId: currentRow.serviceId, replayed: receipt.replayed });
      currentOutcome.current = nextOutcome; setOutcome(nextOutcome);
      say((currentRow.state === "deleted" ? "등록 응답 당시 기록은 삭제된 상태였습니다. 이전 내용을 되살리지 않습니다."
        : "등록 응답 당시의 앱 기록을 확인했습니다. 실제 가입·구독 상태를 검증한 것은 아닙니다. 서비스 목록은 직접 다시 확인해 주세요.") + cleanupWarning);
    } else {
      record.phase = "uncertain"; setOperation({ record, phase: "uncertain" });
      say("등록 결과를 확인하지 못했습니다. 새 이름이나 새 요청으로 덮어쓰지 말고, 아래 원래 요청의 결과를 다시 확인하세요." + cleanupWarning);
    }
  }
  function fresh() {
    if (!current() || command.current || preparing.current || !completed || currentOutcome.current !== completed) return;
    moveOwnedFocus();
    if (!current() || command.current || currentOutcome.current !== completed) return;
    currentOutcome.current = null; currentFields.current = EMPTY;
    setForm({ frame, fields: EMPTY }); setOutcome(null); setNotice(null);
  }

  return <section aria-labelledby={`${id}-title`} data-testid="catalog-service-create-panel" data-phase={phase}
    style={visible ? { minWidth: 0, overflowWrap: "anywhere" } : undefined} onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && pending?.record.phase === "preview" && owns(pending.record)) {
        event.preventDefault(); event.stopPropagation(); cancelPreview();
      }
    }}>
    <h2 id={`${id}-title`}>서비스 직접 등록</h2>
    <p>KeyAtlas에 사용자가 알려준 서비스 기록을 추가합니다. 실제 플랫폼 가입이나 유료 구독을 신청하지 않으며, 계정 보유를 확인하지 않습니다.</p>
    <p>서비스 이름·제공자·요금제 이름·계정 표시 이름은 사용자가 적는 기록용 이름이며, 로그인·계정 인증이나 제공자의 실제 요금제 변경이 아닙니다.</p>
    <p>서비스 메모도 합성 기록 정리용입니다. 실제 개인정보·비밀번호·API 키를 입력하지 마세요.</p>
    <p>시간대·구독 상태·체험 종료일도 사용자가 직접 적는 기록입니다. 제공자의 실제 상태를 확인하거나 변경하지 않으며, 기기 시간대나 다른 입력으로 자동 추론하지 않습니다.</p>
    <p ref={status} role="status" aria-live="polite" aria-atomic="true" tabIndex={-1} data-testid="catalog-service-create-status">
      {!visible ? transportClosed
        ? "연결 설정이 바뀌어 검토 화면을 닫았습니다. 이미 보낸 요청은 저장됐을 수 있으며 이 화면에서 원래 요청을 다시 확인할 수 없습니다. 새 화면을 열어 먼저 기존 기록을 확인하세요."
        : "검토 화면이 닫혀 있습니다. 새 화면 범위에서 먼저 열어 주세요."
        : notice?.frame === frame ? notice.text : "서비스 이름을 입력한 뒤 등록할 내용을 먼저 확인하세요."}</p>
    {visible && <div data-testid="catalog-service-create-content" style={{ minWidth: 0 }}>
      {phase === "editing" && <fieldset ref={formNode} style={{ minWidth: 0 }}>
        <legend>등록할 서비스</legend>
        <label htmlFor={`${id}-name`}>서비스 이름</label>
        <input id={`${id}-name`} value={fields.name} maxLength={160} autoComplete="off"
          aria-required="true" aria-describedby={`${id}-name-hint`}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; edit("name", value); }} />
        <p id={`${id}-name-hint`}>서비스 이름은 필수입니다. 비우거나 공백만 입력할 수 없습니다. 합성 서비스 이름만 사용하세요.</p>
        <label htmlFor={`${id}-provider`}>제공자 (선택)</label>
        <input id={`${id}-provider`} value={fields.provider} maxLength={160} autoComplete="off"
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; edit("provider", value); }} />
        <p id={`${id}-label-hint`}>요금제 이름과 계정 표시 이름은 기록 정리를 위한 이름입니다. 현재는 합성 데이터만 사용하고 실제 개인정보·비밀번호·API 키는 입력하지 마세요. 선택 항목을 완전히 비우면 모름(null)으로 저장하며, 공백은 자동으로 지우지 않습니다.</p>
        <label htmlFor={`${id}-planName`}>요금제 이름 (선택)</label>
        <input id={`${id}-planName`} value={fields.planName} maxLength={160} autoComplete="off" spellCheck={false}
          aria-describedby={`${id}-label-hint`}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; edit("planName", value); }} />
        <label htmlFor={`${id}-accountLabel`}>계정 표시 이름 (선택)</label>
        <input id={`${id}-accountLabel`} value={fields.accountLabel} maxLength={160} autoComplete="off" spellCheck={false}
          aria-describedby={`${id}-label-hint`}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; edit("accountLabel", value); }} />
        <p id={`${id}-manual-facts-hint`}>현재는 합성 데이터만 입력하세요. 실제 개인정보·비밀번호·API 키는 금지합니다. 시간대·구독 상태·체험 종료일은 사용자 기록이며 제공자의 실제 상태를 확인하거나 변경하지 않습니다. 다른 항목에서 자동으로 채우지 않습니다.</p>
        <label htmlFor={`${id}-timezone`}>시간대 (선택)</label>
        <input id={`${id}-timezone`} data-testid="catalog-service-create-timezone" type="text" value={fields.timezone}
          maxLength={64} autoComplete="off" spellCheck={false} autoCapitalize="none"
          aria-describedby={`${id}-manual-facts-hint ${id}-timezone-hint`}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; edit("timezone", value); }} />
        <p id={`${id}-timezone-hint`}>예: Asia/Seoul 또는 UTC. 지원되는 시간대 이름을 원문 그대로 기록합니다. UTF-16 기준 64자까지이며 브라우저 입력 제한이 적용됩니다. 완전히 비우면 모름(null)입니다. 실행 환경이 지원하지 않는 이름과 앞뒤 공백은 거절합니다.</p>
        <label htmlFor={`${id}-subscriptionStatus`}>구독 상태 (사용자 기록)</label>
        <select id={`${id}-subscriptionStatus`} data-testid="catalog-service-create-subscription-status" value={fields.subscriptionStatus}
          autoComplete="off" aria-describedby={`${id}-manual-facts-hint ${id}-subscription-status-hint`}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; edit("subscriptionStatus", value); }}>
          {SUBSCRIPTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <p id={`${id}-subscription-status-hint`}>모름은 별도의 상태 값(unknown)이며 null이 아닙니다. 체험 종료일을 입력해도 이 선택은 자동으로 바뀌지 않습니다.</p>
        <label htmlFor={`${id}-trialEndsAt`}>체험 종료일 (선택)</label>
        <input id={`${id}-trialEndsAt`} data-testid="catalog-service-create-trial-ends-at" type="text" value={fields.trialEndsAt}
          maxLength={40} autoComplete="off" spellCheck={false} autoCapitalize="none"
          aria-describedby={`${id}-manual-facts-hint ${id}-trial-ends-at-hint`}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; edit("trialEndsAt", value); }} />
        <p id={`${id}-trial-ends-at-hint`}>날짜만 YYYY-MM-DD 또는 초까지 포함한 일시와 Z·명시적 오프셋을 입력하세요. 예: 2028-02-29T12:34:56.123456789+09:00. 소수 초는 최대 9자리이며 UTF-16 기준 40자까지 브라우저 입력 제한이 적용됩니다. 완전히 비우면 모름(null)입니다. 날짜에 시각·시간대를 덧붙이거나 원문을 변환하지 않습니다. 현재 이용 가능 여부의 증명이 아닙니다.</p>
        <label htmlFor={`${id}-notes`}>서비스 메모 (선택)</label>
        <textarea id={`${id}-notes`} data-testid="catalog-service-create-notes" value={fields.notes}
          maxLength={2048} rows={4} autoComplete="off" spellCheck={false} aria-describedby={`${id}-notes-hint`}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          onChange={(event) => { const value = event.currentTarget.value; edit("notes", value); }} />
        <p id={`${id}-notes-hint`}>합성 메모만 입력하세요. 실제 개인정보·비밀번호·API 키는 금지합니다. UTF-16 기준 2048자까지이며 브라우저 입력 제한이 적용됩니다. 완전히 비우면 모름(null)입니다. 앞뒤 공백·줄바꿈은 거절하고, 내부 줄바꿈(LF)과 연속 공백은 보존합니다. 앱은 입력된 값을 자동으로 다듬지 않습니다.</p>
        <button type="button" onClick={preview}>등록 내용 미리보기</button>
      </fieldset>}
      {pending && <div ref={decisionNode} role="group" aria-labelledby={`${id}-preview`} data-testid="catalog-service-create-preview">
        <h3 id={`${id}-preview`}>{pending.phase === "preview" ? "보낼 내용 미리보기" : "원래 등록 요청"}</h3>
        <dl>{PROFILE_LABELS.map(([key, label]) => <div key={key}>
          <dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{pending.record.request.body.profile[key] === null ? "모름 (null)"
            : String(pending.record.request.body.profile[key])}</dd>
        </div>)}</dl>
        <p>입력 내용은 사용자 진술이며 계정 보유·현재 구독 상태의 증명이 아닙니다.</p>
        {pending.phase === "preview" ? <>
          <button type="button" onClick={cancelPreview}>미리보기 취소</button>
          <button type="button" onClick={() => { void execute(pending.record); }}>이 내용으로 서비스 기록 저장</button>
        </> : <>
          <p>전송 후 화면 닫기·취소는 서버 저장을 되돌리지 않습니다. 결과가 불명확한 동안 입력과 새 등록은 잠급니다.</p>
          <button type="button" disabled={pending.phase === "pending"}
            onClick={() => { void execute(pending.record); }}>같은 서비스 등록 요청의 결과 다시 확인</button>
        </>}
      </div>}
      {completed && <div ref={resultNode} data-testid="catalog-service-create-result" data-state={row?.state ?? "unavailable"}
        data-service-state={row?.state ?? "unavailable"}>
        <p>{row?.state === "live" ? `등록 응답 당시 확인한 기록: ${row.profile?.name ?? "확인 필요"}`
          : row?.state === "deleted" ? "등록 응답 당시 기록은 삭제된 상태였습니다. 이전 이름·제공자는 표시하지 않습니다." : "등록 응답에서 확인한 기록을 이 화면에 표시할 수 없습니다."}</p>
        <p>{completed.replayed ? "원래 등록 요청을 재확인한 응답 당시의 기록입니다." : "등록 요청의 응답 당시 확인한 기록입니다."} 이 표시는 서비스 목록을 다시 조회해도 바뀌지 않습니다. 목록은 직접 처음부터 다시 조회하세요.</p>
        <button type="button" onClick={fresh}>새 서비스 등록 준비</button>
      </div>}
    </div>}
  </section>;
}
