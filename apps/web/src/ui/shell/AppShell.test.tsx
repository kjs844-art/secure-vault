import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { colorCssVariables, staticCssVariables } from "../tokens/tokens";
import { AppShell, appShellWideMinWidthPx, type AppShellProps } from "./AppShell";

function render(props: AppShellProps): string {
  return renderToStaticMarkup(createElement(AppShell, props));
}

function count(html: string, pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

describe("AppShell", () => {
  it("renders the minimal frame with one header and one main landmark", () => {
    expect(render({ brand: "KeyAtlas", children: "본문" })).toBe(
      '<div class="ka-shell">' +
        '<header class="ka-shell__header"><div class="ka-shell__brand">KeyAtlas</div></header>' +
        '<div class="ka-shell__body">' +
        '<main id="main-content" class="ka-shell__main" tabindex="-1">본문</main>' +
        "</div></div>",
    );
  });

  it("renders every slot in document order", () => {
    const html = render({
      brand: "KeyAtlas",
      headerEnd: createElement("button", { type: "button" }, "잠그기"),
      notice: "합성 데이터 전용",
      nav: createElement("a", { href: "#items" }, "항목"),
      navLabel: "주요 메뉴",
      footer: "합성 데모",
      children: "본문",
    });
    expect(html).toBe(
      '<div class="ka-shell ka-shell--with-nav">' +
        '<header class="ka-shell__header"><div class="ka-shell__brand">KeyAtlas</div>' +
        '<div class="ka-shell__header-end"><button type="button">잠그기</button></div></header>' +
        '<div class="ka-shell__notice">합성 데이터 전용</div>' +
        '<div class="ka-shell__body">' +
        '<nav class="ka-shell__nav" aria-label="주요 메뉴"><a href="#items">항목</a></nav>' +
        '<main id="main-content" class="ka-shell__main" tabindex="-1">본문</main></div>' +
        '<footer class="ka-shell__footer">합성 데모</footer></div>',
    );
    expect(count(html, /<header/g)).toBe(1);
    expect(count(html, /<main/g)).toBe(1);
    expect(count(html, /<nav/g)).toBe(1);
    expect(count(html, /<footer/g)).toBe(1);
  });

  it("requires an accessible name for the navigation", () => {
    for (const navLabel of [undefined, "", "   "]) {
      const props = { brand: "KeyAtlas", nav: "메뉴", children: "본문" };
      expect(() =>
        render(navLabel === undefined ? props : { ...props, navLabel }),
      ).toThrow("Navigation needs an accessible label.");
    }
  });

  it("accepts a custom main id and rejects ids that break skip links", () => {
    expect(render({ brand: "K", mainId: "vault_main-1", children: "본문" })).toContain(
      'id="vault_main-1"',
    );
    for (const mainId of ["", "1main", "has space", "a#b", "main\"x"]) {
      expect(() => render({ brand: "K", mainId, children: "본문" }), mainId).toThrow(
        "Main landmark id must be a simple HTML id.",
      );
    }
  });

  it("escapes caller text", () => {
    const html = render({ brand: "<script>alert(1)</script>", children: "본문" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps one main when an existing route supplies the landmark", () => {
    const html = render({ brand: "KeyAtlas", contentContainsMain: true,
      children: createElement("main", null, "기존 화면") });
    expect(count(html, /<main/g)).toBe(1);
    expect(html).not.toMatch(/<main[^>]*>.*<main/);
    expect(html).toContain('<div id="main-content" class="ka-shell__main" tabindex="-1"><main>');
  });
});

describe("shell.css", () => {
  const css = readFileSync(new URL("./shell.css", import.meta.url), "utf8");
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

  it("uses exactly one breakpoint, matching the exported constant", () => {
    const queries = [...css.matchAll(/@media[^{]*/g)].map((m) => m[0].trim());
    expect(queries).toEqual([`@media (min-width: ${appShellWideMinWidthPx}px)`]);
  });

  it("keeps long content from widening the page", () => {
    expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.ka-shell__nav,\s*\.ka-shell__main \{\s*min-width: 0;/);
    expect(css).toMatch(/\.ka-shell__brand \{[^}]*overflow-wrap: anywhere;/);
  });

  it("shows a keyboard focus ring on the main landmark", () => {
    expect(css).toMatch(
      /\.ka-shell__main:focus-visible \{\s*outline: 2px solid var\(--ka-color-focus-ring\);/,
    );
  });
});
