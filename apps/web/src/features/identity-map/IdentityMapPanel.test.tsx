import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdentityMapPanel } from "./IdentityMapPanel";

describe("IdentityMapPanel initial rendering", () => {
  it("renders the account step for the closed synthetic fixture", () => {
    const html = renderToStaticMarkup(<IdentityMapPanel />);
    expect(html).toContain("계정 · 발급처 · 사용처를 세 단계로 보기");
    expect(html).toContain("REAL_SECRET_GATE=CLOSED");
    expect(html).toContain("data-testid=\"identity-map-status\"");
    expect(html).toContain("계정 3곳");
    expect(html).toContain("Example AI Workshop");
    expect(html).toContain("demo-workshop-owner");
    expect(html).toContain("기록 없음");
    expect(html.match(/data-testid="identity-map-account"/g)).toHaveLength(3);
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
    expect(html).toContain("<em>DEMO provider</em>");
    expect(html).toContain("<script>alert(1)</script>");
    expect(html.includes("<em>")).toBe(false);
    expect(html.includes("<script>")).toBe(false);
  });
});
