import { describe, expect, it } from "vitest";

import { secretKinds } from "../../domain/vault";
import {
  defaultLocale,
  formatCopy,
  getCopy,
  locales,
  placeholdersOf,
  resolveLocale,
} from "./copyCatalog";
import { findForbiddenClaims, forbiddenClaims } from "./forbiddenClaims";

type Leaf = readonly [path: string, value: string];

function leaves(tree: object, prefix = ""): Leaf[] {
  return Object.entries(tree).flatMap(([key, value]): Leaf[] => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "string" ? [[path, value]] : leaves(value as object, path);
  });
}

const byLocale = Object.fromEntries(
  locales.map((locale) => [locale, new Map(leaves(getCopy(locale)))]),
) as Record<(typeof locales)[number], Map<string, string>>;

describe("copy catalog", () => {
  it("has exactly the same keys in every locale", () => {
    const reference = [...byLocale[defaultLocale].keys()].sort();
    expect(reference.length).toBeGreaterThan(40);
    for (const locale of locales) {
      expect([...byLocale[locale].keys()].sort(), locale).toEqual(reference);
    }
  });

  it("has no empty, padded or untranslated-looking strings", () => {
    for (const locale of locales) {
      for (const [path, value] of byLocale[locale]) {
        expect(value.trim(), `${locale}:${path}`).toBe(value);
        expect(value.length, `${locale}:${path}`).toBeGreaterThan(0);
        expect(value, `${locale}:${path}`).not.toMatch(/TODO|FIXME|\[\s*[A-Z_]+\s*\]/);
      }
    }
  });

  it("keeps Korean copy in Korean and English copy free of Hangul", () => {
    for (const [path, value] of byLocale.ko) {
      if (path.startsWith("concept.keyatlas")) continue;
      expect(value, `ko:${path}`).toMatch(/[가-힣]|^(API|MCP)/);
    }
    for (const [path, value] of byLocale.en) {
      expect(value, `en:${path}`).not.toMatch(/[가-힣]/);
    }
  });

  it("uses the same placeholders in every locale", () => {
    for (const [path, koValue] of byLocale.ko) {
      const expected = placeholdersOf(koValue);
      for (const locale of locales) {
        expect(placeholdersOf(byLocale[locale].get(path) ?? ""), `${locale}:${path}`).toEqual(expected);
      }
    }
  });

  it("contains no forbidden overstatement in any locale", () => {
    for (const locale of locales) {
      for (const [path, value] of byLocale[locale]) {
        expect(findForbiddenClaims(value).map((c) => c.phrase), `${locale}:${path}`).toEqual([]);
      }
    }
  });

  it("labels every secret kind the domain defines", () => {
    // Environment, status and privilege labels are checked at compile time
    // with `satisfies Record<...>`; secret kinds also exist as a runtime list.
    for (const locale of locales) {
      expect(Object.keys(getCopy(locale).secretKind).sort()).toEqual([...secretKinds].sort());
    }
  });

  it("keeps the existing Korean secret kind labels", () => {
    expect(getCopy("ko").secretKind).toEqual({
      password: "비밀번호",
      api_key: "API 키",
      mcp_credential: "MCP 자격 증명",
      recovery_code: "복구 코드",
    });
  });

  it("is deeply frozen", () => {
    const copy = getCopy("en");
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.common)).toBe(true);
    expect(() => {
      (copy.common as { cancel: string }).cancel = "changed";
    }).toThrow(TypeError);
  });
});

describe("resolveLocale", () => {
  it.each([
    ["en", "en"],
    ["en-US", "en"],
    ["EN_gb", "en"],
    ["ko-KR", "ko"],
    ["ja-JP", "ko"],
    ["", "ko"],
    [null, "ko"],
    [undefined, "ko"],
  ] as const)("maps %s to %s", (tag, expected) => {
    expect(resolveLocale(tag)).toBe(expected);
  });
});

describe("formatCopy", () => {
  it("fills placeholders in both locales", () => {
    expect(formatCopy(getCopy("ko").connection.targetCount, { count: 3 })).toBe("연결처 3곳 기록");
    expect(formatCopy(getCopy("en").connection.targetCount, { count: 3 })).toBe(
      "3 connection targets recorded",
    );
  });

  it("returns templates without placeholders unchanged", () => {
    expect(formatCopy(getCopy("ko").common.cancel)).toBe("취소");
  });

  it("throws on missing or unexpected values", () => {
    expect(() => formatCopy("{count}개 항목")).toThrow("Copy placeholders mismatch");
    expect(() => formatCopy("취소", { count: 1 })).toThrow("Copy placeholders mismatch");
    expect(() => formatCopy("{count}개", { total: 1 })).toThrow("Copy placeholders mismatch");
  });
});

describe("findForbiddenClaims", () => {
  it("detects claims regardless of case and spacing", () => {
    expect(findForbiddenClaims("Your vault is UNHACKABLE").map((c) => c.phrase)).toEqual(["unhackable"]);
    expect(findForbiddenClaims("모든  가입 서비스를 찾았습니다").length).toBe(1);
    expect(findForbiddenClaims("Connection   verified today").length).toBe(1);
  });

  it("allows the honest recorded-connection wording", () => {
    expect(findForbiddenClaims("연결 기록 있음")).toEqual([]);
    expect(findForbiddenClaims("Connection recorded")).toEqual([]);
  });

  it("gives every claim a reason", () => {
    for (const claim of forbiddenClaims) expect(claim.reason.length).toBeGreaterThan(0);
  });
});
