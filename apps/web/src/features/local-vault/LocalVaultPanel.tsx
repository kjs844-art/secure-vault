import { useEffect, useState, useSyncExternalStore } from "react";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession } from "./SyntheticVaultSession";
import { BrowserSyntheticVaultWorker } from "./SyntheticVaultWorkerClient";
import { bindVaultAutoLock } from "./bindVaultAutoLock";
import "../../styles.css";
import "./local-vault.css";

const consumerLabels: Record<string, string> = {
  app: "앱", browser_extension: "브라우저 확장", plugin: "플러그인",
  mcp_server: "MCP 서버", cli: "CLI 도구", server: "서버", ci_cd: "CI/CD",
  cloud_project: "클라우드 프로젝트", custom: "기타",
};

export function LocalVaultPanel() {
  // Constructors do not read storage or start workers. StrictMode can safely
  // create/discard a session; effect cleanup invalidates pending operations.
  const [session] = useState(() => new SyntheticVaultSession(
    createSyntheticCiphertextStore(), new BrowserSyntheticVaultWorker(),
  ));
  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener), () => session.state,
  );
  useEffect(() => bindVaultAutoLock(session), [session]);

  const busy = state.phase === "busy";
  return (
    <main className="local-vault">
      <header>
        <p className="eyebrow">KeyAtlas · synthetic local vault</p>
        <h1>저장해 두고, 연결까지 다시 찾기</h1>
        <p>서비스 → API 자격 증명 → 연결된 도구. 가상 데이터로 로컬 저장과 복원을 확인하는 기능 화면입니다.</p>
        <p className="demo-warning"><strong>실제 비밀번호·API 키 입력 금지.</strong> 공개된 테스트 비밀번호를 사용하는 데모입니다. 암호화 흐름을 시험하지만 실제 비밀정보를 보호할 수 있는 제품은 아닙니다.</p>
        <a href="/">기존 합성 목록 화면</a>
      </header>

      <section aria-labelledby="storage-heading">
        <h2 id="storage-heading">이 브라우저의 합성 금고</h2>
        <p>암호문 묶음만 이 기기의 IndexedDB에 저장합니다. 서버 업로드·클라우드 동기화·SQLite 연동은 하지 않습니다.</p>
        <div className="vault-actions">
          <button type="button" disabled={busy} onClick={() => { void session.create(); }}>합성 금고 만들기</button>
          <button type="button" disabled={busy} onClick={() => { void session.open(); }}>저장된 합성 금고 열기</button>
          <button type="button" onClick={() => session.lock()}>잠그기 / 작업 취소</button>
        </div>
        <p role="status" aria-live="polite" data-testid="vault-status" className="vault-status">
          {state.phase === "locked" && "잠김 · 저장된 암호문은 그대로 두고 화면 내용을 비웠습니다."}
          {state.phase === "busy" && "처리 중 · 이 기기에서 암호화 또는 복호화하고 있습니다. 잠그면 화면과 연산을 중단하지만, 이미 시작된 암호문 저장은 완료될 수 있습니다."}
          {state.phase === "empty" && "저장된 합성 금고가 없습니다. ‘합성 금고 만들기’를 눌러 시작하세요."}
          {state.phase === "open" && `열림 · 저장된 암호문에서 ${state.entries.length}개 합성 항목을 인증하고 복원했습니다.`}
          {state.phase === "error" && `열지 못했습니다 (${state.errorCode}). 기존 저장 내용은 자동 삭제하거나 덮어쓰지 않습니다.`}
        </p>
        <small>이미 금고가 있으면 만들기를 다시 눌러도 덮어쓰지 않습니다. 새로고침 후에는 다시 열어야 하며, 탭을 숨기거나 5분 동안 키보드·포인터 입력이 없으면 잠깁니다. 절전 복귀나 시스템 시각 변경 시에도 잠길 수 있습니다.</small>
      </section>

      {state.phase === "open" && (
        <section aria-labelledby="relationships-heading" data-testid="relationship-catalog">
          <h2 id="relationships-heading">합성 연결 관계</h2>
          <p>아래는 자동 탐지 결과가 아닌 가상 예시입니다. 키 원문은 화면으로 전달하지 않습니다.</p>
          <ol className="relationship-list">
            {state.entries.map((entry) => (
              <li key={entry.reference}>
                <p className="relationship-service">{entry.providerName}</p>
                <h3>{entry.itemName} <small>예시 {entry.reference + 1}</small></h3>
                <p>API 키 · 보관된 비밀 필드 {entry.secretFieldCount}개 · 연결 {entry.connectionCount}곳</p>
                {entry.connections.length === 0 ? <p>아직 연결 기록이 없는 예시입니다.</p> : (
                  <ul aria-label={`예시 ${entry.reference + 1} 연결 목록`}>
                    {entry.connections.map((connection, index) => (
                      <li key={index}><span aria-hidden="true">↳ </span><strong>{connection.label}</strong><span className="consumer-type">{consumerLabels[connection.consumerType]}</span></li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <section aria-labelledby="local-explanation-heading">
        <h2 id="local-explanation-heading">로컬 저장은 ‘이 브라우저 안 서랍’이에요</h2>
        <p>같은 주소·같은 브라우저 프로필에서 다시 찾을 수 있도록 저장하는 뜻입니다. 다른 PC나 휴대폰에서는 자동으로 보이지 않습니다.</p>
        <p>브라우저 데이터 삭제, 시크릿 모드 종료, 기기 분실·고장 등에 대비한 백업이 아닙니다. 브라우저가 공간을 회수할 수도 있습니다. 이번 데모에는 백업·복구와 실제 사용자 인증이 아직 없습니다.</p>
      </section>
    </main>
  );
}
