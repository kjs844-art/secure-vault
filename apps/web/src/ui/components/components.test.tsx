import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  colorCssVariables,
  staticCssVariables,
  uiTones,
  type UiTone,
} from "../tokens/tokens";
import { KeyValueList } from "./KeyValueList";
import { StatusBadge } from "./StatusBadge";
import { Surface, type SurfaceElement } from "./Surface";
import { SyntheticDataNotice } from "./SyntheticDataNotice";

describe("StatusBadge", () => {
  it.each(uiTones)("renders the %s tone as a text label", (tone) => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { tone, children: "예시 상태" }),
    );
    expect(html).toBe(`<span class="ka-badge ka-badge--${tone}">예시 상태</span>`);
  });

  it("defaults to the neutral tone", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { children: "기록 없음" }));
    expect(html).toContain("ka-badge--neutral");
  });

  it("rejects tones outside the token set", () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(StatusBadge, { tone: "critical" as UiTone, children: "x" }),
      ),
    ).toThrow("Unknown status badge tone.");
  });

  it("escapes caller text instead of injecting markup", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { children: "<img src=x onerror=alert(1)>" }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("SyntheticDataNotice", () => {
  it("renders a note landmark with title and body", () => {
    const html = renderToStaticMarkup(
      createElement(SyntheticDataNotice, {
        title: "합성 데이터 전용",
        children: "실제 키를 입력하지 마세요.",
      }),
    );
    expect(html).toBe(
      '<aside class="ka-notice ka-notice--warning" role="note">' +
        '<strong class="ka-notice__title">합성 데이터 전용</strong>' +
        '<div class="ka-notice__body">실제 키를 입력하지 마세요.</div></aside>',
    );
  });

  it("omits the body wrapper when there is no body", () => {
    const html = renderToStaticMarkup(
      createElement(SyntheticDataNotice, { title: "합성 데이터 전용" }),
    );
    expect(html).not.toContain("ka-notice__body");
  });
});

describe("Surface", () => {
  it("renders a plain div by default", () => {
    const html = renderToStaticMarkup(createElement(Surface, { children: "내용" }));
    expect(html).toBe('<div class="ka-surface">내용</div>');
  });

  it("labels section landmarks with a heading id", () => {
    const html = renderToStaticMarkup(
      createElement(Surface, { as: "section", labelledBy: "demo-heading", children: "내용" }),
    );
    expect(html).toBe(
      '<section class="ka-surface" aria-labelledby="demo-heading">내용</section>',
    );
  });

  it("refuses unlabelled landmarks", () => {
    expect(() =>
      renderToStaticMarkup(createElement(Surface, { as: "article", children: "내용" })),
    ).toThrow("Landmark surfaces need a labelling heading id.");
  });

  it("refuses arbitrary elements", () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Surface, { as: "script" as SurfaceElement, labelledBy: "x", children: "" }),
      ),
    ).toThrow("Unsupported surface element.");
  });
});

describe("KeyValueList", () => {
  it("renders term and value pairs in order", () => {
    const html = renderToStaticMarkup(
      createElement(KeyValueList, {
        entries: [
          { id: "env", term: "환경", value: "개발" },
          { id: "kind", term: "종류", value: "API 키" },
        ],
      }),
    );
    expect(html).toBe(
      '<dl class="ka-kv">' +
        '<div class="ka-kv__row"><dt class="ka-kv__term">환경</dt><dd class="ka-kv__value">개발</dd></div>' +
        '<div class="ka-kv__row"><dt class="ka-kv__term">종류</dt><dd class="ka-kv__value">API 키</dd></div>' +
        "</dl>",
    );
  });

  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(createElement(KeyValueList, { entries: [] }))).toBe("");
  });

  it("rejects duplicate entry ids", () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(KeyValueList, {
          entries: [
            { id: "a", term: "1", value: "1" },
            { id: "a", term: "2", value: "2" },
          ],
        }),
      ),
    ).toThrow("Key/value entry ids must be unique.");
  });
});

describe("components.css", () => {
  const css = readFileSync(new URL("./components.css", import.meta.url), "utf8");
  const known = new Set([
    ...staticCssVariables().keys(),
    ...colorCssVariables("light").keys(),
  ]);

  it("only references defined design tokens", () => {
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(known.has(name ?? ""), name).toBe(true);
  });

  it("has no hard-coded colors or remote resources", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).not.toMatch(/url\(|@import|https?:/i);
  });

  it("styles every tone", () => {
    for (const tone of uiTones) expect(css).toContain(`.ka-badge--${tone} {`);
  });
});
