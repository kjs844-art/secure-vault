import { useEffect, useRef } from "react";
import VaultField from "./landing/VaultField";

/** 포인터를 CSS 변수로 흘려보낸다. 감쇠를 걸어 카드가 손끝을 늦게 따라오게. */
function useParallax<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let frame = 0;

    const onMove = (e: PointerEvent) => {
      target.x = (e.clientX / window.innerWidth - 0.5) * 2;
      target.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };

    const tick = () => {
      current.x += (target.x - current.x) * 0.055;
      current.y += (target.y - current.y) * 0.055;
      ref.current?.style.setProperty("--px", current.x.toFixed(4));
      ref.current?.style.setProperty("--py", current.y.toFixed(4));
      frame = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return ref;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** 모두 합성 값이다. 실제 계정이나 자격증명이 아니다. */
const HUBS = [
  {
    mark: "G", title: "Google", count: 14,
    color: "#b9c0cc", bg: "rgba(185,192,204,0.1)",
    slot: { top: 0, left: 16, "--delay": "0s" },
    depth: { "--z": "60px", "--tilt": "-2deg", "--d": 1.15 },
    rows: [["Supabase", "2024-03"], ["Notion", "2023-11"], ["Figma", "2023-08"], ["Vercel", "2022-09"]],
    foot: "10곳 더 · 6곳은 1년 넘게 미사용",
  },
  {
    mark: "K", title: "카카오", count: 11,
    color: "#f0b429", bg: "rgba(240,180,41,0.1)",
    slot: { top: 46, left: 342, "--delay": "-3s" },
    depth: { "--z": "-40px", "--tilt": "1.6deg", "--d": 0.78 },
    rows: [["배달의민족", "2021-05"], ["무신사", "2020-11"], ["야놀자", "2019-07"]],
    foot: "가장 오래된 연결은 7년 전입니다",
  },
  {
    mark: "N", title: "네이버", count: 9,
    color: "#5fc48b", bg: "rgba(95,196,139,0.1)",
    slot: { top: 300, left: 0, "--delay": "-6s" },
    depth: { "--z": "10px", "--tilt": "2.2deg", "--d": 0.95 },
    rows: [["쿠팡", "2022-01"], ["네이버페이", "2021-09"]],
    foot: "7곳 더 · 결제 수단이 연결된 곳 2곳",
  },
] as const;

export default function App() {
  const field = useParallax<HTMLDivElement>();

  return (
    <div className="stage">
      <div className="webgl"><VaultField /></div>
      <div className="scrim" />
      <div className="grain" />

      <div className="layer">
        <div className="alpha-bar">
          <svg width="16" height="16" viewBox="0 0 20 20" {...stroke} style={{ flexShrink: 0 }}>
            <path d="M10 3.2 2.6 16.2h14.8L10 3.2Z" /><path d="M10 8v3.4" /><path d="M10 13.8h.01" />
          </svg>
          <b>v0alpha1 · 실험</b>
          <span>합성 데이터 전용입니다. 실제 비밀번호 · API 키 · 복구 키 · MCP 토큰을 입력하지 마세요.</span>
        </div>

        <nav className="nav">
          <div className="wordmark">
            <div className="wordmark-badge">
              <svg width="17" height="17" viewBox="0 0 20 20" {...stroke}>
                <path d="M10 2.5 4 5v4.5c0 3.5 2.4 6.6 6 8 3.6-1.4 6-4.5 6-8V5l-6-2.5Z" />
              </svg>
            </div>
            <span className="wordmark-text">SECURE VAULT</span>
          </div>
          <div className="nav-links">
            <span>연결 지도</span><span>금고</span><span>보안 설계</span><span>가격</span>
          </div>
          <div className="nav-right">
            <button className="pill">로그인</button>
            <button className="pill pill-solid">무료로 시작</button>
          </div>
        </nav>

        <main className="hero">
          <div>
            <div className="eyebrow"><i />IDENTITY &amp; SECRETS · ZERO-KNOWLEDGE</div>
            <h1>당신은 지금 몇 개의 사이트에 가입되어 있습니까?</h1>
            <p>
              구글 · 카카오 · 네이버로 로그인한 곳, 이메일로 가입한 곳, 발급받고 잊어버린 API 키.
              흩어진 것들을 한 장의 지도로 모읍니다. 그리고 <b>서버는 그중 아무것도 읽지 못합니다.</b>
            </p>
            <div className="cta-row">
              <button className="pill pill-solid pill-lg">
                내 연결 지도 만들기
                <svg width="18" height="18" viewBox="0 0 20 20" {...stroke} strokeWidth={1.9}>
                  <path d="m7.5 4 6 6-6 6" />
                </svg>
              </button>
              <button className="pill pill-lg">보안 설계 문서</button>
            </div>
            <div className="trust">
              <span>클라이언트 암호화</span><i>·</i>
              <span>서버는 암호문만 보관</span><i>·</i>
              <span>오픈소스</span>
            </div>
          </div>

          <div className="card-field" ref={field}>
            {HUBS.map((hub) => (
              <div key={hub.title} className="card-slot" style={hub.slot as React.CSSProperties}>
                <article className="card" style={hub.depth as React.CSSProperties}>
                  <div className="card-head">
                    <div className="card-mark" style={{ color: hub.color, background: hub.bg }}>{hub.mark}</div>
                    <div className="card-title">{hub.title}</div>
                    <div className="card-count" style={{ color: hub.color }}>{hub.count}</div>
                  </div>
                  <ul>
                    {hub.rows.map(([name, when]) => (
                      <li key={name}><em>{name}</em><span>{when}</span></li>
                    ))}
                  </ul>
                  <div className="card-foot">{hub.foot}</div>
                </article>
              </div>
            ))}

            <div className="card-slot" style={{ top: 326, left: 330, "--delay": "-4.5s" } as React.CSSProperties}>
            <article className="card" style={{ "--z": "124px", "--tilt": "-1.4deg", "--d": 1.5 } as React.CSSProperties}>
              <div className="card-head">
                <div className="card-mark" style={{ color: "#5fb3d4", background: "rgba(95,179,212,0.1)" }}>
                  <svg width="17" height="17" viewBox="0 0 20 20" {...stroke}>
                    <circle cx="6.5" cy="13.5" r="3" /><path d="M8.7 11.3 16 4m-2.2 2.2 2 2m-3.5.5 2 2" />
                  </svg>
                </div>
                <div className="card-title">API 키</div>
                <div className="card-count" style={{ color: "#5fb3d4" }}>8</div>
              </div>
              <div style={{ padding: "4px 0 10px" }}>
                <div className="mono" style={{ fontSize: 10.5, letterSpacing: 1.3, color: "var(--ink-3)", marginBottom: 8 }}>
                  OPENAI_API_KEY
                </div>
                <div style={{ fontSize: 13.5 }}>
                  <span className="redact">DEMO_VALUE_ONLY_0001</span>
                </div>
              </div>
              <div className="card-foot">2개는 회전 기한을 넘겼습니다 · 값은 이 기기에서만 복호화됩니다</div>
            </article>
            </div>
          </div>
        </main>

        <div className="legend">
          <div className="legend-item">
            <span className="dot" style={{ background: "var(--amber)", boxShadow: "0 0 10px rgba(240,180,41,0.6)" }} />
            기억하고 관리 중
          </div>
          <div className="legend-item">
            <span className="dot" style={{ background: "#8a7338" }} />
            연결돼 있지만 방치됨
          </div>
          <div className="legend-item">
            <span className="dot" style={{ border: "1.4px solid #4a5263" }} />
            존재조차 잊어버린 것
          </div>
        </div>

        <div className="scroll-hint">
          <svg width="16" height="16" viewBox="0 0 20 20" {...stroke}>
            <path d="M10 4v12m0 0 4.5-4.5M10 16l-4.5-4.5" />
          </svg>
          SCROLL
        </div>
      </div>
    </div>
  );
}
