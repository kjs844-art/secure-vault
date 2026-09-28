import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: IntegrationLanding });

function IntegrationLanding() {
  return (
    <main>
      <p>KeyAtlas · 독립 이식 개발 환경</p>
      <h1>계정과 서비스 정보를 한곳으로</h1>
      <p role="status">합성 데이터 전용입니다. 실제 비밀번호·API 키·메일을 입력하지 마세요.</p>
      <p>서비스·혜택·확인 필요 항목을 합성 예시로 살펴볼 수 있습니다. 최종 디자인이 아닙니다.</p>
      <dl>
        <dt>원본 Lovable와 DB</dt><dd>연결하지 않음 · 원본 유지</dd>
        <dt>로그인·Gmail·외부 AI</dt><dd>연결 전 · 서버에서도 차단됨</dd>
        <dt>암호화 금고</dt><dd>별도 앱 유지 · 실제 비밀정보 사용 금지</dd>
      </dl>
      <nav aria-label="시작하기">
        <Link to="/demo">합성 데모 둘러보기</Link>{" · "}<Link to="/status">연결 준비 상태 확인</Link>
      </nav>
    </main>
  );
}
