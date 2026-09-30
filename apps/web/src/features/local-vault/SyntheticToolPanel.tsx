import { useEffect, useState, useSyncExternalStore } from "react";
import {
  SYNTHETIC_TOOL_QUERY_MAX_BYTES,
  type SyntheticToolFilterV1,
} from "../../bridge/syntheticToolProtocol";
import { LocalCatalogResults } from "./LocalCatalogSearch";
import { SyntheticVaultTools } from "./SyntheticVaultTools";
import type { SyntheticVaultSession } from "./SyntheticVaultSession";

/** Mounted only for an open session epoch; all input/result state is local. */
export function SyntheticToolPanel({ session }: { readonly session: SyntheticVaultSession }) {
  const [tools] = useState(() => new SyntheticVaultTools(session));
  const [query, setQuery] = useState("");
  const state = useSyncExternalStore((listener) => tools.subscribe(listener), () => tools.state);
  useEffect(() => tools.bindToSession(), [tools]);

  const filter = (value: SyntheticToolFilterV1) => {
    void tools.executeTool({ op: "filter_catalog", filter: value });
  };

  return <details data-testid="local-tool-panel">
    <summary>로컬 도구 동작 확인 · 외부 AI 연결 없음</summary>
    <p>허용된 검색·분류·잠금만 실행합니다. 검색과 분류는 각각 결과 목록을 새로 표시합니다.
      키 원문 조회·복사, 외부 서비스 실행, 자동 등록 기능은 없습니다.</p>
    <form className="local-catalog-controls" onSubmit={(event) => {
      event.preventDefault();
      void tools.executeTool({ op: "search_catalog", query });
    }}>
      <label htmlFor="local-tool-query">로컬 도구 검색어</label>
      <input id="local-tool-query" type="search" value={query}
        maxLength={SYNTHETIC_TOOL_QUERY_MAX_BYTES} autoComplete="off" spellCheck={false}
        aria-describedby="local-tool-privacy" onChange={(event) => setQuery(event.currentTarget.value)} />
      <button type="submit">검색 도구 실행</button>
    </form>
    <div className="vault-actions" aria-label="로컬 분류 도구">
      <button type="button" onClick={() => filter("all")}>도구: 전체</button>
      <button type="button" onClick={() => filter("has_connection")}>도구: 연결 있음</button>
      <button type="button" onClick={() => filter("no_connection")}>도구: 연결 없음</button>
      <button type="button" onClick={() => filter("mcp_connection")}>도구: MCP 연결</button>
      <button type="button" onClick={() => { void tools.executeTool({ op: "lock_vault" }); }}>잠금 도구 실행</button>
    </div>
    <p id="local-tool-privacy">검색어는 UTF-8 기준 최대 128바이트이며 결과는 최대 500개입니다.
      검색어와 결과는 이 화면의 메모리에만 두고 잠금·화면 이탈 시 정리합니다.
      도구 응답에는 성공 여부와 동작명 또는 고정 오류 코드만 포함합니다.</p>
    <p role="status" aria-live="polite" data-testid="local-tool-receipt">
      {state.phase === "idle" && "아직 실행하지 않았습니다."}
      {state.phase === "busy" && "로컬 도구 처리 중"}
      {state.receipt !== null && <code>{JSON.stringify(state.receipt)}</code>}
    </p>
    {state.phase === "ready" && <section aria-labelledby="local-tool-results-heading" data-testid="local-tool-results">
      <h2 id="local-tool-results-heading">사용자 화면 전용 검색 결과</h2>
      <p>표시 {state.entries.length}개 · 이 목록은 도구 응답이나 AI 전송 자료가 아닙니다.</p>
      <LocalCatalogResults entries={state.entries} />
    </section>}
  </details>;
}
