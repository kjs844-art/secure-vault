import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createCatalogDeleteRequest, type CatalogDeleteRequest } from "../../domain/catalog-client/requests";
import { createCatalogViewStore, type CatalogViewLease } from "../../domain/catalog-client/view-store";
import type { CatalogViewCommand } from "../../domain/catalog-client/view-controller";
import type { CatalogCallResult } from "../../domain/catalog-client/client";
import type { CatalogSelectionSource, CatalogSelectionSnapshot } from "../../domain/catalog-client/selection-source";
import type { CatalogServiceView } from "../../domain/catalog-client/responses";
import { normalizeReviewWorkspaceContext } from "../../domain/review-client/workspace";
import type { CatalogServiceCreatePanelProps } from "./CatalogServiceCreatePanel";

export interface CatalogServiceDeletePanelProps extends CatalogServiceCreatePanelProps {
  /** The manually loaded source shared with the candidate host, not a new reader. */
  readonly source: CatalogSelectionSource;
}
const serverSnapshot = (): null => null;
type Phase = "preview" | "pending" | "uncertain";

/** Explicit service-record deletion only. Existing server CAS, live-benefit
 * exclusion and operation ledger remain authoritative. Never cascade or infer
 * that an absent/expired displayed benefit makes a service safe to delete. */
export function CatalogServiceDeletePanel(props: CatalogServiceDeletePanelProps) {
  const id = useId(), workspace = props.workspace, source = props.source;
  const store = useMemo(() => createCatalogViewStore(props.client), [props.client]);
  const active = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);
  const catalog = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
  const sourceSnapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, serverSnapshot);
  const context = normalizeReviewWorkspaceContext(props.context);
  const bindingId = context?.bindingId ?? null, generation = context?.dataGeneration ?? null;
  const lease = active && active.context.bindingId === bindingId && active.context.dataGeneration === generation ? active.lease : null;
  // A list observation owns only the unsent selection, not an attempted command.
  const frame = useMemo(() => Object.freeze({ workspace, store, lease, bindingId, generation }), [workspace, store, lease, bindingId, generation]);
  type Frame = typeof frame;
  type Draft = { readonly frame: Frame; readonly source: CatalogSelectionSource;
    readonly observation: CatalogSelectionSnapshot; readonly row: CatalogServiceView };
  type Pending = { readonly frame: Frame; readonly catalogLease: CatalogViewLease; readonly command: CatalogViewCommand;
    readonly request: CatalogDeleteRequest; readonly draft: Draft; phase: Phase; confirmation: string };
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
      committedChoice.current = null;
      if (dropDraft) currentDraft.current = null;
      if (dropPreview) command.current = null;
      moveOwnedFocus();
      if (dropPreview) store.release(held.catalogLease, held.command);
      if (!current() || committedSource.current !== source) return;
      if (dropDraft) setDraft(null);
      if (dropPreview) setOperation(null);
      say("서비스 목록 관찰이 바뀌어 보내지 않은 삭제 확인을 닫았습니다. 다시 선택하세요. 이미 보낸 원래 요청은 유지합니다.");
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
  const phase = !visible ? "closed" : pending?.phase ?? (completed ? "completed" : selected ? "selected" : "selecting");
  const services = observation?.services.filter((entry) => entry.state === "live" && entry.profile !== null && entry.dataGeneration === generation) ?? [];

  function choose(serviceId: string) {
    if (!observationCurrent(observation) || committedChoice.current !== choiceEpoch || currentDraft.current !== selected
      || command.current || preparing.current || currentOutcome.current) return;
    committedChoice.current = null;
    // A fresh token also commits an empty-to-empty choice. Otherwise React's
    // bailout could leave every later valid choice behind the consumed fence.
    setChoiceAttempt(Object.freeze({}));
    const row = observation.services.find((entry) => entry.serviceId === serviceId && entry.state === "live" && entry.profile !== null && entry.dataGeneration === generation);
    if (!row?.profile) { currentDraft.current = null; setDraft(null); return; }
    const next: Draft = Object.freeze({ frame, source, observation, row });
    currentDraft.current = next; setDraft(next);
    say("선택한 서비스의 삭제 대상과 영향을 먼저 확인하세요. 아직 삭제 요청을 보내지 않았습니다.");
  }
  function preview() {
    if (!selected || !draftCurrent(selected) || command.current || preparing.current || completed) return;
    preparing.current = true;
    try {
      const request = createCatalogDeleteRequest(selected.row.serviceId, selected.row.serviceRevision, callbacks.current.createOperationId());
      if (!draftCurrent(selected) || command.current) return;
      const binding = owned.current!, prepared = store.prepare(binding.catalogLease, request);
      if (!draftCurrent(selected) || command.current) {
        if (prepared.kind === "prepared") store.release(binding.catalogLease, prepared.command); return;
      }
      if (prepared.kind !== "prepared") { say("삭제 요청을 준비하지 못했습니다. 화면과 서비스 목록 상태를 확인해 주세요."); return; }
      const record: Pending = { frame, catalogLease: binding.catalogLease, command: prepared.command,
        request, draft: selected, phase: "preview", confirmation: "" };
      moveOwnedFocus();
      if (!draftCurrent(selected) || command.current) { store.release(binding.catalogLease, prepared.command); return; }
      command.current = record; setOperation({ record, phase: "preview" });
      say("삭제 대상과 영향을 확인하세요. 아직 삭제 요청을 보내지 않았습니다.");
    } catch { say("삭제 요청의 대상이나 식별자를 확인하지 못했습니다. 서비스 목록과 화면 상태를 확인해 주세요."); }
    finally { preparing.current = false; }
  }
  function confirmText(record: Pending, value: string) {
    if (!owns(record) || record.phase !== "preview" || !draftCurrent(record.draft)) return;
    record.confirmation = value; setOperation({ record, phase: "preview" });
  }
  function cancelPreview() {
    const record = pending?.record;
    if (!record || !owns(record) || record.phase !== "preview") return;
    // Revoke first: a synchronous focus listener cannot execute the canceled token.
    command.current = null; record.confirmation = "";
    store.release(record.catalogLease, record.command); setOperation(null);
    moveOwnedFocus();
    say("삭제 미리보기를 취소했습니다. 서버에 삭제 요청을 보내지 않았습니다.");
  }
  function invalidate(): boolean {
    if (!current() || lease === null) return false;
    try { callbacks.current.onCatalogInvalidated(lease); }
    catch { say("서비스 목록을 다시 확인해야 합니다. 이미 보낸 삭제 요청은 되돌아가지 않습니다."); return false; }
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
      || (record.phase === "preview" && (!draftCurrent(record.draft) || record.confirmation !== "삭제"))) return;
    const previous = record.phase;
    // Claim before focus/publication: an old button cannot dispatch twice, while
    // deliberate catalog invalidation must not drop this original command.
    record.phase = "pending"; moveOwnedFocus();
    if (!owns(record)) return;
    if (previous === "preview" && !draftCurrent(record.draft)) {
      command.current = null; store.release(record.catalogLease, record.command); setOperation(null);
      say("삭제 요청을 보내기 전에 목록 관찰이 바뀌었습니다. 서비스를 다시 선택하세요."); return;
    }
    setOperation({ record, phase: "pending" });
    if (!invalidate() || !owns(record)) {
      if (owns(record)) {
        // Do not offer a different target or guess that a host callback restored
        // the old observation. Keep the immutable command for an explicit retry.
        record.phase = "uncertain"; setOperation({ record, phase: "uncertain" });
        say("목록 상태를 확인하지 못해 이번 전송을 중단했습니다. 새 대상을 삭제하지 않고 원래 요청만 다시 확인할 수 있습니다.");
      }
      return;
    }
    say("삭제 요청을 보냈습니다. 응답이 없어도 이미 삭제됐을 수 있습니다.");
    let result: CatalogCallResult | null = null;
    try { result = await store.execute(record.catalogLease, record.command); } catch { /* Keep the exact original command. */ }
    if (!owns(record) || result?.kind === "stale") return;
    const selectionInvalidated = invalidate(); if (!owns(record)) return;
    if (result?.kind === "error" && ["API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_REQUEST_REJECTED"].includes(result.code)) {
      rejectAuthority(); return;
    }
    const latest = store.getSnapshot();
    const receipt = result?.kind === "success" && result.success.kind === "receipt" ? result.success.receipt : null;
    const currentRow = receipt && latest?.lease === record.catalogLease
      ? latest.state.entries.find((entry) => entry.serviceId === record.request.body.serviceId && entry.dataGeneration === generation) : null;
    if (receipt && receipt.operationId === record.request.body.operationId && receipt.service.serviceId === record.request.body.serviceId
      && currentRow?.state === "deleted" && currentRow.profile === null) {
      command.current = null; currentDraft.current = null; store.release(record.catalogLease, record.command); setOperation(null); setDraft(null);
      const next: Outcome = Object.freeze({ frame, serviceId: currentRow.serviceId, replayed: receipt.replayed });
      currentOutcome.current = next; setOutcome(next);
      say(selectionInvalidated
        ? "삭제 응답 당시 이 앱의 서비스 기록이 삭제된 상태임을 확인했습니다. 이전 내용은 표시하지 않습니다. 목록은 직접 다시 조회하세요."
        : "삭제 응답 당시 이 앱의 서비스 기록이 삭제된 상태임을 확인했습니다. 다만 서비스 목록 상태 정리에 실패했습니다. 이전 내용은 표시하지 않으며, 목록은 직접 다시 조회하세요.");
    } else {
      record.phase = "uncertain"; setOperation({ record, phase: "uncertain" });
      const cleanupWarning = selectionInvalidated ? ""
        : " 다만 서비스 목록을 다시 확인해야 합니다. 이미 보낸 삭제 요청은 되돌아가지 않습니다.";
      say((result?.kind === "error" && result.code === "API_CONFLICT"
        ? "연결된 혜택, 서비스 버전 또는 요청이 충돌했을 수 있습니다. 원인을 단정하거나 새 버전으로 자동 삭제하지 않습니다. 기록을 확인하고 원래 요청의 결과만 재확인하세요."
        : "삭제 결과를 확인하지 못했습니다. 대상과 버전을 바꾸지 않고 원래 요청의 결과만 다시 확인할 수 있습니다.") + cleanupWarning);
    }
  }
  function fresh() {
    if (!current() || command.current || preparing.current || !completed || currentOutcome.current !== completed) return;
    moveOwnedFocus(); if (!current() || command.current || currentOutcome.current !== completed) return;
    currentOutcome.current = null; currentDraft.current = null; setOutcome(null); setDraft(null); setNotice(null);
  }

  return <section aria-labelledby={`${id}-title`} data-testid="catalog-service-delete-panel" data-phase={phase}
    style={visible ? { minWidth: 0, overflowWrap: "anywhere" } : undefined} onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && pending?.record.phase === "preview" && owns(pending.record)) {
        event.preventDefault(); event.stopPropagation(); cancelPreview();
      }
    }}>
    <h2 id={`${id}-title`}>서비스 기록 삭제</h2>
    <p>이 앱에 기록한 서비스 내용만 삭제합니다. 외부 계정·구독·원본 메일·메일 후보를 삭제하지 않습니다.</p>
    <p>연결된 혜택 기록이 남아 있으면 서버에서 거절합니다. 지난 혜택도 자동으로 지우지 않으며, 목록에 보이지 않는다고 삭제 가능한 것은 아닙니다.</p>
    <p ref={status} role="status" aria-live="polite" aria-atomic="true" tabIndex={-1} data-testid="catalog-service-delete-status">
      {!visible ? transportClosed
        ? "연결 설정이 바뀌어 검토 화면을 닫았습니다. 이미 보낸 삭제 요청은 완료됐을 수 있습니다. 새 화면에서 기존 기록을 먼저 확인하세요."
        : "검토 화면이 닫혀 있습니다. 새 화면 범위에서 먼저 열어 주세요."
        : notice?.frame === frame ? notice.text : "목록을 수동으로 불러온 뒤 삭제할 서비스를 직접 선택하세요."}</p>
    <p>화면 닫기·조회 취소는 이미 보낸 삭제를 되돌리지 않습니다. 이 화면의 원래 요청은 닫은 뒤 복구되지 않으므로 새 화면에서는 기존 기록을 먼저 확인하세요.</p>
    {visible && <div data-testid="catalog-service-delete-content" style={{ minWidth: 0 }}>
      {(phase === "selecting" || phase === "selected") && <fieldset ref={formNode} style={{ minWidth: 0 }}>
        <legend>불러온 서비스 중 삭제 선택</legend>
        <label htmlFor={`${id}-service`}>삭제할 서비스</label>
        <select id={`${id}-service`} value={selected?.row.serviceId ?? ""} disabled={!observation}
          style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
          onChange={(event) => { const value = event.currentTarget.value; choose(value); }}>
          <option value="">서비스를 직접 선택하세요</option>
          {services.map((entry) => <option key={entry.serviceId} value={entry.serviceId}>
            {entry.profile!.name} · {entry.serviceId} · 버전 {entry.serviceRevision}
          </option>)}
        </select>
        <p>선택만으로 삭제하지 않습니다. 목록 관찰이 바뀌면 보내지 않은 삭제 확인은 닫힙니다.</p>
        {selected && <button type="button" onClick={preview}>서비스 삭제 대상 미리보기</button>}
      </fieldset>}
      {pending && <div ref={decisionNode} role="group" aria-labelledby={`${id}-preview`} data-testid="catalog-service-delete-preview">
        <h3 id={`${id}-preview`}>{pending.phase === "preview" ? "서비스 삭제 대상·영향 확인" : "원래 서비스 삭제 요청"}</h3>
        <p>서비스 ID: {pending.record.request.body.serviceId} · 원래 버전: {pending.record.request.body.expectedRevision}</p>
        <p>선택 당시 서비스 이름: {pending.record.draft.row.profile!.name}</p>
        <p>선택 당시 제공자: {pending.record.draft.row.profile!.provider ?? "모름 (null)"}</p>
        <p id={`${id}-impact`}>이 앱의 해당 서비스 내용과 연결된 미리보기 내용을 삭제합니다. 되돌리기 기능은 없으며 재생 방지용 최소 표식은 남습니다.
          외부 계정·구독을 해지하거나 혜택·원본 메일·후보를 함께 삭제하지 않습니다.</p>
        {pending.phase === "preview" ? <>
          <button type="button" onClick={cancelPreview}>서비스 삭제 미리보기 취소</button>
          <label htmlFor={`${id}-confirm`}>서비스 삭제 확인 문구</label>
          <input id={`${id}-confirm`} value={pending.record.confirmation} autoComplete="off" maxLength={2}
            aria-describedby={`${id}-impact ${id}-confirm-help`} style={{ maxWidth: "100%", boxSizing: "border-box" }}
            onChange={(event) => { const value = event.currentTarget.value; confirmText(pending.record, value); }} />
          <p id={`${id}-confirm-help`}>대상과 영향을 확인했다면 ‘삭제’를 입력한 뒤 아래 버튼을 누르세요.</p>
          <button type="button" disabled={pending.record.confirmation !== "삭제"}
            onClick={() => { void execute(pending.record); }}>이 서비스 기록 삭제</button>
        </> : <>
          <p>새 선택이나 새 버전으로 원래 요청을 바꾸지 않습니다. 취소·응답 실패가 삭제 취소의 증거는 아닙니다.</p>
          <button type="button" disabled={pending.phase === "pending"}
            onClick={() => { void execute(pending.record); }}>같은 서비스 삭제 요청의 결과 다시 확인</button>
        </>}
      </div>}
      {completed && <div ref={resultNode} data-testid="catalog-service-delete-result" data-service-state={row?.state ?? "unavailable"}>
        <p>{row?.state === "deleted" && row.profile === null ? "삭제 응답 당시 이 앱의 서비스 기록은 삭제된 상태였습니다. 이전 내용은 표시하지 않습니다."
          : "삭제 응답에서 확인한 상태를 이 화면에 표시할 수 없습니다."}</p>
        <p>{completed.replayed ? "원래 삭제 요청을 재확인한 응답 당시의 상태입니다." : "삭제 요청의 응답 당시 확인한 상태입니다."} 이 표시는 목록 새로고침으로 바뀌지 않습니다. 목록은 직접 처음부터 다시 조회하세요.</p>
        <button type="button" onClick={fresh}>다른 서비스 삭제 준비</button>
      </div>}
    </div>}
  </section>;
}
