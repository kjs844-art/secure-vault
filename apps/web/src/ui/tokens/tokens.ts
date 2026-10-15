/**
 * KeyAtlas design tokens.
 *
 * This file is the single source of truth. `tokens.css` mirrors it as CSS
 * custom properties and `tokens.test.ts` fails when the two drift apart.
 * Only local system fonts are listed; no remote font is ever loaded.
 */

export const colorSchemes = ["light", "dark"] as const;
export type ColorScheme = (typeof colorSchemes)[number];

export const uiTones = ["neutral", "info", "success", "warning", "danger"] as const;
export type UiTone = (typeof uiTones)[number];

export interface ColorTokens {
  readonly canvas: string;
  readonly surface: string;
  readonly surfaceSunken: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  readonly accentText: string;
  readonly focusRing: string;
  readonly neutralBg: string;
  readonly neutralText: string;
  readonly infoBg: string;
  readonly infoText: string;
  readonly successBg: string;
  readonly successText: string;
  readonly warningBg: string;
  readonly warningText: string;
  readonly dangerBg: string;
  readonly dangerText: string;
}

export const designTokens = Object.freeze({
  color: Object.freeze({
    light: Object.freeze({
      canvas: "#f4f6f8",
      surface: "#ffffff",
      surfaceSunken: "#eef2f5",
      border: "#dce2e8",
      borderStrong: "#768593",
      text: "#17202a",
      textMuted: "#496273",
      accent: "#1d5fa8",
      accentText: "#ffffff",
      focusRing: "#1d5fa8",
      neutralBg: "#eef2f5",
      neutralText: "#33434f",
      infoBg: "#e3eefb",
      infoText: "#174f8c",
      successBg: "#e2f4e8",
      successText: "#1c5f35",
      warningBg: "#fdf0d8",
      warningText: "#7a4a00",
      dangerBg: "#fbe4e4",
      dangerText: "#9b1c1c",
    } satisfies ColorTokens),
    dark: Object.freeze({
      canvas: "#0f151b",
      surface: "#17202a",
      surfaceSunken: "#121a22",
      border: "#2c3945",
      borderStrong: "#5c6d7b",
      text: "#e8edf1",
      textMuted: "#a5b4c0",
      accent: "#7fb2ee",
      accentText: "#0f151b",
      focusRing: "#7fb2ee",
      neutralBg: "#24303b",
      neutralText: "#d3dce3",
      infoBg: "#15304d",
      infoText: "#a9cdf5",
      successBg: "#143322",
      successText: "#9ad8ae",
      warningBg: "#3a2a0c",
      warningText: "#f2c879",
      dangerBg: "#3f1717",
      dangerText: "#f3a9a9",
    } satisfies ColorTokens),
  }),
  space: Object.freeze({
    xs: "4px",
    sm: "8px",
    md: "12px",
    lg: "16px",
    xl: "24px",
    xxl: "40px",
  }),
  radius: Object.freeze({
    sm: "6px",
    md: "12px",
    lg: "16px",
    pill: "999px",
  }),
  font: Object.freeze({
    family:
      'Inter, Pretendard, "Noto Sans KR", system-ui, -apple-system, sans-serif',
    familyMono:
      'ui-monospace, "SFMono-Regular", Menlo, Consolas, "D2Coding", monospace',
    sizeSm: "0.875rem",
    sizeMd: "1rem",
    sizeLg: "1.25rem",
    sizeXl: "1.75rem",
    weightRegular: "400",
    weightStrong: "700",
    lineHeight: "1.6",
  }),
});

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Scheme-independent custom properties (spacing, radius, typography).
 */
export function staticCssVariables(): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const [group, values] of Object.entries({
    space: designTokens.space,
    radius: designTokens.radius,
    font: designTokens.font,
  })) {
    for (const [name, value] of Object.entries(values)) {
      entries.set(`--ka-${group}-${kebab(name)}`, value);
    }
  }
  return entries;
}

/**
 * Color custom properties for one color scheme.
 */
export function colorCssVariables(
  scheme: ColorScheme,
): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const [name, value] of Object.entries(designTokens.color[scheme])) {
    entries.set(`--ka-color-${kebab(name)}`, value);
  }
  return entries;
}
