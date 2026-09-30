import { useEffect, useId, useRef, useState } from "react";
import fixture from "../../../../../tests/fixtures/synthetic/signup-mail-discovery-v1.json";
import {
  MailDiscoveryError,
  SYNTHETIC_MAIL_SERVICES,
  SyntheticSignupMailDiscoverySession,
  type SignupMailSignal,
  type SignupMailView,
} from "./signupMailDiscovery";
import "./signup-mail-discovery.css";

const SIGNAL_LABELS: Readonly<Record<SignupMailSignal, string>> = {
  welcome: "가입 환영 문구",
  registration: "가입 완료 문구",
  email_verification: "이메일 인증 문구",
};
const CONFIDENCE_LABELS = {
  needs_review: "확인 필요",
  confirmed: "직접 확인함",
  dismissed: "오탐",
} as const;

function errorMessage(error: unknown): string {
  if (error instanceof MailDiscoveryError && error.code === "SESSION_EXPIRED") return "확인 시간이 만료되었습니다. 범위를 다시 선택해 주세요.";
  return "탐색을 진행할 수 없습니다. 범위를 다시 선택해 주세요.";
}

function displayTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
  }).format(new Date(timestamp));
}

/** Standalone fixture-only demonstration; no live mailbox or shared vault mount. */
export function SyntheticSignupMailDiscoveryPanel() {
  const headingId = useId();
  const sessionRef = useRef<SyntheticSignupMailDiscoverySession | null>(null);
  const [serviceIds, setServiceIds] = useState(SYNTHETIC_MAIL_SERVICES.map((service) => service.id));
  const [days, setDays] = useState<7 | 30>(30);
  const [view, setView] = useState<SignupMailView | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (sessionRef.current) setView(sessionRef.current.view());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  function reset() {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setView(null);
    setMessage("");
  }

  function prepare() {
    reset();
    try {
      const startedAt = performance.now();
      const session = new SyntheticSignupMailDiscoverySession({
        ...fixture.request,
        serviceIds,
        from: fixture.now - days * 24 * 60 * 60 * 1_000,
      }, () => fixture.now + Math.floor(performance.now() - startedAt));
      sessionRef.current = session;
      setView(session.view());
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function confirmAndScan() {
    const session = sessionRef.current;
    if (!session || !view) return;
    try {
      session.approve(view.preview, true);
      setView(session.scan(structuredClone(fixture.metadata)));
      setMessage("");
    } catch (error) {
      setView(session.view());
      setMessage(errorMessage(error));
    }
  }

  function cancel() {
    sessionRef.current?.cancel();
    if (sessionRef.current) setView(sessionRef.current.view());
    setMessage("");
  }

  function mark(serviceId: string, confidence: "confirmed" | "dismissed" | "needs_review") {
    if (!sessionRef.current) return;
    try {
      setView(sessionRef.current.setConfidence(serviceId, confidence));
      setMessage("");
    } catch (error) {
      setView(sessionRef.current.view());
      setMessage(errorMessage(error));
    }
  }

  return (
    <section className="signup-mail-panel" aria-labelledby={headingId}>
      <p className="signup-mail-eyebrow">KEYATLAS · 합성 메일 예제</p>
      <h1 id={headingId}>가입 흔적을 확인할 범위부터 선택하세요</h1>
      <p>메일의 가입 환영·인증 문구로 서비스 후보를 찾습니다. 후보는 실제 가입 여부를 직접 확인한 뒤 정정할 수 있습니다.</p>
      <p className="signup-mail-privacy">본문은 입력받지 않습니다. 제목과 발신 정보는 결과에 남기지 않고, 후보는 화면을 닫거나 5분이 지나면 지워집니다.</p>

      <fieldset disabled={view !== null}>
        <legend>확인할 합성 서비스</legend>
        <div className="signup-mail-services">
          {SYNTHETIC_MAIL_SERVICES.map((service) => (
            <label key={service.id}>
              <input type="checkbox" checked={serviceIds.includes(service.id)} onChange={(event) => {
                setServiceIds((current) => event.target.checked ? [...current, service.id] : current.filter((id) => id !== service.id));
              }} />
              {service.name}
            </label>
          ))}
        </div>
        <label className="signup-mail-period">예제 메일의 기간
          <select value={days} onChange={(event) => setDays(Number(event.target.value) as 7 | 30)}>
            <option value={7}>예제 기준일 이전 7일</option>
            <option value={30}>예제 기준일 이전 30일</option>
          </select>
        </label>
      </fieldset>

      {view === null && <button className="signup-mail-primary" type="button" onClick={prepare} disabled={serviceIds.length === 0}>탐색 범위 미리보기</button>}

      {view?.phase === "awaiting_consent" && (
        <div className="signup-mail-card">
          <h2>이 범위로 탐색할까요?</h2>
          <dl>
            <dt>서비스</dt><dd>{view.preview.serviceIds.map((id) => SYNTHETIC_MAIL_SERVICES.find((service) => service.id === id)?.name).join(", ")}</dd>
            <dt>기간</dt><dd>{displayTime(view.preview.from)}부터 {displayTime(view.preview.to)} 직전까지</dd>
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
        <div>
          <h2>검토할 서비스 후보</h2>
          <p role="status">메타데이터 {view.inspectedHeaders}건에서 후보 {view.hints.length}개를 찾았습니다.</p>
          {view.hints.length === 0 && <p>선택한 서비스와 기간에서 가입 문구를 찾지 못했습니다. 가입 이력이 없다는 뜻은 아닙니다.</p>}
          <ul className="signup-mail-results">
            {view.hints.map((hint) => (
              <li className="signup-mail-card" key={hint.serviceId}>
                <h3>{hint.serviceName} <span className="signup-mail-confidence">{CONFIDENCE_LABELS[hint.confidence]}</span></h3>
                <p>{hint.signals.map((signal) => SIGNAL_LABELS[signal]).join(" · ")} · {hint.observedOn} (UTC 날짜)</p>
                <div className="signup-mail-actions">
                  <button type="button" disabled={hint.confidence === "confirmed"} onClick={() => mark(hint.serviceId, "confirmed")}>확인됨으로 표시</button>
                  <button type="button" disabled={hint.confidence === "dismissed"} onClick={() => mark(hint.serviceId, "dismissed")}>오탐으로 표시</button>
                  {hint.confidence !== "needs_review" && <button type="button" onClick={() => mark(hint.serviceId, "needs_review")}>다시 검토</button>}
                </div>
              </li>
            ))}
          </ul>
          <button type="button" onClick={cancel}>후보 지우기</button>
        </div>
      )}

      {view?.phase === "expired" && <p role="status">확인 시간이 만료되어 후보를 지웠습니다. 범위를 다시 선택해 주세요.</p>}
      {view?.phase === "cancelled" && <p role="status">탐색을 취소하고 후보를 지웠습니다.</p>}
      {message && <p role="alert">{message}</p>}
      {view !== null && <button type="button" onClick={reset}>범위 다시 선택</button>}
    </section>
  );
}
