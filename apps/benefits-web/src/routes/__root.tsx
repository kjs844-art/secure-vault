// Adapted shell only; donor auth, telemetry, live MCP and remote fonts are excluded.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "KeyAtlas — 독립 이식 개발 환경" },
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: Shell,
  component: Root,
  notFoundComponent: () => <main><h1>페이지를 찾을 수 없습니다</h1><a href="/">처음으로</a></main>,
  errorComponent: () => <main><h1>화면을 불러오지 못했습니다</h1><a href="/">처음으로</a></main>,
});

function Shell({ children }: { children: ReactNode }) {
  return <html lang="ko"><head><HeadContent /></head><body>{children}<Scripts /></body></html>;
}

function Root() {
  const { queryClient } = Route.useRouteContext();
  return <QueryClientProvider client={queryClient}><Outlet /></QueryClientProvider>;
}
