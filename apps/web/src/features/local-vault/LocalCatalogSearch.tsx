import { useMemo, useState, type ReactNode } from "react";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  MAX_LOCAL_QUERY_LENGTH, consumerLabels, credentialLabels, statusLabels,
  searchLocalCatalog, type ConnectionFilter,
} from "./searchLocalCatalog";

// Mounted only while the owning session is open. Lock/unmount discards query
// and filter state; this is not a claim of erasing JavaScript heap copies.
export function LocalCatalogSearch({ entries, renderEntryActions }: {
  readonly entries: readonly LocalCatalogEntryV1[];
  readonly renderEntryActions?: ((entry: LocalCatalogEntryV1) => ReactNode) | undefined;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConnectionFilter>("all");
  const matches = useMemo(() => searchLocalCatalog(entries, query, filter), [entries, query, filter]);
  return (
    <section aria-labelledby="relationships-heading" data-testid="relationship-catalog">
      <h2 id="relationships-heading">합성 연결 관계</h2>
      <p>아래는 자동 탐지 결과가 아닌 가상 예시입니다. 키 원문은 화면으로 전달하지 않습니다.</p>
      <div className="local-catalog-controls">
        <label htmlFor="local-catalog-query">서비스·계정·프로젝트·연결처 검색</label>
        <input id="local-catalog-query" type="search" value={query} maxLength={MAX_LOCAL_QUERY_LENGTH}
          autoComplete="off" spellCheck={false} aria-describedby="local-search-privacy"
          onChange={(event) => setQuery(event.currentTarget.value)} />
        <label htmlFor="local-catalog-filter">연결 분류</label>
        <select id="local-catalog-filter" value={filter} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "all" || value === "connected" || value === "unconnected" || value === "mcp") setFilter(value);
        }}>
          <option value="all">전체</option><option value="connected">연결 있음</option>
          <option value="unconnected">연결 없음</option><option value="mcp">MCP 연결 있음</option>
        </select>
        <button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>검색 초기화</button>
      </div>
      <p id="local-search-privacy">이 화면에서만 검색합니다. 검색어를 서버·AI로 보내거나 앱의 저장소에 기록하지 않습니다. 잠그면 검색어가 초기화됩니다.</p>
      <p role="status" aria-live="polite" data-testid="local-search-count">전체 {entries.length}개 중 {matches.length}개</p>
      <LocalCatalogResults entries={matches} renderEntryActions={renderEntryActions} />
    </section>
  );
}

export function LocalCatalogResults({ entries, renderEntryActions }: {
  readonly entries: readonly LocalCatalogEntryV1[];
  readonly renderEntryActions?: ((entry: LocalCatalogEntryV1) => ReactNode) | undefined;
}) {
  if (entries.length === 0) return <p data-testid="local-search-empty">일치하는 항목이 없습니다. 검색어나 연결 분류를 바꿔 보세요.</p>;
  return <ol className="relationship-list">
    {entries.map((entry) => <li key={entry.reference}>
      <p className="relationship-service">{entry.providerName}</p>
      <h3>{entry.itemName} <small>예시 {entry.reference + 1}</small></h3>
      <p>{credentialLabels[entry.credentialType]} · {statusLabels[entry.status]} · 보관된 비밀 필드 {entry.secretFieldCount}개 · 연결 {entry.connectionCount}곳</p>
      <dl className="issuer-context" aria-label={`예시 ${entry.reference + 1} 발급 계정 정보`}>
        <dt>발급 계정</dt><dd>{issuerLabel(entry.issuerAccountIdentifier)}</dd>
        <dt>조직 · 워크스페이스</dt><dd>{issuerLabel(entry.issuerOrganizationOrWorkspace)}</dd>
        <dt>프로젝트</dt><dd>{issuerLabel(entry.issuerProject)}</dd>
        <dt>환경</dt><dd>{issuerLabel(entry.issuerEnvironment)}</dd>
      </dl>
      {entry.connections.length === 0 ? <p>아직 연결 기록이 없는 예시입니다.</p> : (
        <ul aria-label={`예시 ${entry.reference + 1} 연결 목록`}>
          {entry.connections.map((connection, index) => <li key={index}>
            <span aria-hidden="true">↳ </span><strong>{connection.label}</strong>
            <span className="consumer-type">{consumerLabels[connection.consumerType]}</span>
          </li>)}
        </ul>
      )}
      {renderEntryActions?.(entry)}
    </li>)}
  </ol>;
}

function issuerLabel(value: string | null): string {
  return value === null ? "기록 없음" : value === "" ? "빈 값으로 기록됨" : value;
}
