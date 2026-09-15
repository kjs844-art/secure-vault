import { useCallback, useEffect, useRef, useState } from "react";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { BrowserSyntheticVaultWorker } from "./SyntheticVaultWorkerClient";
import { readSyntheticBackupFile } from "./SyntheticBackupFile";
import {
  SYNTHETIC_BACKUP_FILENAME, SyntheticBackupError, SyntheticVaultBackup,
  type SyntheticBackupErrorCode,
} from "./SyntheticVaultBackup";
import "../../styles.css";
import "./local-vault.css";
import "./synthetic-backup.css";

const messages: Record<SyntheticBackupErrorCode, string> = {
  EMPTY: "저장된 합성 금고가 없습니다. 먼저 합성 금고 화면에서 만들어 주세요.",
  EXISTS: "이미 금고가 있어 복원하지 않았습니다. 기존 금고는 그대로 보존했습니다.",
  INVALID_BACKUP: "지원하는 합성 백업 파일이 아닙니다. 파일을 변경하지 않았습니다.",
  UNSUPPORTED_VERSION: "지원하지 않는 백업 버전입니다. 파일과 기존 금고를 보존했습니다.",
  LIMIT_EXCEEDED: "백업 파일은 512 KiB 이하여야 합니다.",
  VALIDATION_FAILED: "백업을 인증하지 못해 저장하지 않았습니다. 손상되었거나 지원하지 않는 파일일 수 있습니다.",
  STORAGE_FAILED: "저장소 작업에 실패했습니다. 자동 삭제·덮어쓰기는 하지 않았습니다. 저장된 금고 열기로 상태를 확인하세요.",
  READBACK_FAILED: "저장 후 동일한 바이트인지 확인하지 못했습니다. 저장소를 자동으로 초기화하지 않았습니다.",
  CANCELLED: "작업을 취소했습니다. 이미 시작된 암호문 저장은 완료되었을 수 있습니다.",
  BUSY: "진행 중인 작업이 있습니다. 완료를 기다리거나 취소해 주세요.",
};

function errorMessage(error: unknown): string {
  try {
    if (error instanceof SyntheticBackupError) {
      const code = error.code;
      if (Object.hasOwn(messages, code)) return messages[code];
    }
  } catch { /* Never display raw exception text or filenames. */ }
  return "작업에 실패했습니다. 원본 파일과 기존 금고를 자동으로 수정하지 않았습니다.";
}

/** Separate page: navigating here unmounts and locks the catalog session. */
export function SyntheticBackupPanel() {
  const [backup] = useState(() => new SyntheticVaultBackup(
    createSyntheticCiphertextStore(), new BrowserSyntheticVaultWorker(),
  ));
  const [acknowledged, setAcknowledged] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("합성 백업 전용 화면입니다. 아직 파일을 읽거나 저장하지 않았습니다.");
  const generation = useRef(0);
  const running = useRef(false);
  const objectUrl = useRef<string | null>(null);

  const invalidate = useCallback(() => {
    generation.current += 1;
    running.current = false;
    backup.cancel();
    if (objectUrl.current !== null) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  }, [backup]);

  const cancel = useCallback(() => {
    invalidate();
    setFile(null);
    setBusy(false);
    setDownloadUrl(null);
    setMessage(messages.CANCELLED);
  }, [invalidate]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) cancel(); };
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
      invalidate();
    };
  }, [cancel, invalidate]);

  async function run(kind: "export" | "restore") {
    if (!acknowledged || running.current || (kind === "restore" && file === null)) return;
    const selected = file;
    invalidate();
    const token = generation.current;
    running.current = true;
    setFile(null);
    setDownloadUrl(null);
    setBusy(true);
    setMessage("검증 중 · 이 기기의 별도 Worker에서 합성 암호문을 인증합니다.");
    try {
      if (kind === "export") {
        const bytes = await backup.exportArchive();
        if (token !== generation.current) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
        objectUrl.current = URL.createObjectURL(blob);
        setDownloadUrl(objectUrl.current);
        setMessage("파일 준비 완료 · 아래 ‘백업 파일 다운로드’를 직접 눌러 저장하세요. 아직 디스크 저장을 확인한 것은 아닙니다.");
      } else {
        const bytes = await readSyntheticBackupFile(selected!);
        if (token !== generation.current) return;
        await backup.restoreArchive(bytes);
        if (token !== generation.current) return;
        setMessage("복원 완료 · 빈 저장소에 암호문을 저장하고 같은 바이트인지 확인했습니다. 금고는 잠긴 상태입니다. 금고 화면에서 ‘저장된 합성 금고 열기’로 확인하세요.");
      }
    } catch (error: unknown) {
      if (token === generation.current) setMessage(errorMessage(error));
    } finally {
      if (token === generation.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <main className="local-vault synthetic-backup">
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
          <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => {
            const checked = event.target.checked;
            cancel();
            setAcknowledged(checked);
            setMessage(checked ? "합성 테스트 사용을 확인했습니다. 백업을 준비하거나 복원할 파일을 선택하세요."
              : "합성 테스트 사용 확인을 해제했습니다. 준비된 파일과 작업도 비웠습니다.");
          }} />
          이 앱의 합성 금고로 만든 테스트 파일만 사용하며, 실제 비밀정보 보호용이 아님을 확인했습니다.
        </label>
        <h2>2. 백업 파일 내려받기</h2>
        <p>현재 저장된 암호문을 검증한 뒤 그대로 파일로 준비합니다. 원본 금고는 변경하지 않습니다.</p>
        <button type="button" disabled={!acknowledged || busy} onClick={() => { void run("export"); }}>합성 백업 파일 준비</button>
        {downloadUrl !== null && <p><a className="backup-download" href={downloadUrl} download={SYNTHETIC_BACKUP_FILENAME} onClick={() => {
          setMessage("다운로드를 요청했습니다. 브라우저 다운로드 목록에서 파일 저장을 직접 확인하세요. 저장 성공이나 복구 가능성을 자동으로 보증하지 않습니다.");
        }}>백업 파일 다운로드</a></p>}
      </section>
      <section aria-labelledby="restore-heading">
        <h2 id="restore-heading">3. 빈 저장소에만 복원</h2>
        <p>같은 앱을 연 다른 브라우저 프로필 등, 금고가 없는 환경에서 연습하세요. 현재 금고를 지우거나 덮어쓰는 버튼은 제공하지 않습니다.</p>
        <label className="backup-file-label">합성 백업 파일 선택 (최대 512 KiB)
          <input type="file" accept=".katldemo" disabled={!acknowledged || busy} onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            event.target.value = "";
            cancel();
            if (selected && (selected.size < 16 || selected.size > 524288)) {
              setMessage(selected.size > 524288 ? messages.LIMIT_EXCEEDED : messages.INVALID_BACKUP);
            } else {
              setFile(selected);
              setMessage(selected ? "파일을 선택했습니다. ‘빈 저장소에 복원’을 눌러야 내용을 읽고 검증합니다." : "파일을 선택하지 않았습니다.");
            }
          }} />
        </label>
        <p>{file === null ? "선택된 파일 없음" : `합성 파일 선택됨 · ${file.size}바이트`}</p>
        <button type="button" disabled={!acknowledged || busy || file === null} onClick={() => { void run("restore"); }}>빈 저장소에 복원</button>
      </section>
      <section aria-labelledby="backup-state-heading">
        <h2 id="backup-state-heading">작업 상태</h2>
        <p role="status" aria-live="polite" data-testid="backup-status">{message}</p>
        <button type="button" onClick={cancel}>작업 취소 · 준비 파일 비우기</button>
        <p><small>탭을 숨기거나 페이지를 떠나면 연산과 다운로드 링크를 해제합니다. 이미 시작된 암호문 저장이나 브라우저 다운로드는 취소되지 않을 수 있습니다. 파일 검증은 신뢰할 수 있는 출처·최신 버전·실제 복구 수단의 보증이 아닙니다.</small></p>
      </section>
    </main>
  );
}
