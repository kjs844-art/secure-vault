import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createCatalogSelectionSource } from "../../domain/catalog-client/selection-source";
import { normalizeReviewWorkspaceContext } from "../../domain/review-client/workspace";
import { LoadedCandidateReviewWorkspace, type LoadedCandidateReviewWorkspaceProps } from "./LoadedCandidateReviewWorkspace";
import { CatalogServiceCreatePanel } from "./CatalogServiceCreatePanel";
import { CatalogServiceUpdatePanel } from "./CatalogServiceUpdatePanel";
import { CatalogServiceDeletePanel } from "./CatalogServiceDeletePanel";
import { CatalogServiceDetailsPanel } from "./CatalogServiceDetailsPanel";

export type CatalogCandidateReviewWorkspaceProps = Omit<LoadedCandidateReviewWorkspaceProps, "services">;
const serverSnapshot = (): null => null;

/** Two explicitly loaded observations, one review workspace. Does not establish
 * authentication or enumerate provider accounts. No automatic paging, matching,
 * saving, retries, route mounting or second review lifecycle. */
export function CatalogCandidateReviewWorkspace(props: CatalogCandidateReviewWorkspaceProps) {
  const catalog = useMemo(() => createCatalogSelectionSource({ origin: props.client.origin, fetch: props.client.fetch,
    ...(props.client.timeoutMs === undefined ? {} : { timeoutMs: props.client.timeoutMs }) }), [props.client]);
  const workspace = props.workspace;
  const selectionStatus = useRef<HTMLParagraphElement | null>(null), cancelling = useRef(false);
  const active = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);
  const listed = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, serverSnapshot);
  const expected = normalizeReviewWorkspaceContext(props.context);
  const bindingId = expected?.bindingId ?? null, dataGeneration = expected?.dataGeneration ?? null;
  const lease = active && active.context.bindingId === bindingId && active.context.dataGeneration === dataGeneration ? active.lease : null;
  const frame = useMemo(() => Object.freeze({ workspace, catalog, lease, bindingId, dataGeneration }),
    [workspace, catalog, lease, bindingId, dataGeneration]);
  const committedFrame = useRef<typeof frame | null>(null);
  useLayoutEffect(() => {
    committedFrame.current = frame;
    return () => { if (committedFrame.current === frame) committedFrame.current = null; };
  }, [frame]);
  useLayoutEffect(() => {
    if (!lease || bindingId === null || dataGeneration === null) return;
    catalog.activate({ lease, context: { bindingId, dataGeneration } });
    const current = () => {
      const value = workspace.getSnapshot();
      return value?.lease === lease && value.context.bindingId === bindingId && value.context.dataGeneration === dataGeneration;
    };
    const detach = workspace.subscribe(() => { if (!current()) catalog.deactivate(lease); });
    if (!current()) catalog.deactivate(lease);
    return () => { detach(); catalog.deactivate(lease); };
  }, [workspace, catalog, lease, bindingId, dataGeneration]);
  const visible = listed && listed.lease === lease && listed.context.bindingId === bindingId
    && listed.context.dataGeneration === dataGeneration ? listed : null;
  useLayoutEffect(() => {
    const failure = visible?.failure;
    if (lease && workspace.getSnapshot()?.lease === lease && failure?.kind === "error"
      && ["API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_REQUEST_REJECTED"].includes(failure.code)) workspace.deactivate(lease);
  }, [workspace, lease, visible]);
  const services = useMemo(() => visible && (visible.phase === "more" || visible.phase === "end_observed")
    ? Object.freeze({ bindingId: visible.context.bindingId, dataGeneration: visible.context.dataGeneration,
      services: visible.services }) : null, [visible]);
  const current = () => committedFrame.current === frame && !cancelling.current && visible !== null
    && workspace.getSnapshot()?.lease === lease && catalog.getSnapshot() === visible;
  function cancelSelection(button: HTMLButtonElement) {
    if (!current() || !visible || visible.phase !== "loading") return;
    const document = button.ownerDocument, ownedFocus = document.activeElement === button, target = selectionStatus.current;
    cancelling.current = true;
    try {
      // Retire the request before focus() can synchronously invoke another host
      // listener. Reentrant selection buttons cannot start a new traversal here.
      if (!catalog.cancel(visible) || !ownedFocus) return;
      const after = catalog.getSnapshot(), currentWorkspace = workspace.getSnapshot();
      if (committedFrame.current !== frame || !after || after === visible || after.phase !== "restart_required" || after.lease !== lease
        || after.context.bindingId !== bindingId || after.context.dataGeneration !== dataGeneration
        || currentWorkspace?.lease !== lease || currentWorkspace.context.bindingId !== bindingId
        || currentWorkspace.context.dataGeneration !== dataGeneration
        || catalog.getSnapshot() !== after || !button.isConnected || !target?.isConnected || selectionStatus.current !== target) return;
      // Do not claim body focus as ours: a synchronous observer may deliberately
      // have moved it. Restore only while the original button still owns focus.
      if (document.activeElement !== button) return;
      target.focus({ preventScroll: true });
    } finally { cancelling.current = false; }
  }
  const next = visible && ["ready", "more", "retry_required"].includes(visible.phase);
  return <section data-testid="catalog-candidate-workspace">
    <section data-testid="catalog-selection" data-phase={visible?.phase ?? "closed"}
      data-pages={visible?.pagesAccepted ?? 0} data-rows={visible?.services.length ?? 0}>
      <h2>연결할 서비스 목록 불러오기</h2>
      <p>이 목록은 KeyAtlas에 기록한 서비스만 조회합니다. 다른 플랫폼의 가입 여부를 자동 확인하지 않습니다. 새 기록은 아래 별도 확인 절차로 직접 만듭니다.</p>
      <p>한 번에 최대 50개씩 조회합니다. 목록을 새로 조회하면 현재 선택은 해제되지만, 이미 저장한 기록과 결과 재확인 요청은 유지됩니다.</p>
      <button type="button" disabled={!next}
        onClick={() => { if (current() && visible) void catalog.next(visible); }}>서비스 다음 목록 불러오기</button>
      <button type="button" disabled={!visible || visible.phase === "loading"}
        onClick={() => { if (current() && visible) catalog.restart(visible); }}>서비스 목록 처음부터 다시 확인</button>
      <button type="button" disabled={!visible || visible.phase !== "loading"}
        onClick={(event) => cancelSelection(event.currentTarget)}>서비스 조회 취소</button>
      <p ref={selectionStatus} tabIndex={-1} data-testid="catalog-selection-status" role="status" aria-live="polite" aria-atomic="true">{!visible ? "검토 화면을 먼저 열어 주세요."
        : visible.phase === "loading" ? "서비스 목록을 불러오는 중입니다. 현재 선택은 잠시 해제됩니다."
        : visible.phase === "restart_required" ? "목록이 바뀌었거나 조회가 취소·제한되었습니다. 처음부터 다시 확인한 뒤 직접 불러오세요."
        : visible.phase === "retry_required" ? "목록을 확인하지 못했습니다. 연결 상태를 확인한 뒤 직접 다시 조회하세요."
        : visible.phase === "more" ? `서비스 목록 일부를 불러왔습니다. ${visible.pagesAccepted}페이지를 조회했고 다음 목록이 있습니다.`
        : visible.phase === "end_observed" ? `이번 조회의 끝까지 확인했습니다. ${visible.pagesAccepted}페이지의 관찰이며 전체 가입 내역·현재 상태의 증명은 아닙니다.`
        : "아직 조회하지 않았습니다. 버튼을 누르면 첫 목록을 불러옵니다."}</p>
      {services && <p>현재 불러온 관찰 {services.services.length}개 중 연결 가능한 서비스는 {services.services.filter((row) => row.state === "live").length}개입니다.</p>}
    </section>
    <CatalogServiceDetailsPanel workspace={workspace} context={props.context} source={catalog} />
    <CatalogServiceCreatePanel workspace={workspace} context={props.context} client={props.client}
      createOperationId={props.createOperationId}
      onCatalogInvalidated={(capturedLease) => {
        const observation = catalog.getSnapshot();
        if (workspace.getSnapshot()?.lease === capturedLease && observation?.lease === capturedLease) catalog.cancel(observation);
      }}
      onAuthorityRejected={(capturedLease) => {
        if (workspace.getSnapshot()?.lease === capturedLease) workspace.deactivate(capturedLease);
      }} />
    <LoadedCandidateReviewWorkspace workspace={workspace} context={props.context} client={props.client}
      batchReference={props.batchReference} services={services} referenceTime={props.referenceTime}
      clocks={props.clocks} createOperationId={props.createOperationId} />
    <CatalogServiceUpdatePanel workspace={workspace} context={props.context} client={props.client} source={catalog}
      createOperationId={props.createOperationId}
      onCatalogInvalidated={(capturedLease) => {
        const observation = catalog.getSnapshot();
        if (workspace.getSnapshot()?.lease === capturedLease && observation?.lease === capturedLease) catalog.cancel(observation);
      }}
      onAuthorityRejected={(capturedLease) => {
        if (workspace.getSnapshot()?.lease === capturedLease) workspace.deactivate(capturedLease);
      }} />
    <CatalogServiceDeletePanel workspace={workspace} context={props.context} client={props.client} source={catalog}
      createOperationId={props.createOperationId}
      onCatalogInvalidated={(capturedLease) => {
        const observation = catalog.getSnapshot();
        if (workspace.getSnapshot()?.lease === capturedLease && observation?.lease === capturedLease) catalog.cancel(observation);
      }}
      onAuthorityRejected={(capturedLease) => {
        if (workspace.getSnapshot()?.lease === capturedLease) workspace.deactivate(capturedLease);
      }} />
  </section>;
}
