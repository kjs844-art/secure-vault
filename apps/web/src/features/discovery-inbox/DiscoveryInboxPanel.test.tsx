import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiscoveryInboxPanel } from "./DiscoveryInboxPanel";

describe("DiscoveryInboxPanel initial rendering", () => {
  it("renders the closed synthetic inbox on the open filter", () => {
    const html = renderToStaticMarkup(<DiscoveryInboxPanel />);
    expect(html).toContain("가입 흔적을 확인됨 · 추정 · 확인 필요로 나누기");
    expect(html).toContain("REAL_SECRET_GATE=CLOSED");
    expect(html).toContain("열린 항목 4건");
    expect(html).toContain("Example AI Workshop");
    expect(html).toContain("Example Shop Newsletter");
    expect(html).toContain("확인됨");
    expect(html).toContain("추정");
    expect(html).toContain("확인 필요");
    expect(html.match(/data-testid="discovery-inbox-item"/g)).toHaveLength(4);
    expect(html).not.toMatch(/type="(password|text|email)"/);
    expect(html).not.toContain("sk-");
    expect(html).not.toContain("AKIA");
  });

  it("renders an empty open inbox when no rows are usable", () => {
    const html = renderToStaticMarkup(<DiscoveryInboxPanel items={[]} />);
    expect(html).toContain("이 필터에 표시할 합성 흔적이 없습니다.");
    expect(html).not.toContain("data-testid=\"discovery-inbox-item\"");
  });

  it("escapes service labels", () => {
    const html = renderToStaticMarkup(<DiscoveryInboxPanel items={[{
      id: "xss",
      serviceName: "<em>DEMO provider</em>",
      accountHint: "<script>alert(1)</script>",
      confidence: "needs_review",
      sourceKind: "manual",
      sourceLabel: "manual",
      observedOn: "2026-09-30",
      note: "demo",
    }]} />);
    expect(html).toContain("&lt;em&gt;DEMO provider&lt;/em&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.includes("<em>")).toBe(false);
    expect(html.includes("<script>")).toBe(false);
  });
});
