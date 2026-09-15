import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SyntheticRegistrationPanel } from "./SyntheticRegistrationPanel";

/** SSR shape only; interaction and lock/reopen are verified in the browser. */
describe("synthetic registration initial UI boundary", () => {
  it("renders only closed choices without reading or writing a vault", () => {
    const register = vi.fn(async () => {});
    const html = renderToStaticMarkup(createElement(SyntheticRegistrationPanel, {
      session: { register }, entryCount: 3,
    }));
    expect(register).not.toHaveBeenCalled();
    expect(html.match(/<option /g)).toHaveLength(2);
    expect(html.match(/<input /g)).toHaveLength(4);
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html).not.toMatch(/<(textarea|iframe)|type="(text|password|file|email)"/);
    expect(html).not.toMatch(/checked=""/);
    expect(html).toContain("연결처 없음");
    expect(html).toContain("가상 데이터만");
    expect(html).toContain("demo-account");
    expect(html).toContain("demo-project");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="registration-submit"/);
    expect(html).not.toContain("DEMO_VALUE_ONLY_API_KEY_0001");
  });
  it.each([128, 129])("explains the closed archive capacity at %i entries", (entryCount) => {
    const html = renderToStaticMarkup(createElement(SyntheticRegistrationPanel, {
      session: { register: async () => {} }, entryCount,
    }));
    expect(html).toContain("128개 항목 한도에 도달");
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain("기존 내용을 덮어쓰지 않습니다");
  });
});
