import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  colorCssVariables,
  colorSchemes,
  designTokens,
  staticCssVariables,
} from "./tokens";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function blockBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing CSS block ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/(--ka-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    expect(found.has(name), `duplicate ${name}`).toBe(false);
    found.set(name, value.trim());
  }
  return found;
}

const lightRoot = declarations(blockBody(":root"));
const darkMedia = declarations(blockBody(':root:not([data-theme="light"])'));
const darkExplicit = declarations(blockBody(':root[data-theme="dark"]'));

describe("design tokens", () => {
  it("mirrors every static and light token in the :root block and nothing else", () => {
    const expected = new Map([
      ...staticCssVariables(),
      ...colorCssVariables("light"),
    ]);
    expect(lightRoot).toEqual(expected);
  });

  it("mirrors dark tokens in both the media query and the explicit theme block", () => {
    const expected = new Map(colorCssVariables("dark"));
    expect(darkMedia).toEqual(expected);
    expect(darkExplicit).toEqual(expected);
  });

  it("defines the same color roles for every scheme", () => {
    const [first, ...rest] = colorSchemes.map((scheme) =>
      Object.keys(designTokens.color[scheme]).sort(),
    );
    for (const keys of rest) expect(keys).toEqual(first);
  });

  it("uses opaque six-digit hex colors only", () => {
    for (const scheme of colorSchemes) {
      for (const value of Object.values(designTokens.color[scheme])) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("never references remote resources", () => {
    expect(css).not.toMatch(/url\(|@import|https?:/i);
  });

  it("is frozen so callers cannot mutate shared tokens", () => {
    expect(Object.isFrozen(designTokens)).toBe(true);
    expect(Object.isFrozen(designTokens.color.light)).toBe(true);
    expect(Object.isFrozen(designTokens.space)).toBe(true);
  });
});
