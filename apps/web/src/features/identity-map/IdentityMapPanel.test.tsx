import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdentityMapPanel } from "./IdentityMapPanel";

describe("IdentityMapPanel initial rendering", () => {
  it("renders the account step for the closed synthetic fixture", () => {
    const html = renderToStaticMarkup(<IdentityMapPanel />);
    expect(html).toContain("계정 · 발급처 · 사용처를 세 단계로 보기");
    expect(html).toContain("실제 비밀번호·API 키 입력 금지.");
    expect(html).toContain("합성 데이터로 화면을 체험합니다.");
    expect(html).toContain("아직 연결되지 않았습니다.");
    expect(html).toContain("data-testid=\"identity-map-status\"");
    expect(html).toContain("계정 3곳");
    expect(html).toContain("Example AI Workshop");
    expect(html).toContain("demo-workshop-owner");
    expect(html).toContain("기록 없음");
    expect(html.match(/data-testid="identity-map-account"/g)).toHaveLength(3);
    expect(html).toContain("data-testid=\"identity-map-step-account\"");
    expect(html).toContain("disabled");
    expect(html).not.toContain("data-testid=\"identity-map-issuer\"");
    expect(html).not.toContain("data-testid=\"identity-map-usages\"");
    expect(html).not.toMatch(/type="(password|text|email)"/);
    expect(html).not.toContain("sk-");
    expect(html).not.toContain("AKIA");
  });

  it("escapes service and account labels", () => {
    const html = renderToStaticMarkup(<IdentityMapPanel entries={[{
      reference: 0,
      providerName: "<em>DEMO provider</em>",
      itemName: "<b>DEMO item</b>",
      issuerAccountIdentifier: "<script>alert(1)</script>",
      issuerOrganizationOrWorkspace: null,
      issuerProject: null,
      issuerEnvironment: null,
      credentialType: "api_key",
      status: "active",
      secretFieldCount: 1,
      connectionCount: 0,
      mcpConnectionCount: 0,
      connections: [],
    }]} />);
    expect(html).toContain("&lt;em&gt;DEMO provider&lt;/em&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.includes("<em>")).toBe(false);
    expect(html.includes("<script>")).toBe(false);
  });

  it("renders an empty state when no catalog rows are usable", () => {
    const html = renderToStaticMarkup(<IdentityMapPanel entries={[]} />);
    expect(html).toContain("표시할 합성 계정이 없습니다.");
    expect(html).not.toContain("data-testid=\"identity-map-account\"");
  });

  it("keeps embedded step headings below the enclosing section heading", () => {
    const html = renderToStaticMarkup(<IdentityMapPanel embedded />);
    expect(html).toMatch(/<section[^>]*aria-labelledby="identity-map-title"/);
    expect(html).toContain('<h2 id="identity-map-title">');
    expect(html).toContain('<h3 id="identity-account-heading"');
    expect(html).not.toContain("<h1");
  });
});
