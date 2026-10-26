import type { ReviewedBenefitValues, ReviewedBenefitView } from "../../domain/reviewed-benefit-view";

type Saved = Extract<ReviewedBenefitView, { readonly outcome: "saved" }>;
const FIELDS: readonly [keyof ReviewedBenefitValues, string][] = [
  ["name", "혜택 이름"], ["kind", "종류"], ["unit", "단위"], ["grantedAmount", "기록된 지급량"],
  ["remainingAmount", "기록된 잔량"], ["trialDaysStated", "기록된 체험 일수"],
  ["remainingDaysStated", "기록된 남은 일수"], ["expiresAt", "기록된 만료일"], ["observedAt", "관찰 시각"],
];
const text = (value: string | number | null) => value === null ? "모름" : String(value);

/** Read-only rendering of an already accepted minimal DTO. The parent owns the
 * explicit disclosure, exact row identity and live workspace lease. No I/O,
 * clocks, source-mail access or independent permission claim belongs here. */
export function ReviewedBenefitDetails({ record }: { readonly record: Saved }) {
  const content = record.content;
  return <div data-testid="reviewed-benefit-details">
    <h5>저장된 관찰 상세</h5>
    <p>현재 화면에 불러온 기록입니다. 상세 보기는 새 조회나 현재 잔액 검증이 아닙니다.</p>
    <dl>
      <div><dt>검토 당시 서비스</dt><dd data-testid="reviewed-benefit-detail-service">{content.serviceNameAtReview}</dd></div>
      {FIELDS.map(([key, label]) => <div key={key}>
        <dt>{label}</dt><dd data-testid={`reviewed-benefit-detail-value-${key}`}>{text(content.values[key])}</dd>
        <dd data-testid={`reviewed-benefit-detail-origin-${key}`}>
          {content.valueOrigins[key] === "user-corrected" ? "사용자가 수정한 값" : "메일에서 추출된 값"}
        </dd>
      </div>)}
      <div><dt>수신 시각</dt><dd data-testid="reviewed-benefit-detail-receivedAt">{text(content.receivedAt)}</dd></div>
      <div><dt>추출 시각</dt><dd data-testid="reviewed-benefit-detail-extractedAt">{content.extractedAt}</dd></div>
      <div><dt>원래 관찰 시각</dt><dd data-testid="reviewed-benefit-detail-sourceObservedAt">{text(content.sourceObservedAt)}</dd></div>
      <div><dt>사용자 검토 시각</dt><dd data-testid="reviewed-benefit-detail-reviewedAt">{content.reviewedAt}</dd></div>
    </dl>
    <p>계정 보유 여부: 확인되지 않음 · 현재 잔액: 확인되지 않음</p>
    <p>사용자 검토는 사실 인증이 아닙니다. 원문 메일은 이 상세에 포함되지 않습니다.</p>
    <h6>기록에 남은 검토 필요 이유</h6>
    <ul>{content.reviewReasons.map((reason) => <li key={reason} data-review-reason={reason}>{reason}</li>)}</ul>
  </div>;
}
