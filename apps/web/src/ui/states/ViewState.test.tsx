import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getCopy, locales } from "../copy/copyCatalog";
import { colorCssVariables, staticCssVariables } from "../tokens/tokens";
import {
  isSafeReferenceCode,
  ViewState,
  viewStateKinds,
  viewStateText,
  type ViewStateKind,
  type ViewStateTitleElement,
} from "./ViewState";

function render(props: Parameters<typeof ViewState>[0]): string {
  return renderToStaticMarkup(createElement(ViewState, props));
}

describe("ViewState", () => {
  it.each([
    ["loading", ' role="status"'],
    ["offline", ' role="status"'],
    ["error", ' role="alert"'],
    ["empty", ""],
  ] as const)("renders the %s state with the expected live role", (kind, role) => {
    expect(render({ kind, title: "제목" })).toBe(
      `<div class="ka-state ka-state--${kind}"${role}>` +
        '<span class="ka-state__indicator" aria-hidden="true"></span>' +
        '<h2 class="ka-state__title">제목</h2></div>',
    );
  });

  it("never marks itself busy, which would silence the status announcement", () => {
    for (const kind of viewStateKinds) {
      expect(render({ kind, title: "제목" })).not.toContain("aria-busy");
    }
  });

  it("renders description, detail and action in order when given", () => {
    const html = render({
      kind: "error",
      title: "제목",
      description: "설명",
      detail: "참조 코드 ABC-1",
      action: createElement("button", { type: "button" }, "다시 시도"),
    });
    expect(html).toBe(
      '<div class="ka-state ka-state--error" role="alert">' +
        '<span class="ka-state__indicator" aria-hidden="true"></span>' +
        '<h2 class="ka-state__title">제목</h2>' +
        '<p class="ka-state__description">설명</p>' +
        '<p class="ka-state__detail">참조 코드 ABC-1</p>' +
        '<div class="ka-state__action"><button type="button">다시 시도</button></div></div>',
    );
  });

  it.each(["h3", "h4", "p"] as const)("can render the title as %s", (titleAs) => {
    expect(render({ kind: "empty", title: "제목", titleAs })).toContain(
      `<${titleAs} class="ka-state__title">제목</${titleAs}>`,
    );
  });

  it("rejects unknown kinds and title elements", () => {
    expect(() => render({ kind: "success" as ViewStateKind, title: "x" })).toThrow(
      "Unknown view state kind.",
    );
    expect(() =>
      render({ kind: "empty", title: "x", titleAs: "h1" as ViewStateTitleElement }),
    ).toThrow("Unsupported view state title element.");
  });

  it("escapes caller text", () => {
    const html = render({ kind: "error", title: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("viewStateText", () => {
  it.each(locales)("uses the %s catalog wording for every kind", (locale) => {
    const text = getCopy(locale).viewState;
    expect(viewStateText(getCopy(locale), "loading")).toEqual({ title: text.loadingTitle });
    expect(viewStateText(getCopy(locale), "empty")).toEqual({
      title: text.emptyTitle,
      description: text.emptyBody,
    });
    expect(viewStateText(getCopy(locale), "offline")).toEqual({
      title: text.offlineTitle,
      description: text.offlineBody,
    });
    expect(viewStateText(getCopy(locale), "error")).toEqual({
      title: text.errorTitle,
      description: text.errorBody,
    });
  });

  it("adds a formatted reference only for safe error codes", () => {
    expect(viewStateText(getCopy("ko"), "error", "SYNC_TIMEOUT-7").detail).toBe(
      "참조 코드 SYNC_TIMEOUT-7",
    );
    expect(viewStateText(getCopy("en"), "error", "E42").detail).toBe("Reference code E42");
  });

  it("drops unsafe reference codes instead of showing them", () => {
    for (const code of [
      "",
      "-leading",
      "has space",
      "<script>",
      "TypeError: cannot read vault",
      "코드",
      "A".repeat(65),
    ]) {
      expect(viewStateText(getCopy("ko"), "error", code), code).toEqual({
        title: getCopy("ko").viewState.errorTitle,
        description: getCopy("ko").viewState.errorBody,
      });
    }
  });

  it("ignores reference codes for non-error kinds", () => {
    expect(viewStateText(getCopy("ko"), "offline", "E42")).not.toHaveProperty("detail");
  });

  it("rejects unknown kinds", () => {
    expect(() => viewStateText(getCopy("ko"), "success" as ViewStateKind)).toThrow(
      "Unknown view state kind.",
    );
  });
});

describe("isSafeReferenceCode", () => {
  it.each([
    ["E1", true],
    ["SYNC_TIMEOUT-7", true],
    ["a".repeat(64), true],
    ["a".repeat(65), false],
    ["_leading", false],
    ["with.dot", false],
    ["line\nbreak", false],
  ] as const)("classifies %j as %s", (code, expected) => {
    expect(isSafeReferenceCode(code)).toBe(expected);
  });
});

describe("states.css", () => {
  const css = readFileSync(new URL("./states.css", import.meta.url), "utf8");
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

  it("only animates inside the no-preference reduced-motion query", () => {
    const motionQuery = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    const keyframes = css.indexOf("@keyframes");
    expect(motionQuery).toBeGreaterThan(0);
    const animations = [...css.matchAll(/animation\s*:/g)].map((m) => m.index ?? -1);
    expect(animations.length).toBeGreaterThan(0);
    for (const index of animations) {
      expect(index).toBeGreaterThan(motionQuery);
      expect(index).toBeLessThan(keyframes);
    }
  });

  it("styles every kind", () => {
    for (const kind of viewStateKinds) expect(css).toContain(`.ka-state--${kind}`);
  });
});
