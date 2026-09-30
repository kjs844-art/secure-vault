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
        <h2 id="ai-boundary-heading">AI 데이터 미리보기</h2>
        <p>
          현재 실제 AI 서비스에 연결하거나 데이터를 전송하지 않습니다. 아래 버튼은
          합성 데모 데이터 중 허용목록에 포함된 항목만 화면에 미리 보여줍니다.
        </p>
        <p>
          서비스명·환경·권한·날짜도 민감할 수 있습니다. 외부에 복사하거나 공유하기 전에
          내용을 직접 확인하세요.
        </p>
        <button type="button" onClick={() => setShowAiPayload((value) => !value)}>
          {showAiPayload ? "미리보기 숨기기" : "허용목록 미리보기 보기"}
        </button>
        {showAiPayload ? (
          <pre aria-label="화면에만 표시되는 합성 허용목록 데이터">
            {JSON.stringify(aiSafeInventory, null, 2)}
          </pre>
        ) : null}
      </section>
    </main>
  );
}
