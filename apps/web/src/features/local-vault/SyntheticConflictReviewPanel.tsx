import { useSyncExternalStore } from "react";
import { LocalCatalogResults } from "./LocalCatalogSearch";
import type { SyntheticVaultSession } from "./SyntheticVaultSession";

export function SyntheticConflictReviewPanel({ session, vaultGeneration }: {
  readonly session: SyntheticVaultSession;
  readonly vaultGeneration: number;
}) {
  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener), () => session.conflictReviewState,
    () => session.conflictReviewState,
  );
  const busy = state.phase === "loading" || state.phase === "discarding";
  const canLoad = state.phase === "idle" || state.phase === "discarded" || state.phase === "error";

  return (
    <section aria-labelledby="conflict-review-heading" data-testid="conflict-review">
      <h2 id="conflict-review-heading">보존된 합성 충돌 후보 검토</h2>
      <p>다른 탭과 저장이 겹쳐 현재 금고가 되지 못한 암호문 후보를 직접 확인합니다. 후보 번호는 생성 시각 순서가 아니며, 현재 금고를 바꾸거나 후보를 자동 병합하지 않습니다.</p>
      {canLoad && <div className="vault-actions">
        <button type="button" disabled={busy} onClick={() => {
          void session.loadConflictReviews(vaultGeneration);
        }}>후보 목록 확인</button>
      </div>}
      <p role="status" aria-live="polite" className="vault-status" data-testid="conflict-review-status">
        {state.phase === "idle" && "아직 후보 목록을 읽지 않았습니다."}
        {state.phase === "loading" && "후보 전체를 인증하는 중입니다. 모두 끝나기 전에는 어떤 목록도 표시하지 않습니다."}
        {state.phase === "ready" && (state.items.length === 0
          ? "보존된 충돌 후보가 없습니다."
          : `인증된 보존 후보 ${state.items.length}개를 표시합니다.`)}
        {state.phase === "confirm-discard" && "아직 삭제하지 않았습니다. 선택한 후보를 다시 확인한 뒤 한 번 더 승인하세요."}
        {state.phase === "discarding" && "검토한 암호문과 저장된 암호문이 정확히 같은지 확인한 뒤 폐기하고 있습니다."}
        {state.phase === "discarded" && "선택한 후보를 폐기했습니다. 목록은 자동으로 다시 읽지 않습니다."}
        {state.phase === "error" && `후보 작업을 완료하지 못했습니다 (${state.errorCode}). 현재 금고를 바꾸거나 자동 재시도하지 않았습니다.`}
      </p>

      {(state.phase === "ready" || state.phase === "confirm-discard" || state.phase === "discarding")
        && state.items.map((item) => {
          const pending = state.pendingReference === item.reference;
          return <article key={item.reference} aria-labelledby={`conflict-review-${item.reference}`}>
            <h3 id={`conflict-review-${item.reference}`}>보존 후보 {item.reference + 1}</h3>
            <p>인증된 합성 catalog {item.entries.length}개 항목입니다. 후보 번호는 이 화면에서만 유효합니다.</p>
            <LocalCatalogResults entries={item.entries} />
            {state.phase === "ready" && <button type="button" onClick={() => {
              session.requestConflictDiscard(state.reviewVersion, item.reference);
            }}>이 후보 폐기 검토</button>}
            {state.phase === "confirm-discard" && pending && <div className="vault-actions">
              <p><strong>이 작업은 보존 후보만 영구 삭제합니다.</strong> 현재 금고로 승격하거나 병합하지 않습니다.</p>
              <button type="button" onClick={() => {
                session.cancelConflictDiscard(state.reviewVersion);
              }}>취소</button>
              <button type="button" onClick={() => {
                void session.confirmConflictDiscard(state.reviewVersion, item.reference);
              }}>확인하고 후보 폐기</button>
            </div>}
          </article>;
        })}
    </section>
  );
}
