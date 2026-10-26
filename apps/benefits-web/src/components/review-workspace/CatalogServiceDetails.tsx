import type { CatalogServiceProfileView, CatalogServiceView } from "../../domain/catalog-client/responses";

const FIELDS: readonly (readonly [keyof CatalogServiceProfileView, string])[] = [
  ["name", "서비스 이름"], ["provider", "제공자"], ["planName", "요금제 이름"],
  ["accountLabel", "계정 표시 이름"], ["timezone", "시간대"], ["subscriptionStatus", "기록된 구독 상태"],
  ["trialEndsAt", "기록된 체험 종료일"], ["notes", "메모"],
];

/** Text-only rendering of an already validated DTO, not a validation or authority
 * boundary. The parent owns explicit disclosure and exact observation lifetime. */
export function CatalogServiceDetails({ record }: { readonly record: CatalogServiceView }) {
  if (record.state !== "live" || record.profile === null) return null;
  return <div data-testid="catalog-service-details">
    <p>현재 화면에 불러온 서비스 관찰입니다. 상세 보기는 새 조회나 실제 가입·요금제·구독 상태 확인이 아닙니다.</p>
    <dl>
      <div><dt>서비스 ID</dt><dd>{record.serviceId}</dd></div>
      <div><dt>관찰한 버전</dt><dd>{record.serviceRevision}</dd></div>
      {FIELDS.map(([key, label]) => <div key={key}>
        <dt>{label}</dt><dd data-testid={`catalog-service-detail-value-${key}`}
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {record.profile![key] === null ? "모름 (null)" : record.profile![key]}
        </dd>
      </div>)}
      <div><dt>생성 시각 (Unix epoch 밀리초)</dt><dd data-testid="catalog-service-detail-createdAt">{record.createdAt}</dd></div>
      <div><dt>수정 시각 (Unix epoch 밀리초)</dt><dd data-testid="catalog-service-detail-updatedAt">{record.updatedAt}</dd></div>
      <div><dt>정보 출처</dt><dd>사용자 진술 (user-reported)</dd></div>
      <div><dt>계정 보유 여부</dt><dd>확인되지 않음 (not-established)</dd></div>
    </dl>
    <p>날짜·시간대·상태는 기록된 값 그대로입니다. 현재 상태나 만료 여부를 추론하지 않습니다.</p>
  </div>;
}
