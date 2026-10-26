import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createCandidateDiscardClient } from "../../domain/candidate-discard-client";
import { createCandidateDiscardOwner } from "../../domain/candidate-discard-owner";
import type { CandidateBatchClientConfig } from "../../domain/candidate-batch-client";
import type { CandidateBatchReader, CandidateBatchReaderSnapshot } from "../../domain/candidate-batch-reader";
import { normalizeReviewWorkspaceContext, type ReviewWorkspace } from "../../domain/review-client/workspace";

export interface CandidateDiscardPanelProps {
  readonly workspace: ReviewWorkspace;
  readonly context: unknown;
  readonly batchReference: string | null;
  readonly reader: CandidateBatchReader;
  readonly client: Omit<CandidateBatchClientConfig, "readContext">;
}
const serverSnapshot = (): null => null;

/** Pending candidate content only. Does not delete saved benefits or mail,
 * enumerate an inbox, or activate a workspace. The sibling review panel stays
 * mounted so clearing an observation never releases an uncertain review write. */
export function CandidateDiscardPanel(props: CandidateDiscardPanelProps) {
  const id = useId(), workspace = props.workspace, reader = props.reader;
  const authority = useRef<{ owner: ReturnType<typeof createCandidateDiscardOwner>; workspace: ReviewWorkspace; lease: object } | null>(null);
  const owner = useMemo(() => {
    let value: ReturnType<typeof createCandidateDiscardOwner> | undefined;
    const client = createCandidateDiscardClient({ ...props.client, readContext: () => value?.getContext() ?? null });
    value = createCandidateDiscardOwner(client, () => {
      const held = authority.current;
      if (held && held.owner === value) { authority.current = null; held.workspace.deactivate(held.lease); }
    }); return value;
  }, [props.client]);
  const active = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);
  const observed = useSyncExternalStore(reader.subscribe, reader.getSnapshot, serverSnapshot);
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, serverSnapshot);
  const expected = normalizeReviewWorkspaceContext(props.context);
  const bindingId = expected?.bindingId ?? null, generation = expected?.dataGeneration ?? null;
  const lease = active && active.context.bindingId === bindingId && active.context.dataGeneration === generation ? active.lease : null;
  const reference = typeof props.batchReference === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(props.batchReference)
    && props.batchReference.trim() === props.batchReference ? props.batchReference : null;
  // A delivery receipt refresh temporarily clears its selected reference. That
  // is NOT retirement of the external workspace or an already attempted write.
  const frame = useMemo(() => Object.freeze({ workspace, reader, owner, lease, bindingId, generation }),
    [workspace, reader, owner, lease, bindingId, generation]);
  const committed = useRef<typeof frame | null>(null), busy = useRef(false);
  const renderIdentity = Object.freeze({});
  const committedEvent = useRef<object | null>(null);
  const preparedObservation = useRef<CandidateBatchReaderSnapshot | null>(null);
  const status = useRef<HTMLParagraphElement | null>(null), controls = useRef<HTMLDivElement | null>(null);
  const [choice, setChoice] = useState<{ frame: typeof frame; observation: CandidateBatchReaderSnapshot; id: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ request: unknown; text: string } | null>(null);
  const [notice, setNotice] = useState<{ frame: typeof frame; text: string } | null>(null);
  const current = () => {
    const live = workspace.getSnapshot();
    return committed.current === frame && lease !== null && live?.lease === lease
      && live.context.bindingId === bindingId && live.context.dataGeneration === generation;
  };
  const eventCurrent = () => current() && committedEvent.current === renderIdentity;
  const observationCurrent = (value: CandidateBatchReaderSnapshot | null): value is CandidateBatchReaderSnapshot =>
    value !== null && current() && reader.getSnapshot() === value && value.lease === lease
    && value.context.bindingId === bindingId && value.context.dataGeneration === generation
    && value.context.batchReference === reference && value.context.batchReference === owner.getContext()?.batchReference
    && value.phase === "ready" && value.batch !== null;
  function moveOwnedFocus() {
    const node = controls.current;
    if (current() && node?.contains(node.ownerDocument.activeElement)) status.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    committed.current = frame;
    return () => { if (committed.current === frame) committed.current = null; };
  }, [frame]);
  useLayoutEffect(() => {
    committedEvent.current = renderIdentity;
    return () => { if (committedEvent.current === renderIdentity) committedEvent.current = null; };
  });
  useLayoutEffect(() => {
    const matches = () => {
      const live = workspace.getSnapshot();
      return lease !== null && live?.lease === lease && live.context.bindingId === bindingId && live.context.dataGeneration === generation;
    };
    const detach = workspace.subscribe(() => { if (!matches() && lease) owner.deactivate(lease); });
    if (matches() && lease) {
      authority.current = { owner, workspace, lease };
    }
    if (!matches() && lease) owner.deactivate(lease);
    return () => {
      detach(); if (authority.current?.owner === owner && authority.current.lease === lease) authority.current = null;
      if (lease) owner.deactivate(lease); preparedObservation.current = null;
    };
  }, [frame]);
  useLayoutEffect(() => {
    // One command reference per outer lease. A different selected batch cannot
    // silently replace the original uncertain request. Close/reopen explicitly
    // to begin a different lifetime after resolving the original result.
    if (current() && lease && bindingId !== null && generation !== null && reference !== null && owner.getSnapshot() === null)
      owner.activate({ lease, context: { bindingId, dataGeneration: generation, batchReference: reference } });
  }, [frame, reference]);
  useLayoutEffect(() => {
    const changed = () => {
      if (!current()) return;
      const held = owner.getSnapshot();
      // List refresh retires only an UNSENT decision. It never cancels a sent
      // request, changes its revision, or claims that a server write rolled back.
      if (held?.phase === "prepared" && !observationCurrent(preparedObservation.current)) {
        busy.current = true;
        try {
          if (owner.cancelPrepared(held) && current()) {
            preparedObservation.current = null; moveOwnedFocus();
            setNotice({ frame, text: "후보 관찰이 바뀌어 보내지 않은 확인을 닫았습니다. 새로 불러온 대상을 다시 선택하세요." });
          }
        } finally { busy.current = false; }
      }
    };
    const detach = reader.subscribe(changed); changed(); return detach;
  }, [frame]);
  const visible = lease && state?.lease === lease && state.context.bindingId === bindingId
    && state.context.dataGeneration === generation ? state : null;
  const observation = observed?.lease === lease && observed.context.bindingId === bindingId
    && observed.context.dataGeneration === generation && observed.context.batchReference === reference
    && observed.context.batchReference === visible?.context.batchReference
    && observed.phase === "ready" ? observed : null;
  // Deliberately show NO candidate content. The reader's raw observation is not
  // a clock-aware access lease; IDs/revisions also identify expired candidates.
  const candidates = observation?.batch?.candidates.filter((entry) => entry.state === "pending" || entry.state === "expired") ?? [];
  const selected = choice?.frame === frame && choice.observation === observation
    ? candidates.find((entry) => entry.candidateId === choice.id) ?? null : null;
  const request = visible?.request ?? null;
  const typed = confirmation?.request === request ? confirmation.text : "";
  const locked = !visible || ["prepared", "sending", "uncertain"].includes(visible.phase);
  const phase = visible?.phase ?? "closed";
  function prepare() {
    if (busy.current || !eventCurrent() || !visible || owner.getSnapshot() !== visible || locked || !selected || !observationCurrent(observation)) return;
    busy.current = true;
    try {
      preparedObservation.current = observation;
      const prepared = owner.prepare(visible, { candidateId: selected.candidateId, expectedRevision: selected.candidateRevision });
      if (!prepared || !current()) { preparedObservation.current = null; return; }
      if (!observationCurrent(observation)) { owner.cancelPrepared(prepared); preparedObservation.current = null; return; }
      setConfirmation(null); setNotice(null);
    } finally { busy.current = false; }
  }
  function cancel() {
    if (busy.current || !eventCurrent() || visible?.phase !== "prepared" || owner.getSnapshot() !== visible) return;
    busy.current = true;
    try {
      if (owner.cancelPrepared(visible) && current()) {
        preparedObservation.current = null; moveOwnedFocus(); setConfirmation(null);
        setNotice({ frame, text: "보내지 않은 폐기 확인을 취소했습니다. 폐기 요청은 전송하지 않았습니다." });
      }
    } finally { busy.current = false; }
  }
  async function send(reconcile: boolean) {
    if (busy.current || !eventCurrent() || !visible || owner.getSnapshot() !== visible) return;
    if (reconcile ? visible.phase !== "uncertain" : visible.phase !== "prepared" || typed !== "폐기"
      || !observationCurrent(preparedObservation.current)) return;
    busy.current = true;
    try {
      // Retiring the focused confirmation controls must not leave keyboard
      // focus on body. Focus handlers are synchronous and may revoke authority.
      moveOwnedFocus();
      if (!eventCurrent() || owner.getSnapshot() !== visible) return;
      const result = await (reconcile ? owner.reconcile(visible) : owner.execute(visible));
      if (!current()) return;
      const after = owner.getSnapshot();
      if (result && after?.phase === "succeeded") {
        const latest = reader.getSnapshot();
        // Invalidate only this known-batch observation, without remounting the
        // sibling workspace or releasing its original uncertain command token.
        if (latest?.lease === lease && latest.context.bindingId === bindingId
          && latest.context.dataGeneration === generation && latest.context.batchReference === after.context.batchReference) reader.cancel(latest);
      }
      if (current()) moveOwnedFocus();
    } finally { busy.current = false; }
  }
  return <section data-testid="candidate-discard" data-phase={phase} aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>미확정 후보 내용 폐기</h3>
    <p ref={status} tabIndex={-1} data-testid="candidate-discard-status" role="status" aria-live="polite" aria-atomic="true">
      {!visible ? "검토 화면을 먼저 열어 주세요." : phase === "sending" ? "원래 대상의 폐기 결과를 확인 중입니다. 응답을 기다려 주세요."
        : phase === "uncertain" ? "결과를 확인하지 못했습니다. 이미 폐기되었을 수도 있습니다. 같은 대상·버전의 원래 요청만 다시 확인할 수 있습니다."
        : phase === "succeeded" ? "해당 후보 내용이 폐기된 상태임을 확인했습니다. 새 후보 목록은 직접 다시 불러오세요."
        : phase === "rejected" ? "전송 전 확인에 실패했습니다. 폐기 요청을 보내지 않았습니다. 후보와 연결 상태를 다시 확인하세요."
        : notice?.frame === frame ? notice.text : phase === "prepared" ? "아래 대상과 영향을 확인하세요. 아직 폐기 요청을 보내지 않았습니다."
        : "후보를 직접 선택해 폐기 대상을 확인하세요. 선택만으로 요청하지 않습니다."}
    </p>
    {visible && <div ref={controls} onKeyDown={(event) => { if (event.key === "Escape" && phase === "prepared") { event.preventDefault(); cancel(); } }}>
      <p id={`${id}-impact`}>선택한 미확정 후보와 연결된 미리보기의 내용을 이 앱에서 폐기합니다. 되돌리기 기능은 없으며 최소 처리 표식은 남습니다.
        이미 저장된 혜택·원본 메일·외부 계정은 삭제하지 않습니다. 검토 기한 종료와 내용 폐기는 서로 다릅니다.</p>
      <label htmlFor={`${id}-target`}>폐기할 후보 식별자</label>
      <select id={`${id}-target`} value={selected?.candidateId ?? ""} disabled={locked || !observation}
        style={{ maxWidth: "100%", width: "100%", boxSizing: "border-box" }}
        onChange={(event) => {
          if (busy.current || !eventCurrent() || locked || !visible || owner.getSnapshot() !== visible || !observationCurrent(observation)) return;
          committedEvent.current = null;
          setChoice({ frame, observation, id: event.target.value }); setNotice(null);
        }}>
        <option value="">대상을 직접 선택하세요</option>
        {candidates.map((entry) => <option key={entry.candidateId} value={entry.candidateId}>{entry.candidateId} · 버전 {entry.candidateRevision}</option>)}
      </select>
      <button type="button" disabled={locked || !selected} onClick={prepare}>후보 폐기 대상 확인</button>
      {request && <dl data-testid="candidate-discard-target" style={{ overflowWrap: "anywhere" }}>
        <dt>후보 식별자</dt><dd>{request.candidateId}</dd><dt>요청한 버전</dt><dd>{request.expectedRevision}</dd>
      </dl>}
      {phase === "prepared" && <div>
        <label htmlFor={`${id}-confirm`}>폐기 확인 문구</label>
        <input id={`${id}-confirm`} value={typed} autoComplete="off" aria-describedby={`${id}-impact`}
          style={{ maxWidth: "100%", boxSizing: "border-box" }} onChange={(event) => {
            if (!busy.current && eventCurrent() && owner.getSnapshot() === visible) {
              committedEvent.current = null; setConfirmation({ request, text: event.target.value });
            }
          }} />
        <p>계속하려면 ‘폐기’를 입력하세요.</p>
        <button type="button" onClick={cancel}>폐기 확인 취소</button>
        <button type="button" disabled={typed !== "폐기"} onClick={() => void send(false)}>이 후보 내용 폐기</button>
      </div>}
      {phase === "uncertain" && <button type="button" onClick={() => void send(true)}>같은 폐기 요청 결과 다시 확인</button>}
      {phase === "succeeded" && visible.receipt && <p data-testid="candidate-discard-receipt">
        확인된 처리 버전 {visible.receipt.candidateRevision} · 내용 없음. 이 확인은 새 폐기인지 이전 요청의 재확인인지 구분하지 않습니다.</p>}
      <p>다른 화면에서 이미 보낸 저장·삭제 요청은 취소되지 않습니다. 불확실한 요청은 원래 요청으로 별도 확인하세요.</p>
      {reference !== null && reference !== visible.context.batchReference && <p>다른 후보 묶음이 선택되어 있습니다.
        남은 원래 요청을 먼저 확인하세요. 다른 묶음의 폐기는 검토 화면을 닫고 다시 연 뒤 시작할 수 있습니다.</p>}
    </div>}
  </section>;
}
