import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createCandidateBatchClient, type CandidateBatchClientConfig } from "../../domain/candidate-batch-client";
import { createCandidateBatchReader } from "../../domain/candidate-batch-reader";
import { normalizeReviewWorkspaceContext } from "../../domain/review-client/workspace";
import { CandidateReviewWorkspace, type CandidateReviewWorkspaceProps } from "./CandidateReviewWorkspace";

export interface LoadedCandidateReviewWorkspaceProps extends Omit<CandidateReviewWorkspaceProps, "source"> {
  /** Stable injected transport. No ambient fetch or implicit account connection. */
  readonly client: Omit<CandidateBatchClientConfig, "readContext">;
  /** A known opaque lookup alias, never authentication or a raw analysis ID. */
  readonly batchReference: string | null;
  /** Already-loaded catalog observation: {bindingId,dataGeneration,services}. */
  readonly services: unknown;
}
const serverSnapshot = (): null => null;
function servicesFor(input: unknown, bindingId: string, dataGeneration: number): unknown {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input), fields = Object.getOwnPropertyDescriptors(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(fields);
    if (keys.length !== 3 || keys.some((key) => !["bindingId", "dataGeneration", "services"].includes(String(key)))) return null;
    if (keys.some((key) => typeof key !== "string" || !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, "value"))) return null;
    if (fields.bindingId?.value !== bindingId || fields.dataGeneration?.value !== dataGeneration) return null;
    return fields.services?.value as unknown;
  } catch { return null; }
}

/** Explicitly loads one known candidate batch. Keeps the underlying review
 * component/lease stable during refresh/cancel, preserving uncertain writes.
 * It never activates a second review workspace, fetches on mount, or loads a
 * user's mailbox. The existing review hook owns native hide/back revocation. */
export function LoadedCandidateReviewWorkspace(props: LoadedCandidateReviewWorkspaceProps) {
  const reader = useMemo(() => {
    let owned: ReturnType<typeof createCandidateBatchReader> | undefined;
    const client = createCandidateBatchClient({ ...props.client, readContext: () => owned?.getContext() ?? null });
    owned = createCandidateBatchReader(client);
    return owned;
  }, [props.client]);
  const workspace = props.workspace;
  const readStatus = useRef<HTMLParagraphElement | null>(null), cancelling = useRef(false);
  const active = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);
  const loaded = useSyncExternalStore(reader.subscribe, reader.getSnapshot, serverSnapshot);
  const expected = normalizeReviewWorkspaceContext(props.context);
  const bindingId = expected?.bindingId ?? null, dataGeneration = expected?.dataGeneration ?? null;
  const lease = active && active.context.bindingId === bindingId && active.context.dataGeneration === dataGeneration ? active.lease : null;
  const reference = typeof props.batchReference === "string" && props.batchReference.trim() === props.batchReference
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(props.batchReference)
    ? props.batchReference : null;
  const frame = useMemo(() => Object.freeze({ workspace, reader, lease, bindingId, dataGeneration, reference }),
    [workspace, reader, lease, bindingId, dataGeneration, reference]);
  const committedFrame = useRef<typeof frame | null>(null);
  useLayoutEffect(() => {
    committedFrame.current = frame;
    return () => { if (committedFrame.current === frame) committedFrame.current = null; };
  }, [frame]);
  useLayoutEffect(() => {
    if (!lease || bindingId === null || dataGeneration === null || reference === null) return;
    reader.activate({ lease, context: { bindingId, dataGeneration, batchReference: reference } });
    const current = () => {
      const snapshot = workspace.getSnapshot();
      return snapshot?.lease === lease && snapshot.context.bindingId === bindingId && snapshot.context.dataGeneration === dataGeneration;
    };
    const detach = workspace.subscribe(() => { if (!current()) reader.deactivate(lease); });
    if (!current()) reader.deactivate(lease);
    return () => { detach(); reader.deactivate(lease); };
  }, [reader, workspace, lease, bindingId, dataGeneration, reference]);
  const visible = loaded && loaded.lease === lease && loaded.context.bindingId === bindingId
    && loaded.context.dataGeneration === dataGeneration && loaded.context.batchReference === reference ? loaded : null;
  useLayoutEffect(() => {
    const failure = visible?.failure;
    if (lease && workspace.getSnapshot()?.lease === lease && (failure?.kind === "error"
      && ["API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_REQUEST_REJECTED"].includes(failure.code)
      || failure?.kind === "invalid" && failure.reason === "CLOCK")) workspace.deactivate(lease);
  }, [workspace, visible, lease]);
  const source = useMemo(() => {
    if (!visible || visible.phase !== "ready" || !visible.batch) return null;
    const services = servicesFor(props.services, visible.context.bindingId, visible.context.dataGeneration);
    return services === null ? null : Object.freeze({ bindingId: visible.context.bindingId,
      dataGeneration: visible.context.dataGeneration, batch: visible.batch, services });
  }, [visible, props.services]);
  const current = () => committedFrame.current === frame && !cancelling.current && visible !== null
    && workspace.getSnapshot()?.lease === lease && reader.getSnapshot() === visible;
  function cancelRead(button: HTMLButtonElement) {
    if (!current() || !visible || visible.phase !== "loading") return;
    const document = button.ownerDocument, ownedFocus = document.activeElement === button, target = readStatus.current;
    cancelling.current = true;
    try {
      // Retire the read first. Abort listeners can synchronously close the
      // workspace or move focus, so the returned boolean alone is not authority.
      if (!reader.cancel(visible) || !ownedFocus) return;
      const after = reader.getSnapshot(), currentWorkspace = workspace.getSnapshot();
      if (committedFrame.current !== frame || !after || after === visible || after.phase !== "idle" || after.lease !== lease
        || after.context.bindingId !== bindingId || after.context.dataGeneration !== dataGeneration
        || after.context.batchReference !== reference || currentWorkspace?.lease !== lease
        || currentWorkspace.context.bindingId !== bindingId || currentWorkspace.context.dataGeneration !== dataGeneration
        || reader.getSnapshot() !== after || !button.isConnected || !target?.isConnected || readStatus.current !== target) return;
      // Never reclaim body/external focus that another listener chose. Reentrant
      // clicks during focus delivery also cannot create a replacement read.
      if (document.activeElement !== button) return;
      target.focus({ preventScroll: true });
    } finally { cancelling.current = false; }
  }
  return <section data-testid="candidate-loader" data-phase={visible?.phase ?? "closed"}>
    <h2>후보 다시 불러오기</h2>
    <p>이미 알고 있는 후보 묶음 한 개만 조회합니다. 전체 가입 내역·현재 잔액을 확인하는 기능은 아닙니다.</p>
    <button type="button" disabled={!visible || visible.phase === "loading"}
      onClick={() => { if (current() && visible) void reader.read(visible); }}>후보 불러오기·새로 확인</button>
    <button type="button" disabled={!visible || visible.phase !== "loading"}
      onClick={(event) => cancelRead(event.currentTarget)}>후보 조회 취소</button>
    <p ref={readStatus} tabIndex={-1} data-testid="candidate-loader-status" role="status" aria-live="polite" aria-atomic="true">{!visible ? "검토 화면을 먼저 열어 주세요."
      : visible.phase === "loading" ? "후보를 불러오는 중입니다. 취소해도 이미 저장된 기록은 삭제되지 않습니다."
      : visible.phase === "failed" ? "후보를 확인하지 못했습니다. 화면과 연결 상태를 확인한 뒤 직접 다시 조회하세요."
      : visible.phase === "ready" ? "후보 묶음을 불러왔습니다. 연결할 서비스를 직접 선택하세요."
      : "조회 버튼을 누르면 후보를 불러옵니다. 자동 조회하지 않습니다."}</p>
    <CandidateReviewWorkspace workspace={workspace} context={props.context} source={source}
      referenceTime={props.referenceTime} clocks={props.clocks} createOperationId={props.createOperationId} />
  </section>;
}
