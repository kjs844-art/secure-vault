import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createCatalogUpdateRequest, type CatalogUpdateRequest } from "../../domain/catalog-client/requests";
import { createCatalogViewStore, type CatalogViewLease } from "../../domain/catalog-client/view-store";
import type { CatalogViewCommand } from "../../domain/catalog-client/view-controller";
import type { CatalogCallResult } from "../../domain/catalog-client/client";
import type { CatalogSelectionSource, CatalogSelectionSnapshot } from "../../domain/catalog-client/selection-source";
import type { CatalogServiceView } from "../../domain/catalog-client/responses";
import { normalizeReviewWorkspaceContext } from "../../domain/review-client/workspace";
import type { CatalogServiceCreatePanelProps } from "./CatalogServiceCreatePanel";

export interface CatalogServiceUpdatePanelProps extends CatalogServiceCreatePanelProps {
  /** The same manually loaded selection source used by the candidate host. */
  readonly source: CatalogSelectionSource;
}
const serverSnapshot = (): null => null;
type Phase = "preview" | "pending" | "uncertain";
interface Fields {
  readonly name: string; readonly provider: string;
  readonly planName: string; readonly accountLabel: string;
  readonly timezone: string; readonly subscriptionStatus: string; readonly trialEndsAt: string;
  readonly notes: string;
}
const SUBSCRIPTION_OPTIONS = [
  ["unknown", "모름"], ["active", "사용 중으로 기록"], ["trial", "체험 중으로 기록"],
  ["trial_ended", "체험 종료로 기록"], ["paused", "일시 중지로 기록"], ["cancelled", "해지로 기록"],
] as const;
const LABELS = [
  ["name", "서비스 이름"], ["provider", "제공자"], ["planName", "요금제 이름"],
  ["accountLabel", "계정 표시 이름"], ["timezone", "시간대"], ["subscriptionStatus", "구독 상태"],
  ["trialEndsAt", "체험 종료일"], ["notes", "메모"],
] as const;
const display = (value: unknown): string => value === null ? "모름 (null)" : String(value);

/** Eight manually reported profile values are editable. The complete observation
 * is bound to its original ID/revision; untouched facts are preserved, not inferred.
 * Catalog refresh is separate from the lifetime of an uncertain update command. */
export function CatalogServiceUpdatePanel(props: CatalogServiceUpdatePanelProps) {
  const id = useId(), workspace = props.workspace, source = props.source;
  const store = useMemo(() => createCatalogViewStore(props.client), [props.client]);
  const active = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);
  const catalog = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
  const sourceSnapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, serverSnapshot);
  const context = normalizeReviewWorkspaceContext(props.context);
  const bindingId = context?.bindingId ?? null, generation = context?.dataGeneration ?? null;
  const lease = active && active.context.bindingId === bindingId && active.context.dataGeneration === generation ? active.lease : null;
  // Source/observation identity intentionally does not own the command store.
  const frame = useMemo(() => Object.freeze({ workspace, store, lease, bindingId, generation }), [workspace, store, lease, bindingId, generation]);
  type Frame = typeof frame;
  type Draft = { readonly frame: Frame; readonly source: CatalogSelectionSource; readonly observation: CatalogSelectionSnapshot;
    readonly row: CatalogServiceView; readonly fields: Fields };
  type Pending = { readonly frame: Frame; readonly catalogLease: CatalogViewLease; readonly command: CatalogViewCommand;
    readonly request: CatalogUpdateRequest; readonly draft: Draft; phase: Phase };
  type Outcome = { readonly frame: Frame; readonly serviceId: string; readonly replayed: boolean };
  const committed = useRef<Frame | null>(null), previousCommit = useRef<Frame | null>(null);
  const committedSource = useRef<CatalogSelectionSource | null>(null);
  const owned = useRef<{ frame: Frame; catalogLease: CatalogViewLease } | null>(null);
  const command = useRef<Pending | null>(null), preparing = useRef(false);
  const currentDraft = useRef<Draft | null>(null), currentOutcome = useRef<Outcome | null>(null);
  const callbacks = useRef({ createOperationId: props.createOperationId, onCatalogInvalidated: props.onCatalogInvalidated,
    onAuthorityRejected: props.onAuthorityRejected });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [operation, setOperation] = useState<{ record: Pending; phase: Phase } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notice, setNotice] = useState<{ frame: Frame; text: string } | null>(null);
  const [transportClosed, setTransportClosed] = useState(false);
  const [choiceAttempt, setChoiceAttempt] = useState<object>(() => Object.freeze({}));
  const choiceEpoch = useMemo(() => Object.freeze({}), [frame, source, sourceSnapshot, draft, operation, outcome, choiceAttempt]);
  const committedChoice = useRef<object | null>(null);
  const status = useRef<HTMLParagraphElement | null>(null), formNode = useRef<HTMLFieldSetElement | null>(null);
  const decisionNode = useRef<HTMLDivElement | null>(null), resultNode = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    committed.current = frame; committedSource.current = source; committedChoice.current = choiceEpoch;
    callbacks.current = { createOperationId: props.createOperationId, onCatalogInvalidated: props.onCatalogInvalidated,
      onAuthorityRejected: props.onAuthorityRejected };
    const previous = previousCommit.current; previousCommit.current = frame;
    if (lease !== null && previous?.workspace === workspace && previous.lease === lease && previous.store !== store) {
      setTransportClosed(true); workspace.deactivate(lease);
    } else if (lease !== null && previous?.lease !== lease) setTransportClosed(false);
  });
  useLayoutEffect(() => {
    let retired = false, catalogLease: CatalogViewLease | null = null;
    const matches = () => {
      const next = workspace.getSnapshot();
      return lease !== null && next?.lease === lease && next.context.bindingId === bindingId && next.context.dataGeneration === generation;
    };
    const retire = () => {
      retired = true;
      if (owned.current?.frame === frame) owned.current = null;
      if (command.current?.frame === frame) command.current = null;
      if (currentDraft.current?.frame === frame) currentDraft.current = null;
      if (currentOutcome.current?.frame === frame) currentOutcome.current = null;
      if (committed.current === frame) committedChoice.current = null;
      if (catalogLease) store.deactivate(catalogLease);
    };
    const detach = workspace.subscribe(() => { if (!matches()) retire(); });
    if (matches() && bindingId !== null && generation !== null) {
      catalogLease = store.activate({ bindingId, dataGeneration: generation });
      if (!retired && matches() && catalogLease) owned.current = { frame, catalogLease }; else retire();
    }
    return () => { detach(); retire(); if (committed.current === frame) committed.current = null; };
  }, [frame, workspace, store, lease, bindingId, generation]);

  const current = () => {
    const next = workspace.getSnapshot(), binding = owned.current, latest = store.getSnapshot();
    return committed.current === frame && lease !== null && next?.lease === lease
      && next.context.bindingId === bindingId && next.context.dataGeneration === generation
      && binding?.frame === frame && latest?.lease === binding.catalogLease;
  };
  const observationCurrent = (value: CatalogSelectionSnapshot | null): value is CatalogSelectionSnapshot =>
    value !== null && current() && committedSource.current === source && source.getSnapshot() === value
    && value.lease === lease && value.context.bindingId === bindingId && value.context.dataGeneration === generation
    && (value.phase === "more" || value.phase === "end_observed");
  const draftCurrent = (value: Draft): boolean => value.frame === frame && value.source === source
    && currentDraft.current === value && observationCurrent(value.observation)
    && value.observation.services.includes(value.row) && value.row.state === "live"
    && value.row.profile !== null && value.row.dataGeneration === generation;
  const owns = (record: Pending) => current() && record.frame === frame && command.current === record
    && owned.current?.catalogLease === record.catalogLease;
  const say = (text: string) => { if (current()) setNotice({ frame, text }); };
  const moveOwnedFocus = () => {
    if (typeof document !== "undefined" && (formNode.current?.contains(document.activeElement)
      || decisionNode.current?.contains(document.activeElement) || resultNode.current?.contains(document.activeElement))) {
      status.current?.focus({ preventScroll: true });
    }
  };

  useLayoutEffect(() => {
    let attached = true;
    const changed = () => {
      if (!attached || committed.current !== frame || committedSource.current !== source) return;
      const heldDraft = currentDraft.current, held = command.current;
      const dropDraft = heldDraft?.frame === frame && !draftCurrent(heldDraft);
      const dropPreview = held?.frame === frame && held.phase === "preview" && !draftCurrent(held.draft);
      if (!dropDraft && !dropPreview) return;
      // Clear identity before focus or release can invoke a host callback.
      committedChoice.current = null;
      if (dropDraft) currentDraft.current = null;
      if (dropPreview) command.current = null;
      moveOwnedFocus();
      if (dropPreview) store.release(held.catalogLease, held.command);
      if (!current() || committedSource.current !== source) return;
      if (dropDraft) setDraft(null);
      if (dropPreview) setOperation(null);
      say("서비스 목록 관찰이 바뀌어 보내지 않은 수정 내용을 닫았습니다. 목록에서 다시 선택하세요. 이미 보낸 원래 요청은 유지합니다.");
    };
    const detach = source.subscribe(changed); changed();
    return () => { attached = false; detach(); };
  }, [frame, source]);

  const visible = lease && catalog && catalog.context.bindingId === bindingId && catalog.context.dataGeneration === generation
    && owned.current?.frame === frame && owned.current.catalogLease === catalog.lease ? catalog : null;
  const observation = sourceSnapshot?.lease === lease && sourceSnapshot.context.bindingId === bindingId
    && sourceSnapshot.context.dataGeneration === generation && (sourceSnapshot.phase === "more" || sourceSnapshot.phase === "end_observed")
    ? sourceSnapshot : null;
  const selected = draft?.frame === frame && draft.source === source && draft.observation === observation && currentDraft.current === draft ? draft : null;
  const pending = operation?.record.frame === frame && command.current === operation.record
    && (operation.phase !== "preview" || (operation.record.draft.source === source && operation.record.draft.observation === observation)) ? operation : null;
  const completed = outcome?.frame === frame ? outcome : null;
  const row = completed && visible ? visible.state.entries.find((entry) => entry.serviceId === completed.serviceId) ?? null : null;
  const phase = !visible ? "closed" : pending?.phase ?? (completed ? "completed" : selected ? "editing" : "selecting");
  const services = observation?.services.filter((entry) => entry.state === "live" && entry.profile !== null && entry.dataGeneration === generation) ?? [];

  function choose(serviceId: string) {
    if (!observationCurrent(observation) || committedChoice.current !== choiceEpoch || currentDraft.current !== selected
      || command.current || preparing.current || currentOutcome.current) return;
    // Even a return to an empty selection must not revive a previous select
    // callback from the same observed page.
    committedChoice.current = null;
    // An already-empty/invalid choice otherwise calls setDraft(null) with the
    // same state, so React can skip the commit which renews the consumed fence.
    // A distinct token makes the next choice live without reviving old handlers.
    setChoiceAttempt(Object.freeze({}));
    const row = observation.services.find((entry) => entry.serviceId === serviceId && entry.state === "live" && entry.profile !== null && entry.dataGeneration === generation);
    if (!row?.profile) { currentDraft.current = null; setDraft(null); return; }
    const next: Draft = Object.freeze({ frame, source, observation, row,
      fields: Object.freeze({ name: row.profile.name, provider: row.profile.provider ?? "",
        planName: row.profile.planName ?? "", accountLabel: row.profile.accountLabel ?? "",
        timezone: row.profile.timezone ?? "", subscriptionStatus: row.profile.subscriptionStatus,
        trialEndsAt: row.profile.trialEndsAt ?? "", notes: row.profile.notes ?? "" }) });
    currentDraft.current = next; setDraft(next);
    say("이 관찰의 여덟 값을 사용자 기록으로 수정합니다. 시간대·구독 상태·체험 종료일은 다른 입력에서 자동 추론하지 않으며, 기존 검토 혜택의 당시 이름은 바꾸지 않습니다.");
  }
  function edit(key: keyof Fields, value: string) {
    if (!selected || !draftCurrent(selected) || command.current || preparing.current || completed) return;
    const next: Draft = Object.freeze({ ...selected, fields: Object.freeze({ ...selected.fields, [key]: value }) });
    currentDraft.current = next; setDraft(next);
  }
  function preview() {
    if (!selected || !draftCurrent(selected) || command.current || preparing.current || completed || !selected.row.profile) return;
    preparing.current = true;
    try {
      const profile = { ...selected.row.profile, name: selected.fields.name,
        provider: selected.fields.provider === "" ? null : selected.fields.provider,
        planName: selected.fields.planName === "" ? null : selected.fields.planName,
        accountLabel: selected.fields.accountLabel === "" ? null : selected.fields.accountLabel,
        timezone: selected.fields.timezone === "" ? null : selected.fields.timezone,
        subscriptionStatus: selected.fields.subscriptionStatus,
        trialEndsAt: selected.fields.trialEndsAt === "" ? null : selected.fields.trialEndsAt,
        notes: selected.fields.notes === "" ? null : selected.fields.notes };
      const request = createCatalogUpdateRequest(selected.row.serviceId, selected.row.serviceRevision, callbacks.current.createOperationId(), profile);
      if (!draftCurrent(selected) || command.current) return;
      const binding = owned.current!, prepared = store.prepare(binding.catalogLease, request);
      if (!draftCurrent(selected) || command.current) {
        if (prepared.kind === "prepared") store.release(binding.catalogLease, prepared.command); return;
      }
      if (prepared.kind !== "prepared") { say("수정 요청을 준비하지 못했습니다. 입력과 화면 상태를 확인해 주세요."); return; }
      const record: Pending = { frame, catalogLease: binding.catalogLease, command: prepared.command, request, draft: selected, phase: "preview" };
      moveOwnedFocus();
      if (!draftCurrent(selected) || command.current) { store.release(binding.catalogLease, prepared.command); return; }
      command.current = record; setOperation({ record, phase: "preview" });
      say("수정 전·후의 여덟 값을 확인하세요. 아직 서버에 수정 요청을 보내지 않았습니다.");
    } catch { say("서비스 이름은 필수이며 비울 수 없습니다. 서비스 이름·제공자·요금제 이름·계정 표시 이름은 각각 160자, 메모는 UTF-16 기준 2048자 이내인지 확인해 주세요. 앞뒤 공백·금지 문자는 허용하지 않습니다. 입력은 자동 수정하거나 잘라내지 않았습니다. 시간대는 지원되는 64자 이내 이름, 체험 종료일은 유효한 40자 이내 날짜 또는 Z·오프셋이 있는 일시인지 확인하세요. 구독 상태는 제공된 여섯 선택지 중 하나여야 합니다."); }
    finally { preparing.current = false; }
  }
  function cancelPreview() {
    const record = pending?.record;
    if (!record || !owns(record) || record.phase !== "preview") return;
    // Revoke before focus can synchronously reenter the old confirmation handler.
    command.current = null; store.release(record.catalogLease, record.command); setOperation(null);
    moveOwnedFocus();
    say("수정 미리보기를 취소했습니다. 서버에 수정 요청을 보내지 않았습니다.");
  }
  function invalidate(): boolean {
    if (!current() || lease === null) return false;
    try { callbacks.current.onCatalogInvalidated(lease); }
    catch { say("서비스 목록을 다시 확인해야 합니다. 이미 보낸 요청의 서버 저장은 되돌아가지 않습니다."); return false; }
    return current();
  }
  function rejectAuthority() {
    if (!current() || lease === null) return;
    const binding = owned.current; owned.current = null; command.current = null; currentDraft.current = null;
    if (binding) store.deactivate(binding.catalogLease);
    try { callbacks.current.onAuthorityRejected(lease); } catch { /* Local data stays closed. */ }
  }
  async function execute(record: Pending) {
    if (!owns(record) || (record.phase !== "preview" && record.phase !== "uncertain")
      || (record.phase === "preview" && !draftCurrent(record.draft))) return;
    const previous = record.phase;
    // The source may synchronously publish restart_required in invalidate().
    // Mark attempted ownership first so that publication cannot discard it.
    record.phase = "pending"; moveOwnedFocus();
    if (!owns(record)) return;
    if (previous === "preview" && !draftCurrent(record.draft)) {
      // A synchronous focus listener changed the selection before dispatch.
      // This is different from our deliberate catalog invalidation below.
      command.current = null; store.release(record.catalogLease, record.command); setOperation(null);
      say("수정 요청을 보내기 전에 목록 관찰이 바뀌었습니다. 서비스를 다시 선택하세요."); return;
    }
    setOperation({ record, phase: "pending" });
    if (!invalidate() || !owns(record)) {
      if (owns(record)) {
        // The callback may have retired the source observation before throwing.
        // Returning to its old preview hides the still-owned command and blocks
        // all fresh selection. Preserve an explicit original-command retry just
        // as for a failed acknowledgement; this attempt was not dispatched.
        record.phase = "uncertain"; setOperation({ record, phase: "uncertain" });
        say("목록 상태를 확인하지 못해 이번 전송을 중단했습니다. 대상·버전·입력을 바꾸지 않고 원래 수정 요청만 다시 확인할 수 있습니다.");
      }
      return;
    }
    say("수정 요청을 보냈습니다. 응답이 없어도 저장됐을 수 있습니다.");
    let result: CatalogCallResult | null = null;
    try { result = await store.execute(record.catalogLease, record.command); } catch { /* Preserve exact original command. */ }
    if (!owns(record) || result?.kind === "stale") return;
    const selectionInvalidated = invalidate(); if (!owns(record)) return;
    if (result?.kind === "error" && ["API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_REQUEST_REJECTED"].includes(result.code)) {
      rejectAuthority(); return;
    }
    // A valid receipt does not prove the separate list invalidation succeeded.
    // Keep both outcomes visible without reclassifying or replacing the command.
    const cleanupWarning = selectionInvalidated ? ""
      : " 다만 서비스 목록을 다시 확인해야 합니다. 이미 보낸 요청의 서버 저장은 되돌아가지 않습니다.";
    const latest = store.getSnapshot();
    const receipt = result?.kind === "success" && result.success.kind === "receipt" ? result.success.receipt : null;
    const currentRow = receipt && latest?.lease === record.catalogLease
      ? latest.state.entries.find((entry) => entry.serviceId === record.request.body.serviceId && entry.dataGeneration === generation) : null;
    if (receipt && receipt.operationId === record.request.body.operationId && receipt.service.serviceId === record.request.body.serviceId && currentRow) {
      command.current = null; currentDraft.current = null; store.release(record.catalogLease, record.command); setOperation(null); setDraft(null);
      const next: Outcome = Object.freeze({ frame, serviceId: currentRow.serviceId, replayed: receipt.replayed });
      currentOutcome.current = next; setOutcome(next);
      say((currentRow.state === "deleted" ? "수정 응답 당시 기록은 삭제된 상태였습니다. 이전 내용을 되살리지 않습니다."
        : "수정 응답 당시의 앱 기록을 확인했습니다. 목록은 직접 다시 조회하세요. 이미 검토한 혜택의 당시 서비스 이름은 보존됩니다.") + cleanupWarning);
    } else {
      record.phase = "uncertain"; setOperation({ record, phase: "uncertain" });
      say((result?.kind === "error" && result.code === "API_CONFLICT"
        ? "서비스 버전 또는 요청이 충돌했습니다. 새 버전으로 자동 덮어쓰지 않습니다. 목록을 다시 확인하고 원래 요청의 결과만 재확인하세요."
        : "수정 결과를 확인하지 못했습니다. 입력을 바꾸지 않고 원래 요청의 결과만 다시 확인할 수 있습니다.") + cleanupWarning);
    }
  }
  function fresh() {
    if (!current() || command.current || preparing.current || !completed || currentOutcome.current !== completed) return;
    moveOwnedFocus(); if (!current() || command.current || currentOutcome.current !== completed) return;
    currentOutcome.current = null; currentDraft.current = null; setOutcome(null); setDraft(null); setNotice(null);
  }

  return <section aria-labelledby={`${id}-title`} data-testid="catalog-service-update-panel" data-phase={phase}
    style={visible ? { minWidth: 0, overflowWrap: "anywhere" } : undefined} onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && pending?.record.phase === "preview" && owns(pending.record)) {
        event.preventDefault(); event.stopPropagation(); cancelPreview();
      }
    }}>
    <h2 id={`${id}-title`}>서비스 기록 수정</h2>
    <p>이 앱에 기록한 서비스 이름·제공자·요금제 이름·계정 표시 이름을 고칩니다. 사용자 진술이며 로그인·계정 인증이나 실제 가입·요금제·구독 변경이 아닙니다. 이미 검토한 혜택의 당시 서비스 이름은 보존됩니다.</p>
    <p>서비스 메모도 합성 기록 정리용입니다. 실제 개인정보·비밀번호·API 키를 입력하지 마세요.</p>
    <p>시간대·구독 상태·체험 종료일도 사용자가 직접 적는 기록입니다. 제공자의 실제 상태를 확인하거나 변경하지 않으며, 기기 시간대나 다른 입력으로 자동 추론하지 않습니다. 수정하지 않은 값은 원래 관찰 그대로 보존합니다.</p>
    <p ref={status} role="status" aria-live="polite" aria-atomic="true" tabIndex={-1} data-testid="catalog-service-update-status">
      {!visible ? transportClosed
        ? "연결 설정이 바뀌어 검토 화면을 닫았습니다. 이미 보낸 요청은 저장됐을 수 있으며 원래 재시도는 이 화면에서 끝났습니다. 새 화면에서 기존 기록을 먼저 확인하세요."
        : "검토 화면이 닫혀 있습니다. 새 화면 범위에서 먼저 열어 주세요."
        : notice?.frame === frame ? notice.text : "목록을 수동으로 불러온 뒤 수정할 서비스를 선택하세요."}</p>
    {visible && <div data-testid="catalog-service-update-content" style={{ minWidth: 0 }}>
      {(phase === "selecting" || phase === "editing") && <fieldset ref={formNode} style={{ minWidth: 0 }}>
        <legend>불러온 서비스 중 수정 선택</legend>
        <label htmlFor={`${id}-service`}>수정할 서비스</label>
        <select id={`${id}-service`} value={selected?.row.serviceId ?? ""} disabled={!observation}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; choose(value); }}>
          <option value="">서비스를 직접 선택하세요</option>
          {services.map((entry) => <option key={entry.serviceId} value={entry.serviceId}>
            {entry.profile!.name} · {entry.serviceId} · 버전 {entry.serviceRevision}
          </option>)}
        </select>
        <p>불러온 범위의 기록만 표시합니다. 목록 관찰이 바뀌면 보내지 않은 편집은 닫힙니다.</p>
        {selected && <>
          <label htmlFor={`${id}-name`}>수정할 서비스 이름</label>
          <input id={`${id}-name`} value={selected.fields.name} maxLength={160} autoComplete="off"
            aria-required="true" aria-describedby={`${id}-name-hint`}
            style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
            onChange={(event) => { const value = event.currentTarget.value; edit("name", value); }} />
          <p id={`${id}-name-hint`}>서비스 이름은 필수입니다. 비우거나 공백만 입력할 수 없습니다. 합성 서비스 이름만 사용하세요.</p>
          <label htmlFor={`${id}-provider`}>수정할 제공자 (선택)</label>
          <input id={`${id}-provider`} value={selected.fields.provider} maxLength={160} autoComplete="off"
            style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
            onChange={(event) => { const value = event.currentTarget.value; edit("provider", value); }} />
          <p id={`${id}-label-hint`}>요금제 이름과 계정 표시 이름은 기록 정리를 위한 이름입니다. 현재는 합성 데이터만 사용하고 실제 개인정보·비밀번호·API 키는 입력하지 마세요. 선택 항목을 완전히 비우면 모름(null)으로 저장하며, 공백은 자동으로 지우지 않습니다.</p>
          <label htmlFor={`${id}-planName`}>수정할 요금제 이름 (선택)</label>
          <input id={`${id}-planName`} value={selected.fields.planName} maxLength={160} autoComplete="off" spellCheck={false}
            aria-describedby={`${id}-label-hint`}
            style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
            onChange={(event) => { const value = event.currentTarget.value; edit("planName", value); }} />
          <label htmlFor={`${id}-accountLabel`}>수정할 계정 표시 이름 (선택)</label>
          <input id={`${id}-accountLabel`} value={selected.fields.accountLabel} maxLength={160} autoComplete="off" spellCheck={false}
            aria-describedby={`${id}-label-hint`}
            style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
            onChange={(event) => { const value = event.currentTarget.value; edit("accountLabel", value); }} />
          <p id={`${id}-manual-facts-hint`}>현재는 합성 데이터만 입력하세요. 실제 개인정보·비밀번호·API 키는 금지합니다. 시간대·구독 상태·체험 종료일은 사용자 기록이며 제공자의 실제 상태를 확인하거나 변경하지 않습니다. 다른 항목에서 자동으로 채우지 않습니다.</p>
          <label htmlFor={`${id}-timezone`}>수정할 시간대 (선택)</label>
          <input id={`${id}-timezone`} data-testid="catalog-service-update-timezone" type="text" value={selected.fields.timezone}
            maxLength={64} autoComplete="off" spellCheck={false} autoCapitalize="none"
            aria-describedby={`${id}-manual-facts-hint ${id}-timezone-hint`}
            style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
            onChange={(event) => { const value = event.currentTarget.value; edit("timezone", value); }} />
          <p id={`${id}-timezone-hint`}>예: Asia/Seoul 또는 UTC. 지원되는 시간대 이름을 원문 그대로 기록합니다. UTF-16 기준 64자까지이며 브라우저 입력 제한이 적용됩니다. 완전히 비우면 모름(null)입니다. 실행 환경이 지원하지 않는 이름과 앞뒤 공백은 거절합니다.</p>
          <label htmlFor={`${id}-subscriptionStatus`}>수정할 구독 상태 (사용자 기록)</label>
          <select id={`${id}-subscriptionStatus`} data-testid="catalog-service-update-subscription-status" value={selected.fields.subscriptionStatus}
            autoComplete="off" aria-describedby={`${id}-manual-facts-hint ${id}-subscription-status-hint`}
            style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
            onChange={(event) => { const value = event.currentTarget.value; edit("subscriptionStatus", value); }}>
            {SUBSCRIPTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <p id={`${id}-subscription-status-hint`}>모름은 별도의 상태 값(unknown)이며 null이 아닙니다. 체험 종료일을 입력해도 이 선택은 자동으로 바뀌지 않습니다.</p>
          <label htmlFor={`${id}-trialEndsAt`}>수정할 체험 종료일 (선택)</label>
          <input id={`${id}-trialEndsAt`} data-testid="catalog-service-update-trial-ends-at" type="text" value={selected.fields.trialEndsAt}
            maxLength={40} autoComplete="off" spellCheck={false} autoCapitalize="none"
            aria-describedby={`${id}-manual-facts-hint ${id}-trial-ends-at-hint`}
            style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
            onChange={(event) => { const value = event.currentTarget.value; edit("trialEndsAt", value); }} />
          <p id={`${id}-trial-ends-at-hint`}>날짜만 YYYY-MM-DD 또는 초까지 포함한 일시와 Z·명시적 오프셋을 입력하세요. 예: 2028-02-29T12:34:56.123456789+09:00. 소수 초는 최대 9자리이며 UTF-16 기준 40자까지 브라우저 입력 제한이 적용됩니다. 완전히 비우면 모름(null)입니다. 날짜에 시각·시간대를 덧붙이거나 원문을 변환하지 않습니다. 현재 이용 가능 여부의 증명이 아닙니다.</p>
          <label htmlFor={`${id}-notes`}>수정할 서비스 메모 (선택)</label>
          <textarea id={`${id}-notes`} data-testid="catalog-service-update-notes" value={selected.fields.notes}
            maxLength={2048} rows={4} autoComplete="off" spellCheck={false} aria-describedby={`${id}-notes-hint`}
            style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            onChange={(event) => { const value = event.currentTarget.value; edit("notes", value); }} />
          <p id={`${id}-notes-hint`}>합성 메모만 입력하세요. 실제 개인정보·비밀번호·API 키는 금지합니다. UTF-16 기준 2048자까지이며 브라우저 입력 제한이 적용됩니다. 완전히 비우면 모름(null)입니다. 앞뒤 공백·줄바꿈은 거절하고, 내부 줄바꿈(LF)과 연속 공백은 보존합니다. 앱은 입력된 값을 자동으로 다듬지 않습니다.</p>
          <button type="button" onClick={preview}>수정 내용 미리보기</button>
        </>}
      </fieldset>}
      {pending && <div ref={decisionNode} role="group" aria-labelledby={`${id}-preview`} data-testid="catalog-service-update-preview">
        <h3 id={`${id}-preview`}>{pending.phase === "preview" ? "수정 전·후 확인" : "원래 수정 요청"}</h3>
        <p>서비스 ID: {pending.record.request.body.serviceId} · 원래 버전: {pending.record.request.body.expectedRevision}</p>
        <dl>{LABELS.map(([key, label]) => <div key={key}>
          <dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>수정 전: {display(pending.record.draft.row.profile![key])}</dd>
          <dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>수정 후: {display(pending.record.request.body.profile[key])}</dd>
        </div>)}</dl>
        <p>수정 값은 사용자 진술이며 실제 계정·구독 상태의 증명이 아닙니다. 이전 미리보기는 무효화될 수 있습니다.</p>
        {pending.phase === "preview" ? <>
          <button type="button" onClick={cancelPreview}>수정 미리보기 취소</button>
          <button type="button" onClick={() => { void execute(pending.record); }}>이 내용으로 서비스 기록 수정</button>
        </> : <>
          <p>전송 후 화면 닫기는 서버 저장을 되돌리지 않습니다. 새 입력·다른 선택으로 원래 요청을 덮어쓰지 않습니다.</p>
          <button type="button" disabled={pending.phase === "pending"}
            onClick={() => { void execute(pending.record); }}>같은 서비스 수정 요청의 결과 다시 확인</button>
        </>}
      </div>}
      {completed && <div ref={resultNode} data-testid="catalog-service-update-result" data-service-state={row?.state ?? "unavailable"}>
        <p>{row?.state === "live" ? `수정 응답 당시 확인한 기록: ${row.profile?.name ?? "확인 필요"}`
          : row?.state === "deleted" ? "수정 응답 당시 기록은 삭제된 상태였습니다. 이전 이름·제공자는 표시하지 않습니다." : "수정 응답에서 확인한 기록을 이 화면에 표시할 수 없습니다."}</p>
        <p>{completed.replayed ? "원래 수정 요청을 재확인한 응답 당시의 기록입니다." : "수정 요청의 응답 당시 확인한 기록입니다."} 이 표시는 서비스 목록을 다시 조회해도 바뀌지 않습니다. 목록은 직접 처음부터 다시 조회하세요.</p>
        <button type="button" onClick={fresh}>다른 서비스 수정 준비</button>
      </div>}
    </div>}
  </section>;
}
