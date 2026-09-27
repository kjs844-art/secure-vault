import { useId, useRef, useState } from "react";
import type { SyntheticVaultSession } from "./SyntheticVaultSession";
import type { SyntheticRegistrationSelection } from "./syntheticRegistration";

const PROFILES = [
  { id: 0, provider: "Example AI Workshop", account: "demo-account", workspace: "demo-workspace", project: "demo-project", environment: "demo" },
  { id: 1, provider: "Example Cloud Lab", account: "lab-account", workspace: "lab-workspace", project: "lab-project", environment: "staging" },
] as const;
const CONNECTIONS = [
  { id: 0, name: "Example MCP", type: "MCP 서버" },
  { id: 1, name: "Example CLI", type: "명령줄 도구" },
  { id: 2, name: "Example CI", type: "자동화 빌드" },
] as const;
type ConnectionId = SyntheticRegistrationSelection["connectionIds"][number];
const CREDENTIAL_KINDS = [
  { id: "api_key", label: "API 키" },
  { id: "password_only", label: "비밀번호만" },
  { id: "password_with_identifier", label: "비밀번호 + 계정 식별자" },
] as const;
type CredentialKind = (typeof CREDENTIAL_KINDS)[number]["id"];
interface RegistrationDraft {
  readonly kind: CredentialKind;
  readonly profileId: 0 | 1;
  readonly connectionIds: readonly ConnectionId[];
  readonly acknowledged: boolean;
}

/** Selection-only UI. Parent mounts only while open and keys by session generation. */
export function SyntheticRegistrationPanel({ session, entryCount }: {
  session: Pick<SyntheticVaultSession, "register">;
  entryCount: number;
}) {
  const id = useId();
  const [draft, setDraft] = useState<RegistrationDraft>({
    kind: "api_key", profileId: 0, connectionIds: [], acknowledged: false,
  });
  // Keep consent changes synchronous even before React commits the next render.
  const current = useRef(draft);
  const submitted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const { kind, profileId, connectionIds, acknowledged } = draft;
  const isApiKey = kind === "api_key";
  const profile = PROFILES[profileId];
  const atCapacity = entryCount >= 128;

  function updateDraft(update: (previous: RegistrationDraft) => RegistrationDraft) {
    if (submitted.current) return;
    const next = update(current.current);
    current.current = next;
    setDraft(next);
  }

  function toggleConnection(connectionId: ConnectionId, checked: boolean) {
    if (current.current.kind !== "api_key") return;
    updateDraft((previous) => ({
      ...previous, acknowledged: false,
      connectionIds: checked
        ? previous.connectionIds.includes(connectionId) ? previous.connectionIds : [...previous.connectionIds, connectionId]
        : previous.connectionIds.filter((value) => value !== connectionId),
    }));
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="synthetic-registration" data-testid="registration-panel">
      <h2 id={`${id}-heading`}>합성 API 키·비밀번호 등록 연습</h2>
      <p>준비된 가상 데이터만 선택합니다. 실제 계정·비밀번호·API 키를 입력하거나 가져오지 않습니다.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        const selection = current.current;
        if (!selection.acknowledged || atCapacity || submitted.current) return;
        const registration: SyntheticRegistrationSelection = selection.kind === "api_key"
          ? { profileId: selection.profileId, credentialId: 0, connectionIds: [...selection.connectionIds] }
          : { profileId: 2, credentialId: selection.kind === "password_only" ? 1 : 2, connectionIds: [] };
        submitted.current = true;
        setSubmitting(true);
        void session.register(registration);
      }}>
        <label htmlFor={`${id}-kind`}>보관할 자격 증명 종류</label>
        <select id={`${id}-kind`} value={kind} disabled={submitting} data-testid="registration-kind"
          onChange={(event) => {
            const chosen = CREDENTIAL_KINDS.find((item) => item.id === event.currentTarget.value);
            if (chosen) updateDraft((previous) => ({
              ...previous, kind: chosen.id, connectionIds: [], acknowledged: false,
            }));
          }}>
          {CREDENTIAL_KINDS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
        {isApiKey ? <>
        <label htmlFor={`${id}-profile`}>가상 서비스·계정 선택</label>
        <select id={`${id}-profile`} value={profileId} disabled={submitting} data-testid="registration-profile"
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (current.current.kind === "api_key" && (value === "0" || value === "1")) {
              updateDraft((previous) => ({ ...previous, profileId: value === "0" ? 0 : 1, acknowledged: false }));
            }
          }}>
          {PROFILES.map((item) => <option value={item.id} key={item.id}>{item.provider} · {item.account}</option>)}
        </select>
        <dl className="registration-profile" data-testid="registration-preview">
          <dt>발급 계정</dt><dd>{profile.account}</dd>
          <dt>조직/워크스페이스</dt><dd>{profile.workspace}</dd>
          <dt>프로젝트</dt><dd>{profile.project}</dd>
          <dt>환경</dt><dd>{profile.environment}</dd>
        </dl>
        <p>저장할 자격 증명: 테스트 API 키 1개. 원문 입력·조회·복사는 제공하지 않습니다.</p>
        <fieldset disabled={submitting}>
          <legend>연결처 선택 — 선택하지 않으면 미연결로 저장</legend>
          {CONNECTIONS.map((connection) => (
            <label key={connection.id}>
              <input type="checkbox" checked={connectionIds.includes(connection.id)}
                data-testid={`registration-connection-${connection.id}`}
                onChange={(event) => toggleConnection(connection.id, event.currentTarget.checked)} />
              {connection.name} · {connection.type}
            </label>
          ))}
          <p data-testid="registration-connection-preview">{connectionIds.length === 0 ? "연결처 없음" : `선택 순서: ${connectionIds.map((value) => CONNECTIONS[value].name).join(" → ")}`}</p>
        </fieldset>
        <p>연결 관계를 기록할 뿐, 외부 MCP/CLI를 실행하거나 공급자에게 연결 여부를 확인하지 않습니다.</p>
        </> : <div data-testid="registration-password-preview">
          <p>가상 서비스: Example Password Service · 실제 서비스 가입이나 로그인을 수행하지 않습니다.</p>
          <p>{kind === "password_only" ? "저장할 자격 증명: 테스트 비밀번호 1개. 계정 식별자는 포함하지 않습니다."
            : "저장할 자격 증명: 테스트 비밀번호 + 계정 식별자 포함(원문 비표시). 식별자를 함께 보관하는 예시입니다."}</p>
          <p>준비된 합성 값만 암호화해 저장합니다. 비밀번호·계정 식별자 원문 입력·조회·복사는 제공하지 않습니다.</p>
          <p>비밀번호는 이 데모에서 연결처 없이 저장합니다. 연결 편집·API 키 교체 연습은 API 키 항목만 지원합니다.</p>
        </div>}
        <label className="registration-acknowledgement">
          <input type="checkbox" checked={acknowledged} disabled={submitting} data-testid="registration-acknowledgement"
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              updateDraft((previous) => ({ ...previous, acknowledged: checked }));
            }} />
          가상 데이터만 저장하는 연습임을 확인했습니다.
        </label>
        <div className="vault-actions">
          <button type="submit" disabled={!acknowledged || atCapacity || submitting} data-testid="registration-submit">
            {submitting ? "저장 확인 중" : "선택한 합성 항목 저장"}
          </button>
        </div>
        {atCapacity && <p role="status">이 합성 금고의 128개 항목 한도에 도달했습니다. 기존 내용을 덮어쓰지 않습니다.</p>}
        <small>총 암호문 크기는 512 KiB까지입니다. 한도에 도달하면 추가를 중단합니다. 저장은 실제 저장본을 다시 읽고 인증한 후에만 목록에 반영됩니다.</small>
      </form>
    </section>
  );
}
