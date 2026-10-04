import { useEffect, type CSSProperties, type ReactNode } from "react";
import { colorCssVariables, staticCssVariables } from "../tokens/tokens";
import { AppShell } from "./AppShell";
import "./shell.css";
import "./synthetic-shell.css";

export const SYNTHETIC_VIEWS = [
  { id: "overview", href: "/", label: "합성 목록" },
  { id: "local-vault", href: "/?view=local-vault", label: "로컬 합성 금고" },
  { id: "synthetic-backup", href: "/?view=synthetic-backup", label: "합성 백업·복원" },
  { id: "identity-map", href: "/?view=identity-map", label: "계정·연결 관계" },
  { id: "discovery-inbox", href: "/?view=discovery-inbox", label: "가입 흔적 검토" },
  { id: "signup-mail-discovery", href: "/?view=signup-mail-discovery", label: "합성 메일 탐색" },
] as const;

export type SyntheticView = (typeof SYNTHETIC_VIEWS)[number]["id"];

/** Keep the existing first-query-value behavior and a closed route allowlist. */
export function readSyntheticView(search: string): SyntheticView {
  const value = new URLSearchParams(search).get("view");
  return SYNTHETIC_VIEWS.find((view) => view.id === value)?.id ?? "overview";
}

const lightTokens = Object.fromEntries([
  ...staticCssVariables(), ...colorCssVariables("light"),
]) as CSSProperties;

/** Full document links retain each panel's existing pagehide cleanup. */
export function SyntheticAppShell({ view, children }: {
  readonly view: SyntheticView;
  readonly children: ReactNode;
}) {
  const label = SYNTHETIC_VIEWS.find((item) => item.id === view)?.label ?? "합성 목록";
  useEffect(() => {
    const previous = document.title;
    document.title = `${label} | KeyAtlas 합성 체험`;
    return () => { document.title = previous; };
  }, [label]);

  return <div className="synthetic-app-shell" style={lightTokens}>
    <a className="synthetic-skip-link" href="#main-content">본문으로 바로가기</a>
    <AppShell
      brand={<a href="/">KeyAtlas 합성 체험</a>}
      navLabel="합성 체험 화면"
      nav={<ul className="synthetic-view-links">
        {SYNTHETIC_VIEWS.map((item) => <li key={item.id}>
          <a href={item.href} aria-current={item.id === view ? "page" : undefined}>{item.label}</a>
        </li>)}
      </ul>}
      footer="실제 Gmail·계정 인증·클라우드 저장은 연결하지 않습니다."
      contentContainsMain
    >{children}</AppShell>
  </div>;
}
