import { useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import fixture from "../../../../../tests/fixtures/synthetic/signup-mail-discovery-v1.json";
import { DiscoveryInboxReview } from "../discovery-inbox/DiscoveryInboxReview";
import type { DiscoveryFilter, DiscoveryInboxAction } from "../discovery-inbox/discoveryInboxModel";
import { projectSignupMailReview, transitionSignupMailReview } from "./signupMailReview";
import {
  MailDiscoveryError, SYNTHETIC_MAIL_SERVICES, SyntheticSignupMailDiscoverySession, type SignupMailView,
} from "./signupMailDiscovery";
import "./signup-mail-discovery.css";

function errorMessage(error: unknown): string {
  if (error instanceof MailDiscoveryError && error.code === "SESSION_EXPIRED") return "확인 시간이 만료되었습니다. 범위를 다시 선택해 주세요.";
  return "탐색을 진행할 수 없습니다. 범위를 다시 선택해 주세요.";
}
function displayTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Seoul", timeZoneName: "short",
  }).format(new Date(timestamp));
}

/** Fixture-only demonstration. No live mailbox, persistence, or shared vault mount. */
export function SyntheticSignupMailDiscoveryPanel() {
  const headingId = useId();
  const sessionRef = useRef<SyntheticSignupMailDiscoverySession | null>(null);
  const scopeHeading = useRef<HTMLLegendElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const transientContent = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const pendingFocus = useRef<"scope" | "preview" | "results" | "status" | null>(null);
  const [serviceIds, setServiceIds] = useState(SYNTHETIC_MAIL_SERVICES.map((service) => service.id));
  const [days, setDays] = useState<7 | 30>(30);
  const [view, setView] = useState<SignupMailView | null>(null);
  const [reviewFilter, setReviewFilter] = useState<DiscoveryFilter>("open");
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState(() => Symbol("mail-panel"));
  const committedScope = useRef<symbol | null>(null);
  const displayed = useRef<SignupMailView | null>(null);
  const capturedSession = sessionRef.current;
  // Never publish a new owner from a render that React may abandon.
  useLayoutEffect(() => {
    committedScope.current = scope;
    displayed.current = view;
    return () => { if (committedScope.current === scope) committedScope.current = null; };
  }, [scope, view]);
  const isCurrent = () => committedScope.current === scope && sessionRef.current === capturedSession;
  const invalidateCallbacks = () => {
    committedScope.current = null;
    setScope(Symbol("mail-panel"));
  };

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const element = target === "scope" ? scopeHeading.current
      : target === "preview" ? previewHeading.current : target === "results" ? resultsHeading.current : status.current;
    (element ?? status.current)?.focus();
  }, [view, message]);

  useLayoutEffect(() => {
    let active = true;
    const clearForNavigation = () => {
      if (!active) return;
      sessionRef.current?.dispose();
      sessionRef.current = null;
      committedScope.current = null;
      pendingFocus.current = null;
      // Native pagehide can freeze the document without React unmount. Commit
      // the empty view before that snapshot; persisted pageshow is a second fence.
      flushSync(() => {
        setScope(Symbol("mail-panel"));
        setView(null);
        setReviewFilter("open");
        setMessage("");
      });
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) clearForNavigation();
    };
    window.addEventListener("pagehide", clearForNavigation);
    window.addEventListener("pageshow", onPageShow);
    const timer = window.setInterval(() => {
      const session = sessionRef.current;
      if (!active || !session) return;
      const next = session.view();
      if (sessionRef.current !== session) return;
      if (next.phase !== "review" && displayed.current?.phase === next.phase) return;
      if (next.phase === "expired") {
        if (transientContent.current?.contains(document.activeElement)) pendingFocus.current = "status";
        committedScope.current = null;
        setScope(Symbol("mail-panel"));
        setReviewFilter("open");
      }
      setView(next);
    }, 1_000);
    return () => {
      active = false;
      window.removeEventListener("pagehide", clearForNavigation);
      window.removeEventListener("pageshow", onPageShow);
      window.clearInterval(timer);
      committedScope.current = null;
      sessionRef.current?.dispose();
      sessionRef.current = null;
      pendingFocus.current = null;
    };
  }, []);

  function reset() {
    if (!isCurrent()) return;
    pendingFocus.current = "scope";
    capturedSession?.dispose();
    sessionRef.current = null;
    invalidateCallbacks();
    setView(null);
    setReviewFilter("open");
    setMessage("");
  }

  function prepare() {
    if (!isCurrent() || capturedSession !== null || view !== null) return;
    try {
      const startedAt = performance.now();
      const session = new SyntheticSignupMailDiscoverySession({
        ...fixture.request, serviceIds, from: fixture.now - days * 24 * 60 * 60 * 1_000,
      }, () => fixture.now + Math.floor(performance.now() - startedAt));
      sessionRef.current = session;
      invalidateCallbacks();
      pendingFocus.current = "preview";
      setView(session.view());
      setReviewFilter("open");
      setMessage("");
    } catch (error) {
      pendingFocus.current = "status";
      setMessage(errorMessage(error));
    }
  }

  function confirmAndScan() {
    if (!isCurrent() || !capturedSession || !view) return;
    invalidateCallbacks();
    try {
      capturedSession.approve(view.preview, true);
      pendingFocus.current = "results";
      setView(capturedSession.scan(structuredClone(fixture.metadata)));
      setMessage("");
    } catch (error) {
      pendingFocus.current = "status";
      setView(capturedSession.view());
      setMessage(errorMessage(error));
    }
  }

  function cancel() {
    if (!isCurrent() || !capturedSession) return;
    capturedSession.cancel();
    invalidateCallbacks();
    pendingFocus.current = "status";
    setView(capturedSession.view());
    setReviewFilter("open");
    setMessage("");
  }

  function review(action: DiscoveryInboxAction) {
    if (!isCurrent() || !capturedSession) return;
    // Consume the committed action frame before changing classifications or
    // filters. Retained same-session callbacks must not replay an older view.
    invalidateCallbacks();
    try {
      const next = transitionSignupMailReview(capturedSession, reviewFilter, action);
      if (next.view.phase !== "review") {
        pendingFocus.current = "status";
      }
      setView(next.view);
      setReviewFilter(next.inbox.filter);
      setMessage("");
    } catch (error) {
      pendingFocus.current = "status";
      setView(capturedSession.view());
      setMessage(errorMessage(error));
    }
  }

  return (
    <section className="signup-mail-panel" aria-labelledby={headingId}>
      <p className="signup-mail-eyebrow">KEYATLAS · 합성 메일 예제</p>
      <h1 id={headingId}>가입 흔적을 확인할 범위부터 선택하세요</h1>
      <p><strong>실제 비밀번호·API 키 입력 금지.</strong> 실제 Gmail·메일 계정에 연결하지 않는 합성 체험 화면입니다.</p>
      <p>메일의 가입 환영·인증 문구로 서비스 후보를 찾습니다. 후보는 실제 가입 여부를 직접 확인한 뒤 정정할 수 있습니다.</p>
      <p className="signup-mail-privacy">본문은 입력받지 않습니다. 제목과 발신 정보는 결과에 남기지 않고, 후보는 화면을 닫거나 5분이 지나면 화면에서 제거됩니다. ‘확인됨’은 검토 표시이며 실제 가입·계정 소유를 인증하지 않습니다.</p>
      <a href="/">합성 체험 목록으로</a>

      <fieldset disabled={view !== null}>
        <legend ref={scopeHeading} tabIndex={-1}>확인할 합성 서비스</legend>
        <div className="signup-mail-services">
          {SYNTHETIC_MAIL_SERVICES.map((service) => (
            <label key={service.id}>
              <input type="checkbox" checked={serviceIds.includes(service.id)} onChange={(event) => {
                if (!isCurrent() || capturedSession !== null) return;
                const checked = event.target.checked;
                invalidateCallbacks();
                setServiceIds((current) => checked ? [...current, service.id] : current.filter((id) => id !== service.id));
              }} />
              {service.name}
            </label>
          ))}
        </div>
        <label className="signup-mail-period">예제 메일의 기간
          <select value={days} onChange={(event) => {
            if (!isCurrent() || capturedSession !== null) return;
            const selected = event.target.value;
            if (selected !== "7" && selected !== "30") return;
            invalidateCallbacks();
            setDays(selected === "7" ? 7 : 30);
          }}>
            <option value={7}>예제 기준일 이전 7일</option>
            <option value={30}>예제 기준일 이전 30일</option>
          </select>
        </label>
      </fieldset>

      {view === null && <button className="signup-mail-primary" type="button" onClick={prepare} disabled={serviceIds.length === 0}>탐색 범위 미리보기</button>}

      {view?.phase === "awaiting_consent" && (
        <div ref={transientContent} className="signup-mail-card">
          <h2 ref={previewHeading} tabIndex={-1}>이 범위로 탐색할까요?</h2>
          <dl>
            <dt>서비스</dt><dd>{view.preview.serviceIds.map((id) => SYNTHETIC_MAIL_SERVICES.find((service) => service.id === id)?.name).join(", ")}</dd>
            <dt>기간 (한국시간)</dt><dd>{displayTime(view.preview.from)}부터 {displayTime(view.preview.to)} 직전까지</dd>
            <dt>조회 한도</dt><dd>메일 메타데이터 최대 {view.preview.maxHeaders}건</dd>
            <dt>접근 범위</dt><dd>발신 도메인·제목·수신 날짜 · 합성 예제는 OAuth 권한 없음</dd>
            <dt>결과</dt><dd>서비스 이름·가입 문구 종류·날짜만 이 화면에서 검토</dd>
          </dl>
          <div className="signup-mail-actions">
            <button className="signup-mail-primary" type="button" onClick={confirmAndScan}>선택한 범위에 동의하고 탐색</button>
            <button type="button" onClick={cancel}>탐색 취소</button>
          </div>
        </div>
      )}

      {view?.phase === "review" && (
        <div ref={transientContent}>
          <h2 ref={resultsHeading} tabIndex={-1}>검토할 서비스 후보</h2>
          <p role="status">메타데이터 {view.inspectedHeaders}건에서 후보 {view.hints.length}개를 찾았습니다.</p>
          {view.hints.length === 0 && <p>선택한 서비스와 기간에서 가입 문구를 찾지 못했습니다. 가입 이력이 없다는 뜻은 아닙니다.</p>}
          <p>방금 탐색한 후보만 검토합니다. 분류·필터 변경은 5분 제한을 연장하지 않으며, 새로고침·페이지 이탈·취소 시 후보와 분류가 지워집니다.</p>
          <DiscoveryInboxReview
            view={projectSignupMailReview(view, reviewFilter)}
            onAction={review}
            focusScope={capturedSession!}
          />
          <button type="button" onClick={cancel}>후보 지우기</button>
        </div>
      )}

      {view?.phase === "expired" && <p ref={status} tabIndex={-1} role="status">확인 시간이 만료되어 후보를 지웠습니다. 범위를 다시 선택해 주세요.</p>}
      {view?.phase === "cancelled" && <p ref={status} tabIndex={-1} role="status">탐색을 취소하고 후보를 지웠습니다.</p>}
      {message && <p ref={status} tabIndex={-1} role="alert">{message}</p>}
      {view !== null && <button type="button" onClick={reset}>범위 다시 선택</button>}
    </section>
  );
}
