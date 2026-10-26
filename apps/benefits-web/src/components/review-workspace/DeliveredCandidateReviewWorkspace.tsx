import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createAnalysisDeliveryOwner } from "../../domain/analysis-delivery";
import { normalizeReviewWorkspaceContext } from "../../domain/review-client/workspace";
import { CatalogCandidateReviewWorkspace, type CatalogCandidateReviewWorkspaceProps } from "./CatalogCandidateReviewWorkspace";
import { createCompletionDeadline } from "./completion-deadline";

export interface DeliveredCandidateReviewWorkspaceProps extends Omit<CatalogCandidateReviewWorkspaceProps, "batchReference"> {
  /** Stable, owner-authorized completion observation port. MUST NOT start mail
   * reading, analysis, quota consumption or create a new run on retry. This
   * component does not establish authentication or mount a production route. */
  readonly readCompletion: (signal: AbortSignal) => Promise<unknown>;
}
const serverSnapshot = (): null => null;
const COMPLETION_TIMEOUT_MS = 10000;

/** A minimal saved receipt is not authority. Delivery, selection and candidate
 * reading are three separate explicit actions on the same review workspace.
 * Keep this composition mounted while changing the selected batch: remounting
 * the underlying review panel would discard an uncertain original command. */
export function DeliveredCandidateReviewWorkspace(props: DeliveredCandidateReviewWorkspaceProps) {
  const owner = useMemo(() => createAnalysisDeliveryOwner(), []);
  const pending = useRef<{ lease: object; abort: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const status = useRef<HTMLParagraphElement | null>(null), action = useRef<object | null>(null);
  const workspace = props.workspace;
  const active = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);
  const received = useSyncExternalStore(owner.subscribe, owner.getSnapshot, serverSnapshot);
  const expected = normalizeReviewWorkspaceContext(props.context);
  const bindingId = expected?.bindingId ?? null, dataGeneration = expected?.dataGeneration ?? null;
  const lease = active && active.context.bindingId === bindingId && active.context.dataGeneration === dataGeneration ? active.lease : null;
  const readCompletion = props.readCompletion;
  useLayoutEffect(() => {
    if (!lease || bindingId === null || dataGeneration === null) return;
    owner.activate({ lease, context: { bindingId, dataGeneration } });
    const stop = () => {
      owner.deactivate(lease);
      const request = pending.current;
      if (request?.lease === lease) {
        pending.current = null; clearTimeout(request.timer); request.abort.abort();
      }
    };
    const current = () => {
      const value = workspace.getSnapshot();
      return value?.lease === lease && value.context.bindingId === bindingId && value.context.dataGeneration === dataGeneration;
    };
    const detach = workspace.subscribe(() => { if (!current()) stop(); });
    if (!current()) stop();
    return () => { detach(); stop(); };
  }, [owner, workspace, lease, bindingId, dataGeneration, readCompletion]);
  const visible = received && received.lease === lease && received.context.bindingId === bindingId
    && received.context.dataGeneration === dataGeneration ? received : null;
  const current = () => visible !== null && workspace.getSnapshot()?.lease === lease && owner.getSnapshot() === visible;
  function act(control: HTMLButtonElement, perform: () => void) {
    if (control.disabled || action.current !== null || !current()) return;
    const token = {}; action.current = token;
    try {
      // Move only the explicitly activated control's focus before disabling it.
      // Async completion and layout effects must not steal focus from elsewhere.
      if (typeof document !== "undefined" && document.activeElement === control) status.current?.focus({ preventScroll: true });
      // focus() may synchronously close/reopen the workspace or reenter a button.
      if (action.current === token && current()) perform();
    } finally { if (action.current === token) action.current = null; }
  }
  function receive() {
    if (!visible || !lease || !current()) return;
    const ticket = owner.begin(visible); if (!ticket) return;
    const previous = pending.current;
    pending.current = null;
    if (previous) { clearTimeout(previous.timer); previous.abort.abort(); }
    const withinDeadline = createCompletionDeadline(props.clocks, COMPLETION_TIMEOUT_MS);
    if (!withinDeadline || workspace.getSnapshot()?.lease !== lease) { owner.deliver(ticket, null); return; }
    const abort = new AbortController();
    const request = { lease, abort, timer: setTimeout(() => {
      if (pending.current !== request) return;
      pending.current = null;
      owner.deliver(ticket, null); abort.abort();
    }, COMPLETION_TIMEOUT_MS) };
    pending.current = request;
    void Promise.resolve().then(() => {
      if (!withinDeadline() || pending.current !== request || workspace.getSnapshot()?.lease !== lease) throw Error("COMPLETION_CANCELLED");
      return readCompletion(abort.signal);
    }).then((receipt) => {
      if (pending.current === request && workspace.getSnapshot()?.lease === lease) {
        const allowed = withinDeadline();
        owner.deliver(ticket, allowed ? receipt : null);
        if (!allowed) abort.abort();
      }
    }, () => {
      if (pending.current === request && workspace.getSnapshot()?.lease === lease) owner.deliver(ticket, null);
    }).finally(() => {
      clearTimeout(request.timer);
      if (pending.current === request) pending.current = null;
    });
  }
  function cancel() {
    if (!visible || !current()) return;
    owner.cancel(visible);
    const request = pending.current; pending.current = null;
    if (request) { clearTimeout(request.timer); request.abort.abort(); }
  }
  return <section data-testid="delivered-candidate-workspace">
    <section data-testid="analysis-delivery" data-phase={visible?.phase ?? "closed"}>
      <h2>저장된 후보 묶음 확인</h2>
      <p>이미 실행한 분석의 저장 결과만 확인합니다. 메일을 다시 읽거나 분석·사용량 차감을 새로 시작하지 않습니다.</p>
      <button type="button" disabled={!visible || visible.phase === "receiving"}
        onClick={(event) => act(event.currentTarget, receive)}>저장 결과 받기·다시 확인</button>
      <button type="button" disabled={!visible || visible.phase !== "receiving"}
        onClick={(event) => act(event.currentTarget, cancel)}>결과 확인 취소</button>
      <button type="button" disabled={!visible || visible.phase !== "saved"}
        onClick={(event) => act(event.currentTarget, () => { if (visible && current()) owner.select(visible); })}>이 후보 묶음 검토하기</button>
      <p ref={status} role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}
        data-testid="analysis-delivery-status">{!visible ? "검토 화면을 먼저 열어 주세요."
        : visible.phase === "receiving" ? "저장 결과를 확인하고 있습니다. 취소해도 이미 저장된 기록을 되돌리지 않습니다."
        : visible.phase === "saved" ? "저장이 확인된 후보 묶음입니다. 검토할 묶음으로 직접 선택해 주세요."
        : visible.phase === "selected" ? "묶음을 선택했습니다. 서비스와 후보는 아래 버튼으로 직접 불러오세요."
        : visible.phase === "unconfirmed" ? "저장 결과를 확인하지 못했습니다. 저장 실패로 단정하지 말고 같은 결과를 직접 다시 확인하세요."
        : visible.phase === "expired" ? "이 화면에서의 확인이 만료되었습니다. 직접 다시 확인해 주세요."
        : "현재 선택된 저장 결과가 없습니다. 자동 조회하지 않습니다."}</p>
    </section>
    <CatalogCandidateReviewWorkspace workspace={workspace} context={props.context} client={props.client}
      batchReference={visible?.selectedReference ?? null} referenceTime={props.referenceTime}
      clocks={props.clocks} createOperationId={props.createOperationId} />
  </section>;
}
