import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { PUBLIC_STATUS } from "../domain/integration-status";

const getIntegrationStatus = createServerFn({ method: "GET" }).handler(() => PUBLIC_STATUS);

export const Route = createFileRoute("/status")({
  loader: () => getIntegrationStatus(),
  component: IntegrationStatus,
});

function IntegrationStatus() {
  const status = Route.useLoaderData();
  return (
    <main>
      <h1>연결 준비 상태</h1>
      <p>서버가 반환한 개발 환경 상태입니다. 인증이나 서비스 연결 성공을 뜻하지 않습니다.</p>
      <dl>
        <dt>데이터</dt><dd>{status.dataset}</dd>
        <dt>DB</dt><dd>{status.database}</dd>
        <dt>로그인</dt><dd>{status.authentication}</dd>
        <dt>Gmail</dt><dd>{status.gmail}</dd>
        <dt>외부 AI</dt><dd>{status.externalAi}</dd>
        <dt>MCP</dt><dd>{status.mcp}</dd>
        <dt>실제 비밀정보 사용</dt><dd>{status.realSecretGate}</dd>
      </dl>
      <Link to="/">처음으로</Link>
    </main>
  );
}
