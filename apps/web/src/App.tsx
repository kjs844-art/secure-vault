import { useMemo, useState } from "react";

import { SyntheticVaultCatalogRepository } from "./repositories/SyntheticVaultCatalogRepository";
import { toAiSafeInventory } from "./security/toAiSafeInventory";
import "./styles.css";

const kindLabels = {
  password: "비밀번호",
  api_key: "API 키",
  mcp_credential: "MCP 자격 증명",
  recovery_code: "복구 코드",
} as const;

export function App() {
  const [showAiPayload, setShowAiPayload] = useState(false);
  const vaultItems = useMemo(
    () => new SyntheticVaultCatalogRepository().list(),
    [],
  );
  const aiSafeInventory = useMemo(
    () => toAiSafeInventory(vaultItems),
    [vaultItems],
  );

  return (
    <main>
      <header>
        <p className="eyebrow">KeyAtlas · functional scaffold</p>
        <h1>내 자격 증명이 어디에 연결됐는지 한눈에</h1>
        <p>
          이 화면은 합성 데이터만 사용하는 기능 골격입니다. 실제 비밀번호나
          API 키를 입력하지 마세요.
        </p>
      </header>

      <section>
        <h2>합성 관계 / 로컬 저장 테스트</h2>
        <p>Rust/WASM으로 만든 합성 암호문을 브라우저에 저장하고, 다시 열어 연결 관계를 확인합니다.</p>
        <a href="/?view=local-vault">로컬 합성 금고 열기 →</a>
      </section>

      <section aria-labelledby="inventory-heading">
        <div className="section-heading">
          <div>
            <h2 id="inventory-heading">합성 금고 항목</h2>
            <p>{vaultItems.length}개의 안전한 데모 레코드</p>
          </div>
        </div>

        <ul className="inventory-list">
          {vaultItems.map((metadata) => (
            <li key={metadata.id}>
              <div>
                <strong>{metadata.serviceName}</strong>
                <span>{kindLabels[metadata.kind]}</span>
              </div>
              <dl>
                <div>
                  <dt>환경</dt>
                  <dd>{metadata.environment}</dd>
                </div>
                <div>
                  <dt>상태</dt>
                  <dd>{metadata.status}</dd>
                </div>
                <div>
                  <dt>연결</dt>
                  <dd>{metadata.connectionLabels.length}곳</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ai-boundary-heading">
        <h2 id="ai-boundary-heading">AI 전송 안전 경계</h2>
        <p>
          AI에는 Secret, 계정, 메모, URL, 프로젝트명이 아니라 검토된 메타데이터
          허용목록만 전달합니다.
        </p>
        <button type="button" onClick={() => setShowAiPayload((value) => !value)}>
          {showAiPayload ? "전송 데이터 숨기기" : "AI 전송 데이터 미리보기"}
        </button>
        {showAiPayload ? (
          <pre aria-label="AI에 전달 가능한 합성 메타데이터">
            {JSON.stringify(aiSafeInventory, null, 2)}
          </pre>
        ) : null}
      </section>
    </main>
  );
}
