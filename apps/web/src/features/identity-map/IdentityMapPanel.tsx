import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import "../../styles.css";
import {
  consumerLabels,
  credentialLabels,
  statusLabels,
} from "../local-vault/searchLocalCatalog";
import {
  buildIdentityMap,
  emptyIdentityMapView,
  reduceIdentityMap,
  type IdentityMapAction,
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
  const sourceEntries = entries ?? SYNTHETIC_IDENTITY_MAP_ENTRIES;
  // Render a replacement's empty view without writing replacement state during
  // render. A suspended render must not seed React's eager updater with B while
  // the still-committed A controls remain interactive.
  const context = useMemo(() => {
    const graph = buildIdentityMap(sourceEntries);
    return { scope: Symbol("identity-input"), graph, initialView: emptyIdentityMapView(graph) };
  }, [sourceEntries]);
  const [state, setState] = useState<{ scope: symbol; view: IdentityMapView }>(() => ({
    scope: context.scope, view: context.initialView,
  }));
  const scope = context.scope;
  const shown = state.scope === scope ? state.view : context.initialView;
  // Publish ownership only at commit, never from a render React might discard.
  const committedScope = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    committedScope.current = scope;
    return () => { if (committedScope.current === scope) committedScope.current = null; };
  }, [scope]);
  const selectedStep = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ scope: symbol; trigger: Element } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (!pending || pending.scope !== scope || pending.trigger.isConnected) return;
    const owner = pending.trigger.ownerDocument;
    const target = selectedStep.current;
    if (owner.activeElement === owner.body && target?.isConnected && target.ownerDocument === owner) {
      target.focus({ preventScroll: true });
    }
  }, [scope, shown]);
  const headingId = useId();
  const Root = embedded ? "section" : "main";

  const dispatch = (action: IdentityMapAction, trigger?: Element) => {
    if (committedScope.current !== scope) return;
    pendingFocus.current = trigger && trigger.ownerDocument.activeElement === trigger ? { scope, trigger } : null;
    setState((previous) => committedScope.current === scope
      ? { scope, view: reduceIdentityMap(context.graph,
        previous.scope === scope ? previous.view : context.initialView, action) }
      : previous);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || shown.step === "account"
      || committedScope.current !== scope) return;
    event.preventDefault();
    dispatch({ type: "back" }, event.target as Element);
  };

  return (
    <Root className="identity-map" data-testid="identity-map-root" onKeyDown={onKeyDown}
      {...(embedded ? { "aria-labelledby": `${headingId}-title` } : {})}>
      <header>
        <p className="eyebrow">KeyAtlas · KA-C02 Identity Map</p>
        {embedded ? (
          <h2 id={`${headingId}-title`}>계정 · 발급처 · 사용처를 세 단계로 보기</h2>
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
          <li>
            <button
              type="button"
              data-testid="identity-map-step-account"
              ref={shown.step === "account" ? selectedStep : undefined}
              aria-current={shown.step === "account" ? "step" : undefined}
              onClick={(event) => dispatch({ type: "open-step", step: "account" }, event.currentTarget)}
            >
              1. 계정
            </button>
          </li>
          <li>
            <button
              type="button"
              data-testid="identity-map-step-issuer"
              ref={shown.step === "issuer" ? selectedStep : undefined}
              aria-current={shown.step === "issuer" ? "step" : undefined}
              disabled={shown.selectedAccountId === null}
              onClick={(event) => dispatch({ type: "open-step", step: "issuer" }, event.currentTarget)}
            >
              2. 발급처
            </button>
          </li>
          <li>
            <button
              type="button"
              data-testid="identity-map-step-usage"
              ref={shown.step === "usage" ? selectedStep : undefined}
              aria-current={shown.step === "usage" ? "step" : undefined}
              disabled={shown.selectedIssuerId === null}
              onClick={(event) => dispatch({ type: "open-step", step: "usage" }, event.currentTarget)}
            >
              3. 사용처
            </button>
          </li>
        </ol>
      </nav>

      <p role="status" aria-live="polite" data-testid="identity-map-status">
        {shown.step === "account" && `계정 ${shown.accounts.length}곳`}
        {shown.step === "issuer" && `${shown.selectedAccount?.serviceName ?? ""} · 발급처 ${shown.issuers.length}개`}
        {shown.step === "usage" && `${shown.selectedIssuer?.itemName ?? ""} · 사용처 ${shown.usages.length}곳`}
      </p>

      {shown.step !== "account" ? (
        <div className="identity-map-actions">
          <button type="button" data-testid="identity-map-back" onClick={(event) => dispatch({ type: "back" }, event.currentTarget)}>
            이전 단계
          </button>
          <button type="button" data-testid="identity-map-reset" onClick={(event) => dispatch({ type: "reset" }, event.currentTarget)}>
            계정 목록으로
          </button>
        </div>
      ) : null}

      {shown.step === "account" ? (
        <section aria-labelledby={`${headingId}-account`}>
          <h2 id={`${headingId}-account`}>1. 계정</h2>
          {shown.accounts.length === 0 ? (
            <p data-testid="identity-map-empty">표시할 합성 계정이 없습니다.</p>
          ) : (
            <ul className="identity-map-list">
              {shown.accounts.map((account) => (
                <li key={account.id}>
                  <button
                    type="button"
                    data-testid="identity-map-account"
                    onClick={(event) => dispatch({ type: "select-account", accountId: account.id }, event.currentTarget)}
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
        <section aria-labelledby={`${headingId}-issuer`}>
          <h2 id={`${headingId}-issuer`}>2. 발급처</h2>
          <p>
            {shown.selectedAccount?.serviceName} / {shown.selectedAccount?.accountLabel}
          </p>
          <ul className="identity-map-list">
            {shown.issuers.map((issuer) => (
              <li key={issuer.id}>
                <button
                  type="button"
                  data-testid="identity-map-issuer"
                  onClick={(event) => dispatch({ type: "select-issuer", issuerId: issuer.id }, event.currentTarget)}
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
        <section aria-labelledby={`${headingId}-usage`}>
          <h2 id={`${headingId}-usage`}>3. 사용처</h2>
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
