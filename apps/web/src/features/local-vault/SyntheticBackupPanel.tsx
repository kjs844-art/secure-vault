import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { BrowserSyntheticVaultWorker } from "./SyntheticVaultWorkerClient";
import { SYNTHETIC_BACKUP_FILENAME, SyntheticVaultBackup } from "./SyntheticVaultBackup";
import { SyntheticBackupSession } from "./SyntheticBackupSession";
import { bindVaultAutoLock } from "./bindVaultAutoLock";
import "../../styles.css";
import "./local-vault.css";
import "./synthetic-backup.css";

/** Separate page: navigating here unmounts and locks the catalog session. */
export function SyntheticBackupPanel() {
  const [session] = useState(() => new SyntheticBackupSession(new SyntheticVaultBackup(
    createSyntheticCiphertextStore(), new BrowserSyntheticVaultWorker(),
  )));
  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener), () => session.state,
  );
  useEffect(() => bindVaultAutoLock(session), [session]);
  const busy = state.phase === "busy";
  const generation = session.viewGeneration;
  const statusElement = useRef<HTMLParagraphElement>(null);
  const lastFocusedElement = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previous = lastFocusedElement.current;
    if (previous === null) return;
    const removed = !previous.isConnected;
    if (removed) lastFocusedElement.current = null;
    if ((removed || previous.matches(":disabled")) && !document.hidden && document.hasFocus()
        && document.activeElement === document.body) {
      statusElement.current?.focus();
    }
  }, [state.phase, generation]);

  return (
    <main className="local-vault synthetic-backup" onFocusCapture={(event) => {
      if (event.target instanceof HTMLElement) lastFocusedElement.current = event.target;
    }}>
      <header>
        <p className="eyebrow">KeyAtlas · synthetic backup drill</p>
        <h1>합성 금고 백업 · 복원 연습</h1>
        <p className="demo-warning"><strong>실제 비밀번호·API 키·개인 금고 파일 입력 금지.</strong> 공개된 테스트 비밀번호를 사용하므로, 이 파일은 실제 비밀정보의 기밀성을 제공하지 않습니다. 계정 복구나 정식 백업 기능이 아닌 합성 데이터 검증입니다.</p>
        <p>파일을 서버에 업로드하지 않습니다. 현재 페이지는 금고 목록과 분리되어 있고, 서비스명·키 원문·파일명을 표시하지 않습니다.</p>
        <a href="/?view=local-vault">합성 금고 화면으로 돌아가기</a>
      </header>
      <section aria-labelledby="backup-heading">
        <h2 id="backup-heading">1. 준비된 합성 데이터만 사용</h2>
        <label className="backup-acknowledgement">
          <input type="checkbox" checked={state.acknowledged} disabled={busy}
            onChange={(event) => session.acknowledge(event.target.checked)} />
          이 앱의 합성 금고로 만든 테스트 파일만 사용하며, 실제 비밀정보 보호용이 아님을 확인했습니다.
        </label>
        <h2>2. 백업 파일 내려받기</h2>
        <p>현재 저장된 암호문을 검증한 뒤 그대로 파일로 준비합니다. 원본 금고는 변경하지 않습니다.</p>
        <button type="button" disabled={!state.acknowledged || busy}
          onClick={() => { void session.prepareExport(); }}>합성 백업 파일 준비</button>
        {state.downloadUrl !== null && <p><a className="backup-download"
          href={state.downloadUrl} download={SYNTHETIC_BACKUP_FILENAME}
          onClick={() => session.markDownloadRequested()}>백업 파일 다운로드</a></p>}
      </section>
      <section aria-labelledby="restore-heading">
        <h2 id="restore-heading">3. 빈 저장소에만 복원</h2>
        <p>같은 앱을 연 다른 브라우저 프로필 등, 금고가 없는 환경에서 연습하세요. 현재 금고를 지우거나 덮어쓰는 버튼은 제공하지 않습니다.</p>
        <label className="backup-file-label">합성 백업 파일 선택 (최대 512 KiB)
          <input type="file" accept=".katldemo" disabled={!state.acknowledged || busy}
            key={session.viewGeneration} onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              event.target.value = "";
              session.selectFile(selected);
            }} />
        </label>
        <p>{state.fileSize === null ? "선택된 파일 없음" : `합성 파일 선택됨 · ${state.fileSize}바이트`}</p>
        <button type="button" disabled={!state.acknowledged || busy || state.fileSize === null}
          onClick={() => { void session.restore(); }}>빈 저장소에 복원</button>
      </section>
      <section aria-labelledby="backup-state-heading">
        <h2 id="backup-state-heading">작업 상태</h2>
        <p ref={statusElement} tabIndex={-1} role="status" aria-live="polite" data-testid="backup-status">{state.message}</p>
        <button type="button" onClick={() => session.lock()}>작업 취소 · 준비 파일 비우기</button>
        <p><small>탭을 숨기거나 페이지를 떠나거나 5분 동안 입력이 없으면 연산·선택한 파일·다운로드 링크·사용 확인을 해제합니다. 절전 복귀와 시계 오류 시에도 해제될 수 있습니다. 이미 시작된 암호문 저장이나 브라우저 다운로드는 취소되지 않을 수 있습니다. 파일 검증은 신뢰할 수 있는 출처·최신 버전·실제 복구 수단의 보증이 아닙니다.</small></p>
      </section>
    </main>
  );
}
