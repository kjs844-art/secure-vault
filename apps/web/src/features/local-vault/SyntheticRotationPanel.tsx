import { useId, useState, useSyncExternalStore } from "react";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type {
  SyntheticRotationInspectionReceipt,
  SyntheticRotationReviewState,
  SyntheticVaultSession,
} from "./SyntheticVaultSession";
import {
  SYNTHETIC_ROTATION_COMPLETION_EVIDENCE_V1,
  SYNTHETIC_ROTATION_REVOCATION_EVIDENCE_V1,
  type SyntheticRotationCompletionEvidenceV1,
  type SyntheticRotationRevocationEvidenceV1,
  type SyntheticRotationSelection,
} from "./syntheticRotation";

const FIXTURES = [
  { id: "mcp", label: "Example MCP" },
  { id: "cli", label: "Example CLI" },
  { id: "ci", label: "Example CI" },
] as const;

const COMPLETION_LABELS: Record<SyntheticRotationCompletionEvidenceV1, string> = {
  pending: "아직 확인하지 않음",
  user_confirmed: "사용자가 확인함 (합성 연습)",
  provider_verified: "공급자가 확인했다고 가정 (합성 연습)",
};

const REVOCATION_LABELS: Record<SyntheticRotationRevocationEvidenceV1, string> = {
  user_confirmed: "사용자가 이전 키 폐기를 확인했다고 가정",
  provider_verified: "공급자가 이전 키 폐기를 확인했다고 가정",
};

type RotationPanelSession = Pick<
  SyntheticVaultSession,
  "subscribe" | "rotationReviewState" | "inspectRotation" | "commitRotationCutover"
>;

export type SyntheticRotationReviewIdentity = SyntheticRotationInspectionReceipt;

export function sameSyntheticRotationSelection(
  left: SyntheticRotationSelection | null,
  right: SyntheticRotationSelection,
): boolean {
  return left !== null
    && left.reference === right.reference
    && left.mcp === right.mcp
    && left.cli === right.cli
    && left.ci === right.ci
    && left.supersededRevocation === right.supersededRevocation;
}

export function canCommitSyntheticRotation(
  review: SyntheticRotationReviewState,
  reviewed: SyntheticRotationReviewIdentity | null,
  currentSelection: SyntheticRotationSelection,
  acknowledged: boolean,
): boolean {
  return acknowledged
    && review.phase === "ready"
    && reviewed?.reviewVersion === review.reviewVersion
    && review.checklist?.readinessState === "ready"
    && sameSyntheticRotationSelection(reviewed?.selection ?? null, currentSelection);
}

/** Closed synthetic choices only; this component has no free-text Secret input. */
export function SyntheticRotationPanel({
  session,
  vaultGeneration,
  entries,
}: {
  readonly session: RotationPanelSession;
  readonly vaultGeneration: number;
  readonly entries: readonly LocalCatalogEntryV1[];
}) {
  const id = useId();
  const rotatableEntries = entries.filter((entry) => Number.isSafeInteger(entry.reference)
    && !Object.is(entry.reference, -0) && entry.reference >= 0 && entry.reference <= 127);
  const [reference, setReference] = useState(rotatableEntries[0]?.reference ?? 0);
  const [mcp, setMcp] = useState<SyntheticRotationCompletionEvidenceV1>("pending");
  const [cli, setCli] = useState<SyntheticRotationCompletionEvidenceV1>("pending");
  const [ci, setCi] = useState<SyntheticRotationCompletionEvidenceV1>("pending");
  const [supersededRevocation, setSupersededRevocation]
    = useState<SyntheticRotationRevocationEvidenceV1>("user_confirmed");
  const [reviewed, setReviewed] = useState<SyntheticRotationReviewIdentity | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const review = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.rotationReviewState,
    () => session.rotationReviewState,
  );
  const currentSelection: SyntheticRotationSelection = Object.freeze({
    reference,
    mcp,
    cli,
    ci,
    supersededRevocation,
  });
  const reviewMatchesCurrent = sameSyntheticRotationSelection(
    reviewed?.selection ?? null,
    currentSelection,
  ) && reviewed?.reviewVersion === review.reviewVersion;
  const canCommit = canCommitSyntheticRotation(
    review,
    reviewed,
    currentSelection,
    acknowledged,
  );
  const loading = review.phase === "loading";

  function updateCompletion(
    value: string,
    setter: (next: SyntheticRotationCompletionEvidenceV1) => void,
  ) {
    const next = SYNTHETIC_ROTATION_COMPLETION_EVIDENCE_V1.find((item) => item === value);
    if (next !== undefined) {
      setter(next);
      setAcknowledged(false);
    }
  }

  function updateRevocation(value: string) {
    const next = SYNTHETIC_ROTATION_REVOCATION_EVIDENCE_V1.find((item) => item === value);
    if (next !== undefined) {
      setSupersededRevocation(next);
      setAcknowledged(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="synthetic-rotation"
      data-testid="rotation-panel">
      <h2 id={`${id}-heading`}>합성 API 키 회전 검토</h2>
      <p>선택한 합성 항목의 연결처 확인 상태를 점검하고 새 암호문 후보를 만듭니다.
        실제 공급자 API를 호출하거나 실제 키를 갱신·폐기하지 않습니다.</p>
      <p className="demo-warning"><strong>실제 키·비밀번호 입력 금지.</strong> 아래의
        ‘공급자 확인’도 실제 확인 결과가 아니라 닫힌 가상 선택입니다.</p>

      <form onSubmit={(event) => {
        event.preventDefault();
        if (loading || rotatableEntries.length === 0) return;
        const snapshot = Object.freeze({ ...currentSelection });
        setAcknowledged(false);
        void session.inspectRotation(vaultGeneration, snapshot).then((receipt) => {
          if (receipt !== null) setReviewed(receipt);
        });
      }}>
        <label htmlFor={`${id}-entry`}>회전할 합성 항목</label>
        <select id={`${id}-entry`} value={reference} disabled={loading}
          data-testid="rotation-reference" onChange={(event) => {
            const selected = rotatableEntries.find(
              (entry) => String(entry.reference) === event.currentTarget.value,
            );
            if (selected) {
              setReference(selected.reference);
              setAcknowledged(false);
            }
          }}>
          {rotatableEntries.map((entry) => <option value={entry.reference} key={entry.reference}>
            {entry.providerName} · {entry.itemName} · 예시 {entry.reference + 1}
          </option>)}
        </select>

        <fieldset disabled={loading}>
          <legend>연결처별 새 합성 키 적용 확인</legend>
          {FIXTURES.map((fixture) => {
            const value = currentSelection[fixture.id];
            const setter = fixture.id === "mcp" ? setMcp : fixture.id === "cli" ? setCli : setCi;
            return <label key={fixture.id} htmlFor={`${id}-${fixture.id}`}>
              {fixture.label}
              <select id={`${id}-${fixture.id}`} value={value}
                data-testid={`rotation-${fixture.id}`}
                onChange={(event) => updateCompletion(event.currentTarget.value, setter)}>
                {SYNTHETIC_ROTATION_COMPLETION_EVIDENCE_V1.map((evidence) => (
                  <option value={evidence} key={evidence}>{COMPLETION_LABELS[evidence]}</option>
                ))}
              </select>
            </label>;
          })}
        </fieldset>

        <label htmlFor={`${id}-revocation`}>이전 합성 키 폐기 확인</label>
        <select id={`${id}-revocation`} value={supersededRevocation} disabled={loading}
          data-testid="rotation-revocation"
          onChange={(event) => updateRevocation(event.currentTarget.value)}>
          {SYNTHETIC_ROTATION_REVOCATION_EVIDENCE_V1.map((evidence) => (
            <option value={evidence} key={evidence}>{REVOCATION_LABELS[evidence]}</option>
          ))}
        </select>

        <div className="vault-actions">
          <button type="submit" disabled={loading || rotatableEntries.length === 0}
            data-testid="rotation-inspect">현재 선택 검토</button>
        </div>
      </form>

      <p role="status" aria-live="polite" className="vault-status"
        data-testid="rotation-status">
        {review.phase === "idle" && "아직 회전 조건을 검토하지 않았습니다."}
        {review.phase === "loading" && "현재 표시 암호문과 선택을 인증·검토하고 있습니다."}
        {review.phase === "error"
          && `회전 조건을 확인하지 못했습니다 (${review.errorCode}). 자동 재시도하지 않습니다.`}
        {review.phase === "ready" && review.checklist?.readinessState === "required_pending"
          && `필수 연결처 ${review.checklist.remainingRequired}개가 아직 확인되지 않았습니다.`}
        {review.phase === "ready" && review.checklist?.readinessState === "ready"
          && `필수 조건이 준비됐습니다. 선택 연결처 미확인 ${review.checklist.remainingOptional}개가 남아 있습니다.`}
        {review.phase === "ready" && review.checklist?.readinessState === "terminal"
          && "이 합성 항목은 마지막 데모 세대에 있어 추가 회전을 만들 수 없습니다."}
      </p>

      {review.phase === "ready" && review.checklist && <div data-testid="rotation-checklist">
        <p>현재 합성 세대: <strong>{review.checklist.generation}</strong></p>
        <ul>
          {review.checklist.entries.map((entry) => <li key={entry.fixture}>
            {FIXTURES.find((fixture) => fixture.id === entry.fixture)?.label ?? entry.fixture}
            {entry.requiredForCutover ? " · 필수" : " · 선택"}
          </li>)}
        </ul>
      </div>}

      {review.phase === "ready" && !reviewMatchesCurrent && <p className="demo-warning">
        검토 후 선택이 바뀌었거나 이 화면에서 검토하지 않은 결과입니다. 현재 선택을 다시 검토하세요.
      </p>}

      <label className="rotation-acknowledgement">
        <input type="checkbox" checked={acknowledged}
          disabled={review.phase !== "ready" || !reviewMatchesCurrent
            || review.checklist?.readinessState !== "ready"}
          data-testid="rotation-acknowledgement"
          onChange={(event) => setAcknowledged(event.currentTarget.checked)} />
        가상 데이터로 키 교체를 연습하며, 검토한 항목과 연결처 확인 상태를
        저장한다는 점을 확인했습니다.
      </label>
      <div className="vault-actions">
        <button type="button" disabled={!canCommit} data-testid="rotation-commit"
          onClick={() => {
            if (!canCommit) return;
            void session.commitRotationCutover(vaultGeneration, review.reviewVersion);
          }}>검토한 합성 회전 저장</button>
      </div>
      <small>저장 전후 데이터 확인이 모두 끝나야 성공으로 표시됩니다.
        다른 창의 변경과 충돌하면 덮어쓰지 않고 후보를 따로 보관합니다.</small>
    </section>
  );
}
