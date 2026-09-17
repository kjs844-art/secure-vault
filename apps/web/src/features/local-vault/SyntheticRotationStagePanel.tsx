import { useId, useState, useSyncExternalStore } from "react";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { LocalRotationStageV1 } from "../../bridge/rotationStageProtocol";
import type { SyntheticRotationStageSelection } from "./syntheticRotationStage";
import type { SyntheticRotationStageReceipt, SyntheticRotationStageReviewState, SyntheticVaultSession } from "./SyntheticVaultSession";

const EVIDENCE = ["pending", "user_confirmed", "provider_verified"] as const;
const LABELS = { pending: "아직 확인하지 않음", user_confirmed: "사용자가 확인했다고 가정", provider_verified: "공급자가 확인했다고 가정" };
const FIXTURES = [{ id: "mcp", label: "Example MCP" }, { id: "cli", label: "Example CLI" }, { id: "ci", label: "Example CI" }] as const;
type StagePanelSession = Pick<SyntheticVaultSession,
  "subscribe" | "rotationStageReviewState" | "inspectRotationStage" | "saveRotationStage" | "commitRotationCutoverFromStage">;

function emptySelection(reference: number): SyntheticRotationStageSelection {
  return { reference, mcp: "pending", cli: "pending", ci: "pending", supersededRevocation: "pending" };
}

export function selectionFromSavedStage(reference: number, stage: LocalRotationStageV1): SyntheticRotationStageSelection {
  const result = { ...emptySelection(reference), supersededRevocation: stage.revocation };
  for (const entry of stage.entries) result[entry.fixture] = entry.completion;
  return Object.freeze(result);
}

export function canCommitSavedRotation(
  review: SyntheticRotationStageReviewState, receipt: SyntheticRotationStageReceipt | null,
  selection: SyntheticRotationStageSelection, acknowledged: boolean,
): boolean {
  if (!acknowledged || review.phase !== "ready" || !review.stage?.readyForCutover
      || !receipt?.stage || receipt.reviewVersion !== review.reviewVersion
      || receipt.reference !== selection.reference) return false;
  const saved = selectionFromSavedStage(receipt.reference, receipt.stage);
  return saved.mcp === selection.mcp && saved.cli === selection.cli && saved.ci === selection.ci
    && saved.supersededRevocation === selection.supersededRevocation;
}

/** Only closed demo selections; saved progress never restores final consent. */
export function SyntheticRotationStagePanel({ session, vaultGeneration, entries }: {
  readonly session: StagePanelSession; readonly vaultGeneration: number;
  readonly entries: readonly LocalCatalogEntryV1[];
}) {
  const id = useId();
  const [selection, setSelection] = useState(() => emptySelection(entries[0]?.reference ?? 0));
  const [receipt, setReceipt] = useState<SyntheticRotationStageReceipt | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const review = useSyncExternalStore((listener) => session.subscribe(listener),
    () => session.rotationStageReviewState, () => session.rotationStageReviewState);
  const loading = review.phase === "loading";
  const matches = receipt?.reviewVersion === review.reviewVersion && receipt.reference === selection.reference;
  const canCommit = canCommitSavedRotation(review, receipt, selection, acknowledged);

  function update(field: "mcp" | "cli" | "ci" | "supersededRevocation", value: string) {
    const evidence = EVIDENCE.find((item) => item === value);
    if (evidence !== undefined) { setSelection({ ...selection, [field]: evidence }); setAcknowledged(false); }
  }

  return <section className="synthetic-rotation" aria-labelledby={`${id}-heading`} data-testid="rotation-stage-panel">
    <h2 id={`${id}-heading`}>키 교체 진행 저장 · 이어하기</h2>
    <p>연결처 확인 내용을 암호화해 중간 저장합니다. 마지막 확정 전까지 현재 키와 연결 정보는 그대로 유지됩니다.</p>
    <p className="demo-warning"><strong>합성 연습 전용 · 실제 키 입력 금지.</strong> 공급자 확인·폐기는 가정일 뿐이며 실제 API를 호출하지 않습니다.</p>
    <label htmlFor={`${id}-reference`}>교체할 합성 항목</label>
    <select id={`${id}-reference`} value={selection.reference} disabled={loading} data-testid="stage-reference"
      onChange={(event) => {
        const entry = entries.find((item) => String(item.reference) === event.currentTarget.value);
        if (entry) { setSelection(emptySelection(entry.reference)); setReceipt(null); setAcknowledged(false); }
      }}>
      {entries.map((entry) => <option key={entry.reference} value={entry.reference}>{entry.providerName} · {entry.itemName} · 예시 {entry.reference + 1}</option>)}
    </select>
    <div className="vault-actions"><button type="button" disabled={loading || entries.length === 0}
      data-testid="stage-load" onClick={() => {
        setAcknowledged(false); setReceipt(null);
        void session.inspectRotationStage(vaultGeneration, selection.reference).then((next) => {
          if (next === null) return;
          setReceipt(next);
          setSelection(next.stage ? selectionFromSavedStage(next.reference, next.stage) : emptySelection(next.reference));
          setAcknowledged(false);
        });
      }}>저장한 진행 불러오기 · 검토</button></div>
    <fieldset disabled={loading}><legend>새 합성 키 적용 확인</legend>
      {FIXTURES.map((fixture) => <label key={fixture.id} htmlFor={`${id}-${fixture.id}`}>{fixture.label}
        <select id={`${id}-${fixture.id}`} value={selection[fixture.id]} data-testid={`stage-${fixture.id}`}
          onChange={(event) => update(fixture.id, event.currentTarget.value)}>
          {EVIDENCE.map((evidence) => <option key={evidence} value={evidence}>{LABELS[evidence]}</option>)}
        </select></label>)}
      <label htmlFor={`${id}-revocation`}>이전 합성 키 폐기 확인
        <select id={`${id}-revocation`} value={selection.supersededRevocation} data-testid="stage-revocation"
          onChange={(event) => update("supersededRevocation", event.currentTarget.value)}>
          {EVIDENCE.map((evidence) => <option key={evidence} value={evidence}>{LABELS[evidence]}</option>)}
        </select></label>
    </fieldset>
    <p>항목에 없는 연결처는 ‘아직 확인하지 않음’으로 두세요. 필수 연결처 확인이 끝나기 전에는 이전 키 폐기를 확인할 수 없습니다.</p>
    <div className="vault-actions"><button type="button" disabled={loading || entries.length === 0} data-testid="stage-save"
      onClick={() => { setAcknowledged(false); void session.saveRotationStage(vaultGeneration, selection); }}>진행만 암호화 저장</button></div>
    <p>저장·새로고침 후에는 항목을 다시 선택하고 ‘저장한 진행 불러오기’를 누르세요. 선택을 바꿨다면 먼저 중간 저장해야 최종 확정에 반영됩니다.</p>
    <p role="status" aria-live="polite" data-testid="stage-status">
      {review.phase === "idle" && "현재 키는 유지됩니다. 중간 저장하거나 저장한 진행을 불러올 수 있습니다."}
      {review.phase === "loading" && "저장한 암호문과 진행 내용을 인증하고 있습니다."}
      {review.phase === "error" && `진행을 확인하지 못했습니다 (${review.errorCode}). 기존 데이터는 자동으로 초기화하지 않습니다.`}
      {review.phase === "ready" && matches && !review.stage && "현재 항목에 저장된 진행이 없습니다. 확정 후에는 이전 진행이 다시 적용되지 않습니다."}
      {review.phase === "ready" && !matches && "이 화면의 항목에 대해 저장한 진행을 다시 불러오세요."}
    </p>
    {review.phase === "ready" && matches && review.stage && <div data-testid="stage-details">
      <p>현재 {review.stage.baseGeneration} → 교체 예정 {review.stage.targetGeneration}</p>
      <p>미확인 필수 연결처 {review.stage.remainingRequired}개 · 선택 연결처 {review.stage.remainingOptional}개</p>
      <p>{review.stage.readyForCutover ? "저장된 진행의 확정 조건이 준비됐습니다." : "저장된 진행에 미확인 조건이 남아 있습니다."}</p>
      <ul>{review.stage.entries.map((entry) => <li key={entry.fixture}>{entry.fixture} · {entry.requiredForCutover ? "필수" : "선택"} · {LABELS[entry.completion]}</li>)}</ul>
    </div>}
    <label className="rotation-acknowledgement"><input type="checkbox" checked={acknowledged} data-testid="stage-ack"
      disabled={!canCommitSavedRotation(review, receipt, selection, true)}
      onChange={(event) => setAcknowledged(event.currentTarget.checked)} />
      저장한 합성 진행을 검토했고, 현재 키를 교체 예정 키로 최종 확정하는 연습임을 확인합니다.
    </label>
    <div className="vault-actions"><button type="button" disabled={!canCommit} data-testid="stage-commit"
      onClick={() => { if (canCommit) void session.commitRotationCutoverFromStage(vaultGeneration, review.reviewVersion); }}>저장한 교체 최종 확정</button></div>
    <small>다른 창이 먼저 저장하면 덮어쓰지 않고 충돌 후보를 보관합니다. 저장 후 다시 읽어 인증한 경우에만 금고를 다시 표시합니다.</small>
  </section>;
}
