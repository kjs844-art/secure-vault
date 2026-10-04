import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readSyntheticView, SYNTHETIC_VIEWS, SyntheticAppShell } from "./SyntheticAppShell";

describe("closed synthetic route selection", () => {
  it.each(SYNTHETIC_VIEWS)("selects the existing $id route", ({ id, href }) => {
    expect(readSyntheticView(href.includes("?") ? href.slice(href.indexOf("?")) : "")).toBe(id);
  });

  it.each(["", "?view=", "?view=unknown", "?view=https%3A%2F%2Fexample.invalid", "?other=local-vault"])(
    "keeps unrecognized input on the overview: %s", (search) => {
      expect(readSyntheticView(search)).toBe("overview");
    });

  it("preserves first-value semantics without letting a later value override it", () => {
    expect(readSyntheticView("?view=identity-map&view=local-vault")).toBe("identity-map");
    expect(readSyntheticView("?view=unknown&view=local-vault")).toBe("overview");
  });
});

describe("existing main panels in the shared synthetic frame", () => {
  it.each(SYNTHETIC_VIEWS)("marks only $id current and keeps native document links", ({ id, label }) => {
    const html = renderToStaticMarkup(createElement(SyntheticAppShell, {
      view: id, children: createElement("main", null, "합성 본문"),
    }));
    expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1);
    expect(html).toContain(`aria-current="page">${label}</a>`);
    expect([...html.matchAll(/<main\b/g)]).toHaveLength(1);
    expect(html).toContain('href="#main-content">본문으로 바로가기</a>');
    expect(html).toContain('id="main-content" class="ka-shell__main" tabindex="-1"');
    expect(html).toContain('aria-label="합성 체험 화면"');
    for (const view of SYNTHETIC_VIEWS) expect(html).toContain(`href="${view.href}"`);
    expect(html).not.toMatch(/\bonclick=|target="_blank"|<iframe|<form/);
    expect(html).toContain("실제 Gmail·계정 인증·클라우드 저장은 연결하지 않습니다.");
  });
});
