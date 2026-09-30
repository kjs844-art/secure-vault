import { useMemo, useState } from "react";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  consumerLabels,
  credentialLabels,
  statusLabels,
} from "../local-vault/searchLocalCatalog";
import {
  buildIdentityMap,
  emptyIdentityMapView,
  reduceIdentityMap,
  type IdentityMapView,
} from "./identityMapModel";
import { SYNTHETIC_IDENTITY_MAP_ENTRIES } from "./syntheticIdentityMapFixture";
import "./identity-map.css";

export function IdentityMapPanel({
  entries,
  sourceLabel = "닫힌 합성 예시",
  embedded = false,
}: {
  readonly entries?: readonly LocalCatalogEntryV1[];
  readonly sourceLabel?: string;
  readonly embedded?: boolean;
}) {
  const graph = useMemo(
    () => buildIdentityMap(entries ?? SYNTHETIC_IDENTITY_MAP_ENTRIES),
    [entries],
  );
  const [view, setView] = useState<IdentityMapView>(() => emptyIdentityMapView(graph));
  const shown = view.accounts === graph.accounts ? view : emptyIdentityMapView(graph);
  const Root = embedded ? "section" : "main";

  return (
    <Root className="identity-map" {...(embedded ? { "aria-labelledby": "identity-map-title" } : {})}>
      <header>
        <p className="eyebrow">KeyAtlas · KA-C02 Identity Map</p>
        {embedded ? (
          <h2 id="identity-map-title">계정 · 발급처 · 사용처를 세 단계로 보기</h2>
        ) : (
          <h1>계정 · 발급처 · 사용처를 세 단계로 보기</h1>
        )}
        <p>
          자동 발견 결과가 아닙니다. {sourceLabel}만 보여 주며, 비밀번호·API 키 원문은
          이 화면에 두지 않습니다.
        </p>
        <p className="demo-warning">
          <strong>REAL_SECRET_GATE=CLOSED.</strong> 실제 계정 조회, 메일 탐색, password manager
          import는 C03~C06 범위이며 이 화면에 없습니다.
        </p>
        {embedded ? null : <a href="/">기존 합성 목록 화면</a>}
      </header>

      <nav aria-label="Identity Map 단계" className="identity-map-steps">
        <ol>
          <li aria-current={shown.step === "account" ? "step" : undefined}>1. 계정</li>
          <li aria-current={shown.step === "issuer" ? "step" : undefined}>2. 발급처</li>
          <li aria-current={shown.step === "usage" ? "step" : undefined}>3. 사용처</li>
        </ol>
      </nav>

      <p role="status" aria-live="polite" data-testid="identity-map-status">
        {shown.step === "account" && `계정 ${shown.accounts.length}곳`}
        {shown.step === "issuer" && `${shown.selectedAccount?.serviceName ?? ""} · 발급처 ${shown.issuers.length}개`}
        {shown.step === "usage" && `${shown.selectedIssuer?.itemName ?? ""} · 사용처 ${shown.usages.length}곳`}
      </p>

      {shown.step !== "account" ? (
        <div className="identity-map-actions">
          <button type="button" data-testid="identity-map-back" onClick={() => setView((current) => reduceIdentityMap(graph, current, { type: "back" }))}>
            이전 단계
          </button>
          <button type="button" data-testid="identity-map-reset" onClick={() => setView(emptyIdentityMapView(graph))}>
            계정 목록으로
          </button>
        </div>
      ) : null}

      {shown.step === "account" ? (
        <section aria-labelledby="identity-account-heading">
          <h2 id="identity-account-heading">1. 계정</h2>
          {shown.accounts.length === 0 ? (
            <p data-testid="identity-map-empty">표시할 합성 계정이 없습니다.</p>
          ) : (
            <ul className="identity-map-list">
              {shown.accounts.map((account) => (
                <li key={account.id}>
                  <button
                    type="button"
                    data-testid="identity-map-account"
                    onClick={() => setView((current) => reduceIdentityMap(graph, current, { type: "select-account", accountId: account.id }))}
                  >
                    <strong>{account.serviceName}</strong>
                    <span>{account.accountLabel}</span>
                    <small>발급처 {account.issuerCount} · 사용처 {account.usageCount}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {shown.step === "issuer" ? (
        <section aria-labelledby="identity-issuer-heading">
          <h2 id="identity-issuer-heading">2. 발급처</h2>
          <p>
            {shown.selectedAccount?.serviceName} / {shown.selectedAccount?.accountLabel}
          </p>
          <ul className="identity-map-list">
            {shown.issuers.map((issuer) => (
              <li key={issuer.id}>
                <button
                  type="button"
                  data-testid="identity-map-issuer"
                  onClick={() => setView((current) => reduceIdentityMap(graph, current, { type: "select-issuer", issuerId: issuer.id }))}
                >
                  <strong>{issuer.itemName}</strong>
                  <span>{credentialLabels[issuer.credentialType]} · {statusLabels[issuer.status]}</span>
                  <small>
                    {issuer.organizationLabel} / {issuer.projectLabel} / {issuer.environmentLabel} · 사용처 {issuer.usageCount}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {shown.step === "usage" ? (
        <section aria-labelledby="identity-usage-heading">
          <h2 id="identity-usage-heading">3. 사용처</h2>
          <p>{shown.selectedIssuer?.itemName}</p>
          {shown.usages.length === 0 ? (
            <p data-testid="identity-map-no-usage">아직 연결 기록이 없는 발급처입니다.</p>
          ) : (
            <ul className="identity-map-list" data-testid="identity-map-usages">
              {shown.usages.map((usage) => (
                <li key={usage.id}>
                  <p><strong>{usage.label}</strong></p>
                  <span className="consumer-type">{consumerLabels[usage.consumerType]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </Root>
  );
}
