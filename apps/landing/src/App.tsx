import { useEffect, useRef, useState } from "react";
import Scene from "./landing/Scene";

/** 첫 화면(1) + 이야기 네 장(4)을 넘기는 동안 s가 0→1. 챕터가 보일 때쯤 자물쇠가 잠긴다. */
const RUNWAY = 4.6;

/** 화면에 들어오면 .in 을 붙인다 */
function useReveal<T extends HTMLElement>(threshold = 0.35) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.classList.add("in"); io.disconnect(); } }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return ref;
}

/** 스크롤 s가 어느 장면에 있는지. 0은 자막 없음. */
function beatOf(s: number) {
  if (s >= 0.10 && s < 0.40) return 1;
  if (s >= 0.40 && s < 0.55) return 2;
  if (s >= 0.55 && s < 0.84) return 3;
  if (s >= 0.84 && s < 0.98) return 4;
  return 0;
}

const CAPTIONS: [React.ReactNode, string][] = [
  [<>열쇠는 <b>당신에게만</b> 있습니다.</>, "01 · KEY"],
  [<>돌리는 순간 —</>, "02 · TURN"],
  [<>흩어져 있던 계정, 키, 연결이 <b>한 곳으로</b> 모입니다.</>, "03 · GATHER"],
  [<>그리고 잠깁니다. <b>운영자도 열 수 없습니다.</b></>, "04 · LOCK"],
];

export default function App() {
  const scroll = useRef(0);
  const page = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [beat, setBeat] = useState(0);
  const chapter = useReveal<HTMLDivElement>();

  useEffect(() => {
    const onScroll = () => {
      const s = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * RUNWAY)));
      scroll.current = s;
      setBeat(beatOf(s));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const t = window.setTimeout(() => setReady(true), 200);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); window.clearTimeout(t); };
  }, []);

  return (
    <div className={`page${ready ? " is-ready" : ""}`} ref={page}>
      <div className="gl"><Scene scroll={scroll} eventSource={page} /></div>
      <div className="grain" />

      {/* 배너와 바를 한 기둥에 쌓는다. 따로 fixed로 두면 좁은 화면에서 배너가
          두 줄로 접히며 로고를 덮는다. */}
      <div className="top">
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
      </div>

      {/* 첫 화면: 열쇠뿐. */}
      <section className="opener" aria-label="KeyAtlas">
        <div className="cue" aria-hidden="true"><span className="cue-line" /><span>SCROLL</span></div>
      </section>

      {/* 이야기: 꽂고, 돌리고, 모이고, 잠긴다. 자막은 한 장에 한 줄. */}
      <section className="story" aria-label="어떻게 잠기는가">
        <div className="slot" /><div className="slot" /><div className="slot" /><div className="slot" />
      </section>
      <div className="captions" aria-live="polite">
        {CAPTIONS.map(([text, tag], i) => (
          <p key={tag} className={`caption${beat === i + 1 ? " on" : ""}`}>{text}<small>{tag}</small></p>
        ))}
      </div>

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
