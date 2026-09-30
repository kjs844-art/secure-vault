import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyntheticSignupMailDiscoveryPanel } from "./SyntheticSignupMailDiscoveryPanel";

describe("synthetic signup-mail panel initial boundary", () => {
  it("renders a labeled scope selector before offering confirmation or any results", () => {
    const html = renderToStaticMarkup(<SyntheticSignupMailDiscoveryPanel />);
    expect(html).toContain("합성 메일 예제");
    expect(html).toContain("확인할 합성 서비스");
    expect(html).toContain("예제 메일의 기간");
    expect(html).toContain("탐색 범위 미리보기");
    expect(html.match(/type="checkbox"/gu)).toHaveLength(3);
    expect(html).not.toContain("선택한 범위에 동의하고 탐색");
    expect(html).not.toContain("검토할 서비스 후보");
  });

  it("does not embed fixture subjects, sender domains, input fields or provider login links", () => {
    const html = renderToStaticMarkup(<SyntheticSignupMailDiscoveryPanel />);
    for (const forbidden of ["synthetic-only-private-canary", "accounts.aurora.invalid", "Welcome to Aurora", 'type="file"', 'type="password"', 'type="email"', "accounts.google.com", "login.microsoftonline.com"]) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).toContain("본문은 입력받지 않습니다");
    expect(html).toContain("5분");
  });
});
