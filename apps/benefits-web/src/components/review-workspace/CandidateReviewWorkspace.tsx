import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createCandidateSelection, type CandidateSelectionSnapshot, type CandidateSelectionBuildResult } from "../../domain/candidate-selection";
import { normalizeReviewWorkspaceContext, type ReviewWorkspace, type ReviewWorkspaceLease,
  type ReviewWorkspaceSnapshot } from "../../domain/review-client/workspace";
import { ReviewWorkspacePanel } from "./ReviewWorkspacePanel";

export interface CandidateReviewWorkspaceProps {
  readonly workspace: ReviewWorkspace;
  readonly context: unknown;
  /** One already-loaded minimal observation: {bindingId,dataGeneration,batch,services}. New observation = new object. */
  readonly source: unknown;
  readonly referenceTime: number;
  /** Trusted pure clocks; no provider or account lookup is performed here. */
  readonly clocks: () => { readonly wall: number; readonly monotonic: number };
  readonly createOperationId: () => unknown;
}
type Ready = Extract<CandidateSelectionBuildResult, { kind: "ready" }>;
interface Selected {
  readonly lease: ReviewWorkspaceLease;
  readonly input: unknown;
  readonly draft: Ready["draft"];
  readonly guard: () => boolean;
}
const serverSnapshot = (): null => null;

/** A composition over one known batch, not a global inbox, account discovery,
 * authentication, provider integration or public route. It reuses ONE review
 * lifecycle; changing a selection must not discard an uncertain write's token. */
export function CandidateReviewWorkspace(props: CandidateReviewWorkspaceProps) {
  const snapshot = useSyncExternalStore(props.workspace.subscribe, props.workspace.getSnapshot, serverSnapshot);
  const expected = normalizeReviewWorkspaceContext(props.context);
  const visible = snapshot && expected?.bindingId === snapshot.context.bindingId
    && expected.dataGeneration === snapshot.context.dataGeneration ? snapshot : null;
  const [selected, setSelected] = useState<Selected | null>(null);
  const receive = useCallback((value: Selected | null) => setSelected(value), []);
  const active = selected?.lease === visible?.lease && selected?.input === props.source ? selected : null;
  useLayoutEffect(() => {
    if (!visible || selected?.lease !== visible.lease || selected.input !== props.source) setSelected(null);
  }, [visible, props.source, selected]);
  return <ReviewWorkspacePanel workspace={props.workspace} context={props.context}
    draft={active?.draft ?? null} validateDraft={active?.guard ?? (() => false)}
    referenceTime={props.referenceTime} createOperationId={props.createOperationId}>
    {visible && <CandidatePicker workspace={props.workspace} snapshot={visible} input={props.source}
      clocks={props.clocks} receive={receive} />}
  </ReviewWorkspacePanel>;
}

interface PickerProps {
  readonly workspace: ReviewWorkspace;
  readonly snapshot: ReviewWorkspaceSnapshot;
  readonly input: unknown;
  readonly clocks: CandidateReviewWorkspaceProps["clocks"];
  readonly receive: (value: Selected | null) => void;
}
interface Choice { readonly candidateId: string; readonly serviceId: string; readonly name: string }
const emptyChoice = (): Choice => Object.freeze({ candidateId: "", serviceId: "", name: "" });
function CandidatePicker({ workspace, snapshot, input, clocks, receive }: PickerProps) {
  const id = useId(), lease = snapshot.lease;
  const owner = useMemo(() => createCandidateSelection(snapshot.context)!, [lease]);
  const timePort = useMemo(() => clocks, [lease]);
  const [observation, setObservation] = useState<{ owner: typeof owner; input: unknown; view: CandidateSelectionSnapshot } | null>(null);
  const [choice, setChoice] = useState<Choice>(emptyChoice);
  const [notice, setNotice] = useState("후보와 연결할 서비스를 각각 선택하세요. 자동 연결·저장은 하지 않습니다.");
  const committed = useRef<{ owner: typeof owner; input: unknown; choice: Choice } | null>(null);
  const alive = useRef(false);
  const statusNode = useRef<HTMLParagraphElement | null>(null), nameNode = useRef<HTMLInputElement | null>(null);
  const nameRef = useCallback((node: HTMLInputElement | null) => {
    if (!node && nameNode.current === document.activeElement && workspace.getSnapshot()?.lease === lease) {
      statusNode.current?.focus({ preventScroll: true });
    }
    nameNode.current = node;
  }, [workspace, lease]);
  const view = observation?.owner === owner && observation.input === input ? observation.view : null;
  const readTime = () => { try { return timePort(); } catch { return { wall: NaN, monotonic: NaN }; } };
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; committed.current = null; receive(null); };
  }, [owner, receive]);
  useLayoutEffect(() => {
    committed.current = { owner, input, choice };
  }, [owner, input, choice]);
  useLayoutEffect(() => {
    receive(null); setChoice(emptyChoice());
    const next = owner.observe(input, readTime());
    setObservation({ owner, input, view: next });
    setNotice(next.status === "ready" ? "불러온 한 묶음의 후보입니다. 전체 가입 내역이나 계정 증명이 아닙니다."
      : "이 화면에 맞는 후보·서비스 관찰을 확인하지 못했습니다. 새 관찰이 필요합니다.");
  }, [owner, input, receive]);
  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (stopped || !alive.current || committed.current?.owner !== owner || committed.current.input !== input
        || workspace.getSnapshot()?.lease !== lease) return;
      const old = owner.getSnapshot(), next = owner.check(readTime());
      if (next !== old) {
        receive(null); setChoice(emptyChoice()); setObservation({ owner, input, view: next });
        setNotice("후보 접근 기한이 지났거나 시각을 확인하지 못했습니다. 선택을 다시 확인하세요.");
      }
    };
    const timer = setInterval(tick, 250);
    return () => { stopped = true; clearInterval(timer); };
  }, [owner, lease, workspace, input, receive]);
  const current = () => alive.current && committed.current?.owner === owner && committed.current.input === input
    && committed.current.choice === choice && workspace.getSnapshot()?.lease === lease;
  const candidate = view?.candidates.find((entry) => entry.candidateId === choice.candidateId && entry.state === "pending");
  const needsName = candidate?.state === "pending" && candidate.content.values.name === null;
  function edit(next: Choice) {
    if (!current()) return;
    receive(null); setChoice(Object.freeze(next));
    setNotice("선택이 바뀌었습니다. 검토할 내용으로 가져오기를 다시 선택하세요.");
  }
  function choose() {
    if (!current()) return;
    if (needsName && choice.name === "") {
      receive(null); setNotice("원래 혜택 이름이 없습니다. 이름을 직접 입력하세요."); return;
    }
    const result = owner.build(choice.candidateId, choice.serviceId, needsName ? choice.name : null, readTime());
    if (!current()) return;
    setObservation({ owner, input, view: owner.getSnapshot() });
    if (result.kind !== "ready") {
      receive(null);
      setNotice(result.kind === "needs-name" ? "원래 혜택 이름이 없습니다. 이름을 직접 입력하세요."
        : "선택한 후보·서비스가 만료되었거나 유효하지 않습니다. 다시 확인하세요.");
      return;
    }
    const exact = JSON.stringify(result.draft);
    const guard = () => {
      if (!current()) return false;
      const checked = owner.build(choice.candidateId, choice.serviceId, needsName ? choice.name : null, readTime());
      if (!current()) return false;
      const allowed = checked.kind === "ready" && JSON.stringify(checked.draft) === exact;
      if (!allowed) { receive(null); setObservation({ owner, input, view: owner.getSnapshot() }); }
      return allowed;
    };
    receive({ lease, input, draft: result.draft, guard });
    setNotice("선택한 내용을 아래 검토 양식으로 가져왔습니다. 아직 요청하거나 저장하지 않았습니다.");
  }
  const pending = view?.candidates.filter((entry) => entry.state === "pending") ?? [];
  const services = view?.services.filter((entry) => entry.state === "live") ?? [];
  return <section aria-labelledby={`${id}-heading`} data-testid="candidate-picker" data-state={view?.status ?? "closed"}>
    <h3 id={`${id}-heading`}>후보와 연결할 서비스 선택</h3>
    <p ref={statusNode} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true">{notice}</p>
    <p>이메일에서 발견한 후보이지 가입·현재 잔액의 증명이 아닙니다. 서비스명이 같아도 자동으로 연결하지 않습니다.</p>
    <p>접근 기한은 이 후보를 검토할 수 있는 기한이며, 혜택 만료일과 다릅니다.</p>
    <fieldset disabled={view?.status !== "ready"} style={{ minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}><legend>명시적으로 연결 선택</legend>
      <label htmlFor={`${id}-candidate`}>검토할 후보</label>
      <select id={`${id}-candidate`} value={choice.candidateId} style={{ width: "100%", maxWidth: "100%", boxSizing: "border-box" }}
        onChange={(event) => edit({ ...choice, candidateId: event.target.value, name: "" })}>
        <option value="">후보를 선택하세요</option>
        {pending.map((entry) => entry.state === "pending" && <option key={entry.candidateId} value={entry.candidateId}>
          {entry.content.values.name ?? "이름 없음"} · 추출된 서비스: {entry.content.serviceName} · {entry.candidateId}
        </option>)}
      </select>
      <label htmlFor={`${id}-service`}>연결할 기존 서비스</label>
      <select id={`${id}-service`} value={choice.serviceId} style={{ width: "100%", maxWidth: "100%", boxSizing: "border-box" }}
        onChange={(event) => edit({ ...choice, serviceId: event.target.value })}>
        <option value="">서비스를 직접 선택하세요</option>
        {services.map((entry) => entry.state === "live" && entry.profile && <option key={entry.serviceId} value={entry.serviceId}>
          {entry.profile.name} · {entry.serviceId} · 버전 {entry.serviceRevision}
        </option>)}
      </select>
      {needsName && <div><label htmlFor={`${id}-name`}>이름 없는 후보에 붙일 혜택 이름</label>
        <input ref={nameRef} id={`${id}-name`} type="text" maxLength={160} autoComplete="off" spellCheck={false} aria-required="true"
          value={choice.name} style={{ maxWidth: "100%", boxSizing: "border-box" }}
          onChange={(event) => edit({ ...choice, name: event.target.value })} /></div>}
      <button type="button" disabled={!candidate || !choice.serviceId} onClick={choose}>검토할 내용으로 가져오기</button>
    </fieldset>
    {view?.status === "ready" && <p>불러온 후보 {view.candidates.length}개 중 검토 가능 {pending.length}개 ·
      연결 가능한 기존 서비스 {services.length}개. 처리됨·삭제됨·만료 후보의 내용은 표시하지 않습니다.</p>}
    <p>불확실한 저장·삭제 요청은 아래에 남은 원래 요청으로 결과를 다시 확인하세요. 새 선택이 그 요청을 취소하지는 않습니다.</p>
  </section>;
}
