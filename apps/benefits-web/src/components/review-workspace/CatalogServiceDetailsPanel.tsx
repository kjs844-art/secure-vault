import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CatalogSelectionSource, CatalogSelectionSnapshot } from "../../domain/catalog-client/selection-source";
import type { CatalogServiceView } from "../../domain/catalog-client/responses";
import { isCatalogDetailSearchQuery, MAX_CATALOG_DETAIL_QUERY_LENGTH, searchCatalogDetailRows } from "../../domain/catalog-detail-search";
import { normalizeReviewWorkspaceContext, type ReviewWorkspace, type ReviewWorkspaceLease } from "../../domain/review-client/workspace";
import { CatalogServiceDetails } from "./CatalogServiceDetails";

export interface CatalogServiceDetailsPanelProps {
  readonly workspace: ReviewWorkspace;
  readonly context: unknown;
  readonly source: CatalogSelectionSource;
}
const serverSnapshot = (): null => null;
interface Frame {
  readonly workspace: ReviewWorkspace;
  readonly source: CatalogSelectionSource;
  readonly lease: ReviewWorkspaceLease;
  readonly bindingId: string;
  readonly generation: number;
}
interface Disclosure {
  readonly frame: Frame;
  readonly observation: CatalogSelectionSnapshot;
  readonly row: CatalogServiceView;
  readonly opener: HTMLButtonElement;
}
interface Search {
  readonly frame: Frame;
  readonly observation: CatalogSelectionSnapshot;
  readonly value: string;
  readonly rejected: boolean;
}

/** An explicitly disclosed view of an already loaded catalog observation. It
 * never activates owners, prepares commands or requests more/current data. */
export function CatalogServiceDetailsPanel({ workspace, context: input, source }: CatalogServiceDetailsPanelProps) {
  const id = useId();
  const active = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);
  const listed = useSyncExternalStore(source.subscribe, source.getSnapshot, serverSnapshot);
  const context = normalizeReviewWorkspaceContext(input);
  const bindingId = context?.bindingId ?? null, generation = context?.dataGeneration ?? null;
  const lease = active && active.context.bindingId === bindingId && active.context.dataGeneration === generation ? active.lease : null;
  const frame = useMemo<Frame | null>(() => lease !== null && bindingId !== null && generation !== null
    ? Object.freeze({ workspace, source, lease, bindingId, generation }) : null,
  [workspace, source, lease, bindingId, generation]);
  const observation = frame && listed?.lease === frame.lease && listed.context.bindingId === frame.bindingId
    && listed.context.dataGeneration === frame.generation && (listed.phase === "more" || listed.phase === "end_observed") ? listed : null;
  return <section aria-labelledby={`${id}-title`} data-testid="catalog-service-details-panel"
    data-phase={frame === null ? "closed" : observation === null ? "unavailable" : "ready"}
    data-open={frame === null ? "no" : "yes"}>
    <h2 id={`${id}-title`}>불러온 서비스 기록 상세</h2>
    <p>저장된 사용자 진술을 읽기만 합니다. 현재는 합성 데이터 전용이며 실제 개인정보·비밀번호·API 키를 입력하거나 조회하는 기능이 아닙니다.</p>
    {frame === null ? <p role="status">검토 화면이 닫혀 있습니다. 새 화면 범위에서 먼저 열어 주세요.</p>
      : <ActiveDetails frame={frame} observation={observation} />}
  </section>;
}

function ActiveDetails({ frame, observation }: { readonly frame: Frame; readonly observation: CatalogSelectionSnapshot | null }) {
  const id = useId(), { workspace, source } = frame;
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const selected = useRef<Disclosure | null>(null);
  const [attempt, setAttempt] = useState<object>(() => Object.freeze({}));
  const activeSearch = search?.frame === frame && search.observation === observation ? search : null;
  const query = activeSearch?.value ?? "";
  const epoch = useMemo(() => Object.freeze({}), [frame, observation, attempt, activeSearch]);
  const committed = useRef<{ frame: Frame; observation: CatalogSelectionSnapshot | null; epoch: object } | null>(null);
  const mounted = useRef<Frame | null>(null);
  const status = useRef<HTMLParagraphElement | null>(null), detail = useRef<HTMLDivElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const searchControls = useRef<HTMLDivElement | null>(null), listedControls = useRef<HTMLUListElement | null>(null);
  const retireRemovedFocus = useCallback((group: HTMLElement | null) => {
    const ownedFrame = mounted.current, focused = document.activeElement;
    if (!ownedFrame || !group?.contains(focused)) return;
    // Revoke before focusing: host focus listeners can synchronously activate
    // old controls. A body focus fallback would steal unrelated document focus.
    selected.current = null; committed.current = null;
    const active = ownedFrame.workspace.getSnapshot(), target = status.current;
    if (mounted.current === ownedFrame && active?.lease === ownedFrame.lease
      && active.context.bindingId === ownedFrame.bindingId && active.context.dataGeneration === ownedFrame.generation
      && target?.isConnected && document.activeElement === focused) target.focus({ preventScroll: true });
  }, []);
  // Keep callbacks stable across frame/source replacements. Changing callback
  // identity would detach refs even when the actual controls remain in the DOM.
  const searchControlsRef = useCallback((node: HTMLDivElement | null) => {
    const previous = searchControls.current; searchControls.current = node;
    if (!node) retireRemovedFocus(previous);
  }, [retireRemovedFocus]);
  const listedControlsRef = useCallback((node: HTMLUListElement | null) => {
    const previous = listedControls.current; listedControls.current = node;
    if (!node) retireRemovedFocus(previous);
  }, [retireRemovedFocus]);
  const workspaceCurrent = () => {
    const value = workspace.getSnapshot();
    return value?.lease === frame.lease && value.context.bindingId === frame.bindingId
      && value.context.dataGeneration === frame.generation;
  };
  const current = () => mounted.current === frame && committed.current?.frame === frame
    && committed.current.observation === observation && committed.current.epoch === epoch
    && observation !== null && workspaceCurrent() && source.getSnapshot() === observation;
  const loadedRows = observation?.services.filter((row) => row.state === "live" && row.profile !== null && row.dataGeneration === frame.generation) ?? [];
  const filtered = searchCatalogDetailRows(loadedRows, query);
  const rows = filtered.kind === "ready" ? filtered.rows : [];
  const visible = disclosure?.frame === frame && selected.current === disclosure && disclosure.observation === observation
    && disclosure.row.state === "live" && disclosure.row.profile !== null && disclosure.row.dataGeneration === frame.generation
    && observation?.services.includes(disclosure.row) && rows.includes(disclosure.row) ? disclosure : null;

  useLayoutEffect(() => { committed.current = { frame, observation, epoch }; });
  useLayoutEffect(() => {
    mounted.current = frame;
    let attached = true, lastObservation = source.getSnapshot();
    const changed = () => {
      if (!attached || mounted.current !== frame) return;
      const next = source.getSnapshot(), sameWorkspace = workspaceCurrent();
      if (next === lastObservation && sameWorkspace) return;
      lastObservation = next;
      // Synchronous revocation precedes any focus callback. Even an A -> B -> A
      // notification sequence cannot restore the old disclosure or old buttons.
      selected.current = null; committed.current = null;
      setDisclosure((value) => value?.frame === frame ? null : value);
      setSearch((value) => value?.frame === frame ? null : value);
      setAttempt(Object.freeze({}));
      if (sameWorkspace && detail.current?.contains(document.activeElement)) status.current?.focus({ preventScroll: true });
    };
    const detachSource = source.subscribe(changed), detachWorkspace = workspace.subscribe(changed);
    changed();
    return () => {
      attached = false; detachSource(); detachWorkspace();
      if (mounted.current === frame) mounted.current = null;
      if (selected.current?.frame === frame) selected.current = null;
      if (committed.current?.frame === frame) committed.current = null;
    };
  }, [frame]);
  useLayoutEffect(() => {
    if (disclosure !== null && visible === null) {
      if (selected.current === disclosure) selected.current = null;
      setDisclosure((value) => value === disclosure ? null : value);
    }
  }, [disclosure, visible]);
  useLayoutEffect(() => {
    if (search !== null && activeSearch === null) setSearch((value) => value === search ? null : value);
  }, [search, activeSearch]);
  const detailRef = useCallback((node: HTMLDivElement | null) => {
    if (!node && detail.current?.contains(document.activeElement) && mounted.current === frame) {
      // Render-time mismatch can remove the old group before an observer runs.
      // Retire its callback epoch before host focus listeners can reenter.
      committed.current = null;
      const value = workspace.getSnapshot();
      if (value?.lease === frame.lease && value.context.bindingId === frame.bindingId
        && value.context.dataGeneration === frame.generation) status.current?.focus({ preventScroll: true });
    }
    detail.current = node;
  }, [frame, workspace]);

  function open(row: CatalogServiceView, opener: HTMLButtonElement) {
    if (!current() || observation === null || !observation.services.includes(row)
      || !rows.includes(row) || row.state !== "live" || row.profile === null || row.dataGeneration !== frame.generation) return;
    const next = Object.freeze({ frame, observation, row, opener });
    selected.current = next; setDisclosure(next);
  }
  function close() {
    if (!current() || visible === null || selected.current !== visible) return;
    const old = visible;
    // Do not let synchronous focus listeners invoke the just-retired controls.
    selected.current = null; committed.current = null;
    setDisclosure((value) => value === old ? null : value);
    setAttempt(Object.freeze({}));
    if (detail.current?.contains(document.activeElement) && old.opener.isConnected) old.opener.focus({ preventScroll: true });
  }
  function changeQuery(value: string) {
    if (!current() || observation === null) return false;
    // Retire even when an oversized synthetic input is rejected. Do not let an
    // old row/control be reclaimed by a synchronous focus callback or query ABA.
    selected.current = null; committed.current = null;
    setDisclosure(null); setAttempt(Object.freeze({}));
    const valid = isCatalogDetailSearchQuery(value);
    setSearch(Object.freeze({ frame, observation, value: valid ? value : query, rejected: !valid }));
    if (detail.current?.contains(document.activeElement)) status.current?.focus({ preventScroll: true });
    return true;
  }
  function clearQuery(button: HTMLButtonElement) {
    const ownedFocus = document.activeElement === button;
    if (!changeQuery("")) return;
    // The clear control becomes disabled after this commit. Restore only its
    // own focus, after callback retirement, rather than leaving focus on body.
    if (ownedFocus && mounted.current === frame && workspaceCurrent()
      && source.getSnapshot() === observation && searchInput.current?.isConnected)
      searchInput.current.focus({ preventScroll: true });
  }
  return <div data-testid="catalog-service-details-content" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <p ref={status} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" data-testid="catalog-service-details-status">
      {observation === null ? "서비스 목록을 먼저 직접 불러오세요. 조회 중이거나 목록 관찰이 바뀌면 열린 상세는 닫힙니다."
        : filtered.kind !== "ready" ? "검색어 또는 불러온 목록 범위를 확인해 주세요. 추가 조회나 기록 변경은 하지 않았습니다."
        : `불러온 범위에서 일치 ${rows.length} / ${filtered.loadedCount}개입니다. 상세는 직접 열어야 표시됩니다. 전체 가입 내역이나 현재 상태의 증명이 아닙니다.`}
    </p>
    {observation !== null && <div ref={searchControlsRef}>
      <label htmlFor={`${id}-search`}>불러온 서비스에서 찾기</label>
      <input ref={searchInput} id={`${id}-search`} data-testid="catalog-service-details-search" type="search" value={query}
        maxLength={MAX_CATALOG_DETAIL_QUERY_LENGTH} autoComplete="off" spellCheck={false}
        aria-describedby={`${id}-search-hint`} aria-invalid={activeSearch?.rejected === true}
        style={{ display: "block", width: "100%", minWidth: 0, boxSizing: "border-box" }}
        onChange={(event) => changeQuery(event.currentTarget.value)} />
      <button type="button" data-testid="catalog-service-details-search-clear"
        disabled={query === "" && activeSearch?.rejected !== true} onClick={(event) => clearQuery(event.currentTarget)}>검색어 지우기</button>
      <p id={`${id}-search-hint`}>이미 불러온 서비스 이름과 ID만 찾습니다. 대소문자는 구분하지 않고 공백은 그대로 찾습니다. 제공자·요금제·계정 표시 이름·메모는 검색하지 않습니다. 검색 결과가 없어도 서버 기록 부재나 삭제를 뜻하지 않으며 다음 목록은 직접 불러와야 합니다.</p>
      {activeSearch?.rejected && <p role="status">검색어는 UTF-16 기준 160자 이내로 입력해 주세요. 이전의 유효한 검색어를 유지하고 상세는 닫았습니다.</p>}
    </div>}
    {rows.length > 0 && <ul ref={listedControlsRef}>{rows.map((row, index) => <li key={row.serviceId}>
      <p>{row.profile!.name} · {row.serviceId} · 버전 {row.serviceRevision}</p>
      <button type="button" data-testid="catalog-service-detail-toggle" data-service-id={row.serviceId}
        aria-expanded={visible?.row === row} aria-controls={`${id}-details-${index}`}
        onClick={(event) => { if (visible?.row === row) close(); else open(row, event.currentTarget); }}>
        {visible?.row === row ? "서비스 기록 상세 닫기" : "서비스 기록 상세 보기"}
      </button>
      {visible?.row === row && <div ref={detailRef} id={`${id}-details-${index}`} role="group"
        aria-labelledby={`${id}-details-title-${index}`} data-testid="catalog-service-detail-disclosure"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
        }}>
        <h3 id={`${id}-details-title-${index}`}>불러온 서비스 상세</h3>
        <CatalogServiceDetails record={row} />
        <button type="button" onClick={close}>상세 닫기</button>
      </div>}
    </li>)}</ul>}
  </div>;
}
