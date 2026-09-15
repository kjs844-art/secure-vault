import { useEffect, useRef, useState } from "react";
import GlassKey from "./landing/GlassKey";

/** 화면에 들어오면 .in 을 붙인다 — 글이 스크롤에 맞춰 떠오르도록 */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { el.classList.add("in"); io.disconnect(); } },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

export default function App() {
  // 0 = 맨 위, 1 = 첫 화면을 다 넘김. 씬이 이 값을 읽어 열쇠를 밀어 올린다.
  const scroll = useRef(0);
  const [ready, setReady] = useState(false);
  const chapter = useReveal<HTMLDivElement>();

  useEffect(() => {
    const onScroll = () => {
      scroll.current = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.9)));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    const t = window.setTimeout(() => setReady(true), 200);
    return () => { window.removeEventListener("scroll", onScroll); window.clearTimeout(t); };
  }, []);

  return (
    <div className={`page${ready ? " is-ready" : ""}`}>
      <div className="gl"><GlassKey scroll={scroll} /></div>
      <div className="grain" />

      <p className="alpha">v0alpha1 · 합성 데이터 전용 · 실제 비밀번호나 API 키를 넣지 마세요</p>

      <header className="bar">
        <span className="mark">KEYATLAS</span>
        <nav className="bar-nav">
          <a href="#map">연결 지도</a>
          <a href="#vault">금고</a>
          <a href="#security">보안 설계</a>
        </nav>
        <a className="btn btn-ghost btn-sm" href="#start">시작하기</a>
      </header>

      {/* 첫 화면: 열쇠뿐. 글은 스크롤 뒤에 온다. */}
      <section className="opener" aria-label="KeyAtlas">
        <div className="cue" aria-hidden="true">
          <span className="cue-line" />
          <span>SCROLL</span>
        </div>
      </section>

      <section className="chapter" id="map">
        <div className="chapter-inner" ref={chapter}>
          <p className="eyebrow">ZERO-KNOWLEDGE · KEY RELATIONSHIP VAULT</p>
          <h1>어디서 발급했고,<br />어디에 꽂았는지.</h1>
          <p className="lede">
            API 키 하나가 Cursor에도, 로컬 MCP 서버에도, Vercel 프로젝트에도 꽂혀 있습니다.
            회전하는 순간 세 곳을 전부 갱신해야 합니다. 이 금고는 그 지도를 기억합니다 —
            서버는 읽지 못하는 형태로.
          </p>
          <div className="actions">
            <a className="btn btn-solid" href="#start">연결 지도 시작하기</a>
            <a className="btn btn-ghost" href="#security">보안 설계 읽기</a>
          </div>
        </div>
      </section>
    </div>
  );
}
