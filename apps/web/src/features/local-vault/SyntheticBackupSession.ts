import { MAX_SYNTHETIC_ARCHIVE_BYTES } from "../../storage/SyntheticCiphertextStore";
import { readSyntheticBackupFile } from "./SyntheticBackupFile";
import { SyntheticBackupError, type SyntheticBackupErrorCode, type SyntheticVaultBackup } from "./SyntheticVaultBackup";

export interface SyntheticBackupSessionState {
  readonly phase: "locked" | "busy" | "open";
  readonly acknowledged: boolean;
  readonly fileSize: number | null;
  readonly downloadUrl: string | null;
  readonly message: string;
}

export interface SyntheticBackupSessionPort {
  readFile(file: File): Promise<Uint8Array>;
  createObjectURL(bytes: Uint8Array): string;
  revokeObjectURL(url: string): void;
}

const defaultPort: SyntheticBackupSessionPort = {
  readFile: readSyntheticBackupFile,
  createObjectURL: (bytes) => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" })),
  revokeObjectURL: (url) => { URL.revokeObjectURL(url); },
};

const messages: Record<SyntheticBackupErrorCode, string> = {
  EMPTY: "저장된 합성 금고가 없습니다. 먼저 합성 금고 화면에서 만들어 주세요.",
  EXISTS: "이미 금고가 있어 복원하지 않았습니다. 기존 금고는 그대로 보존했습니다.",
  INVALID_BACKUP: "지원하는 합성 백업 파일이 아닙니다. 파일을 변경하지 않았습니다.",
  UNSUPPORTED_VERSION: "지원하지 않는 백업 버전입니다. 파일과 기존 금고를 보존했습니다.",
  LIMIT_EXCEEDED: "백업 파일은 512 KiB 이하여야 합니다.",
  VALIDATION_FAILED: "백업을 인증하지 못해 저장하지 않았습니다. 손상되었거나 지원하지 않는 파일일 수 있습니다.",
  STORAGE_FAILED: "저장소 작업에 실패했습니다. 자동 삭제·덮어쓰기는 하지 않았습니다. 저장된 금고 열기로 상태를 확인하세요.",
  UNRESOLVED_CONFLICTS: "검토하지 않은 충돌 암호문이 있어 백업 파일을 만들지 않았습니다. 합성 금고 화면에서 충돌을 먼저 검토하세요.",
  READBACK_FAILED: "저장 후 동일한 바이트인지 확인하지 못했습니다. 저장소를 자동으로 초기화하지 않았습니다.",
  CANCELLED: "작업을 취소했습니다. 이미 시작된 암호문 저장은 완료되었을 수 있습니다.",
  BUSY: "진행 중인 작업이 있습니다. 완료를 기다리거나 취소해 주세요.",
};

function errorMessage(error: unknown): string {
  try {
    if (error instanceof SyntheticBackupError) {
      const code = error.code;
      if (typeof code === "string" && Object.hasOwn(messages, code)) return messages[code];
    }
  } catch { /* A thrown accessor or proxy is untrusted too. */ }
  return "작업에 실패했습니다. 원본 파일과 기존 금고를 자동으로 수정하지 않았습니다.";
}

function state(phase: SyntheticBackupSessionState["phase"], acknowledged: boolean, message: string,
  fileSize: number | null = null, downloadUrl: string | null = null): SyntheticBackupSessionState {
  return Object.freeze({ phase, acknowledged, fileSize, downloadUrl, message });
}

/**
 * Ephemeral synthetic-only backup UI. Public state never includes filenames,
 * file bytes, or Worker rows. Lock clears retained references and invalidates
 * continuations; it cannot undo a started IndexedDB commit or browser download.
 * Ready/error states remain open so the shared idle policy clears them too.
 */
export class SyntheticBackupSession {
  readonly #backup: Pick<SyntheticVaultBackup, "exportArchive" | "restoreArchive" | "cancel">;
  readonly #port: SyntheticBackupSessionPort;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #file: File | null = null;
  #objectUrl: string | null = null;
  #state = state("locked", false, "합성 백업 전용 화면입니다. 아직 파일을 읽거나 저장하지 않았습니다.");

  constructor(backup: Pick<SyntheticVaultBackup, "exportArchive" | "restoreArchive" | "cancel">,
    port: SyntheticBackupSessionPort = defaultPort) {
    this.#backup = backup;
    this.#port = port;
  }

  get state(): SyntheticBackupSessionState { return this.#state; }
  get viewGeneration(): number { return this.#generation; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  acknowledge(acknowledged: boolean): void {
    const generation = this.#invalidate(state(acknowledged ? "open" : "locked", acknowledged,
      acknowledged ? "합성 테스트 사용을 확인했습니다. 백업을 준비하거나 복원할 파일을 선택하세요."
        : "합성 테스트 사용 확인을 해제했습니다. 준비된 파일과 작업도 비웠습니다."));
    if (this.#isCurrent(generation)) this.#notify();
  }

  selectFile(file: File | null): void {
    if (!this.#state.acknowledged) return;
    const generation = this.#invalidate(state("open", true, "파일을 선택하지 않았습니다."));
    if (!this.#isCurrent(generation)) return;
    if (file === null) { this.#notify(); return; }
    let size: number;
    try { size = file.size; }
    catch {
      this.#publish(generation, state("open", true, messages.INVALID_BACKUP));
      return;
    }
    if (!this.#isCurrent(generation)) return;
    if (!Number.isSafeInteger(size) || size < 16 || size > MAX_SYNTHETIC_ARCHIVE_BYTES) {
      this.#publish(generation, state("open", true,
        size > MAX_SYNTHETIC_ARCHIVE_BYTES ? messages.LIMIT_EXCEEDED : messages.INVALID_BACKUP));
      return;
    }
    // Only retain a size-checked File after explicit acknowledgment. No name,
    // MIME, arrayBuffer, or stream access happens while merely selecting it.
    this.#file = file;
    this.#publish(generation, state("open", true,
      "파일을 선택했습니다. ‘빈 저장소에 복원’을 눌러야 내용을 읽고 검증합니다.", size));
  }

  async prepareExport(): Promise<void> { await this.#run("export"); }
  async restore(): Promise<void> { await this.#run("restore"); }

  lock(): void {
    const generation = this.#invalidate(state("locked", false, messages.CANCELLED));
    if (this.#isCurrent(generation)) this.#notify();
  }

  markDownloadRequested(): void {
    if (this.#state.phase !== "open" || this.#objectUrl === null) return;
    this.#publish(this.#generation, state("open", this.#state.acknowledged,
      "다운로드를 요청했습니다. 브라우저 다운로드 목록에서 파일 저장을 직접 확인하세요. 저장 성공이나 복구 가능성을 자동으로 보증하지 않습니다.",
      this.#state.fileSize, this.#objectUrl));
  }

  async #run(kind: "export" | "restore"): Promise<void> {
    if (!this.#state.acknowledged || this.#state.phase === "busy") return;
    const selected = this.#file;
    if (kind === "restore" && selected === null) return;
    const generation = this.#invalidate(state("busy", true,
      "검증 중 · 이 기기의 별도 Worker에서 합성 암호문을 인증합니다."));
    if (!this.#isCurrent(generation)) return;
    this.#notify();
    // Subscribers include lifecycle auto-lock and can synchronously invalidate
    // the session. Never start I/O or a Worker after their lock decision.
    if (!this.#isCurrent(generation)) return;
    try {
      if (kind === "export") {
        const bytes = await this.#backup.exportArchive();
        if (!this.#isCurrent(generation)) return;
        const url = this.#port.createObjectURL(bytes);
        if (!this.#isCurrent(generation)) { this.#revoke(url); return; }
        this.#objectUrl = url;
        this.#publish(generation, state("open", true,
          "파일 준비 완료 · 아래 ‘백업 파일 다운로드’를 직접 눌러 저장하세요. 아직 디스크 저장을 확인한 것은 아닙니다.", null, url));
      } else {
        const bytes = await this.#port.readFile(selected!);
        if (!this.#isCurrent(generation)) return;
        await this.#backup.restoreArchive(bytes);
        if (!this.#isCurrent(generation)) return;
        this.#publish(generation, state("open", true,
          "복원 완료 · 빈 저장소에 암호문을 저장하고 같은 바이트인지 확인했습니다. 금고는 잠긴 상태입니다. 금고 화면에서 ‘저장된 합성 금고 열기’로 확인하세요."));
      }
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return;
      const message = errorMessage(error);
      this.#publish(generation, state("open", true, message));
    }
  }

  #invalidate(nextState: SyntheticBackupSessionState): number {
    const generation = ++this.#generation;
    const oldUrl = this.#objectUrl;
    this.#file = null;
    this.#objectUrl = null;
    this.#state = nextState;
    // Clear pending identity, references and public state BEFORE external
    // cleanup or notification. Cleanup failure must never preserve old state.
    try { this.#backup.cancel(); } catch { /* State remains cleared. */ }
    if (oldUrl !== null) this.#revoke(oldUrl);
    return generation;
  }

  #revoke(url: string): void {
    try { this.#port.revokeObjectURL(url); } catch { /* Clear our reference even if browser cleanup fails. */ }
  }

  #publish(generation: number, nextState: SyntheticBackupSessionState): void {
    if (!this.#isCurrent(generation)) return;
    this.#state = nextState;
    this.#notify();
  }

  #isCurrent(generation: number): boolean { return generation === this.#generation; }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* UI subscribers cannot corrupt the session. */ }
    }
  }
}
