import { useEffect, useState, useSyncExternalStore } from "react";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession } from "./SyntheticVaultSession";
import { BrowserSyntheticVaultWorker } from "./SyntheticVaultWorkerClient";
import { bindVaultAutoLock } from "./bindVaultAutoLock";
import { SyntheticEditableCatalog } from "./SyntheticConnectionEditor";
import { SyntheticToolPanel } from "./SyntheticToolPanel";
import { SyntheticRegistrationPanel } from "./SyntheticRegistrationPanel";
import { SyntheticConflictReviewPanel } from "./SyntheticConflictReviewPanel";
import { SyntheticRotationStagePanel } from "./SyntheticRotationStagePanel";
import "../../styles.css";
import "./local-vault.css";

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
  const generation = session.viewGeneration;
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
          {state.phase === "error" && `작업을 확인하지 못했습니다 (${state.errorCode}). 오류 시 자동 초기화·재시도는 하지 않습니다. 저장이 이미 완료됐을 수 있으므로 먼저 금고를 다시 열어 확인하세요.`}
        </p>
        <LocalVaultBridgeFailureGuidance state={state} />
        {state.phase === "error" && state.errorCode === "LIMITS_EXCEEDED" && <p data-testid="vault-capacity-error">
          저장 한도에는 이미 저장된 이력과 키 교체를 끝내기 위해 남겨둔 공간도 포함됩니다. 금고를 다시 열고 저장한 진행을 불러와 검토하세요. 준비됐으면 최종 확정하고, 미확인 조건이 남았다면 필요한 확인을 모아 한 번에 저장하세요. 이전 버전의 꽉 찬 저장본이나 기기 용량 부족에서는 완료 공간이 보장되지 않습니다. 데이터를 삭제하거나 초기화하지 말고 합성 백업을 먼저 보관하세요.
        </p>}
        <small>이미 금고가 있으면 만들기를 다시 눌러도 덮어쓰지 않습니다. 새로고침 후에는 다시 열어야 하며, 탭을 숨기거나 5분 동안 키보드·포인터 입력이 없으면 잠깁니다. 절전 복귀나 시스템 시각 변경 시에도 잠길 수 있습니다.</small>
      </section>

      {state.phase === "open" && <SyntheticConflictReviewPanel
        key={`conflict-review-${generation}`} session={session} vaultGeneration={generation}
      />}
      {state.phase === "open" && <SyntheticRotationStagePanel
        key={`rotation-${generation}`} session={session} vaultGeneration={generation}
        entries={state.entries}
      />}
      {state.phase === "open" && <SyntheticRegistrationPanel key={`registration-${session.viewGeneration}`} session={session} entryCount={state.entries.length} />}
      {state.phase === "open" && <SyntheticEditableCatalog key={`catalog-${generation}`} entries={state.entries} generation={generation} session={session} />}
      {state.phase === "open" && <SyntheticToolPanel key={`tools-${session.viewGeneration}`} session={session} />}
      <section aria-labelledby="local-explanation-heading">
        <h2 id="local-explanation-heading">로컬 저장은 ‘이 브라우저 안 서랍’이에요</h2>
        <p>같은 주소·같은 브라우저 프로필에서 다시 찾을 수 있도록 저장하는 뜻입니다. 다른 PC나 휴대폰에서는 자동으로 보이지 않습니다.</p>
        <p>브라우저 데이터 삭제, 시크릿 모드 종료, 기기 분실·고장 등으로 데이터가 사라질 수 있습니다. 브라우저 저장 자체는 백업이 아닙니다. 실제 사용자 인증·계정 복구는 아직 없으며, 합성 암호문 파일로 백업·복원을 연습할 수 있습니다.</p>
        <a href="/?view=synthetic-backup">합성 금고 백업 · 복원 연습</a>
      </section>
    </main>
  );
}

/** Guidance only: never changes the session, retries work, or touches storage. */
export function LocalVaultBridgeFailureGuidance({ state }: {
  readonly state: Pick<SyntheticVaultSession["state"], "phase" | "errorCode">;
}) {
  if (state.phase !== "error" || state.errorCode !== "BRIDGE_FAILURE") return null;
  return <p data-testid="vault-bridge-error">
    원인은 아직 확인되지 않았습니다. 실행 파일 로딩이나 백그라운드 작업(Worker) 시작·통신 중 문제가 생겼을 수 있습니다. 인터넷 연결 상태와, 로컬로 실행 중이라면 미리보기 서버가 켜져 있는지 확인하세요. 연결이나 실행 환경을 복구한 뒤 ‘저장된 합성 금고 열기’를 직접 눌러 확인하세요. 문제 해결을 위해 브라우저 데이터를 삭제하거나 금고를 초기화하지 마세요. 자동 초기화·자동 재시도는 하지 않습니다.
  </p>;
}
