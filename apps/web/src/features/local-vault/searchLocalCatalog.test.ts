import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import { LocalCatalogResults, LocalCatalogSearch } from "./LocalCatalogSearch";
import { MAX_LOCAL_QUERY_LENGTH, searchLocalCatalog, type ConnectionFilter } from "./searchLocalCatalog";

function item(reference: number, overrides: Partial<LocalCatalogEntryV1> = {}): LocalCatalogEntryV1 {
  return Object.freeze({ reference, itemName: "DEMO Workbench", providerName: "Example Workshop",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo",
    credentialType: "api_key", status: "active", connectionCount: 0, secretFieldCount: 1,
    mcpConnectionCount: 0, connections: Object.freeze([]), ...overrides });
}
const records = Object.freeze([
  item(9, { itemName: "DEMO 개인 비밀번호", providerName: "Example Mail", credentialType: "password" }),
  item(2, { connectionCount: 1, mcpConnectionCount: 1, connections: Object.freeze([
    Object.freeze({ label: "DEMO Local MCP", consumerType: "mcp_server" as const }),
  ]) }),
  item(7, { providerName: "Example Café", status: "rotation_due", connectionCount: 1, connections: Object.freeze([
    Object.freeze({ label: "DEMO Build runner", consumerType: "ci_cd" as const }),
  ]) }),
]);
const refs = (query: string, filter: ConnectionFilter = "all") => searchLocalCatalog(records, query, filter).map((row) => row.reference);

describe("local catalog allowlisted search", () => {
  it.each(["issuerAccountIdentifier", "issuerOrganizationOrWorkspace", "issuerProject", "issuerEnvironment"] as const)(
    "searches explicitly reviewed private field %s locally", (field) => {
      const row = item(42, { [field]: "개인 ＬＡＢ Kontext" });
      expect(searchLocalCatalog([row], "개인 lab kontext")).toEqual([row]);
      expect(searchLocalCatalog([row], "different-private-value")).toEqual([]);
    },
  );

  it("does not make null or empty issuer fields into searchable placeholder strings", () => {
    const row = item(43, { issuerAccountIdentifier: null, issuerOrganizationOrWorkspace: null,
      issuerProject: "", issuerEnvironment: "" });
    for (const query of ["null", "undefined", "기록 없음", "빈 값으로 기록됨"]) {
      expect(searchLocalCatalog([row], query)).toEqual([]);
    }
  });
  it.each(["", "   ", "\t\n\u00a0"])("empty query returns all entries in snapshot order (%s)", (query) => {
    expect(refs(query)).toEqual([9, 2, 7]);
  });
  it.each([
    ["mail", [9]], ["개인", [9]], ["비밀번호", [9]], ["password", [9]],
    ["local mcp", [2]], ["빌드", []], ["runner", [7]], ["CI/CD", [7]],
    ["교체 필요", [7]], ["rotation_due", [7]], ["workshop mcp", [2]],
  ] as const)("matches explicit fields for %s", (query, expected) => { expect(refs(query)).toEqual(expected); });
  it("normalizes case, fullwidth Latin, decomposed accents and whitespace", () => {
    expect(refs("ＥＸＡＭＰＬＥ　ＭＡＩＬ")).toEqual([9]);
    expect(refs("CAFE\u0301")).toEqual([7]);
    expect(refs("  WORKSHOP\nMCP ")).toEqual([2]);
  });
  it("treats punctuation as literal text, not a regex", () => {
    expect(refs(".*")).toEqual([]);
    expect(refs("[")).toEqual([]);
  });
  it.each([
    ["connected", [2, 7]], ["unconnected", [9]], ["mcp", [2]],
  ] as const)("applies %s connection classification", (filter, expected) => {
    expect(refs("", filter)).toEqual(expected);
  });
  it("combines classification with all query terms", () => {
    expect(refs("runner", "mcp")).toEqual([]);
    expect(refs("mail", "unconnected")).toEqual([9]);
  });
  it("rejects overlong input instead of silently truncating it", () => {
    const boundary = "x".repeat(MAX_LOCAL_QUERY_LENGTH);
    const row = item(1, { itemName: boundary });
    expect(searchLocalCatalog([row], boundary)).toEqual([row]);
    expect(searchLocalCatalog([row], boundary + "y")).toEqual([]);
    expect(refs(" ".repeat(MAX_LOCAL_QUERY_LENGTH + 1))).toEqual([]);
  });
  it("fails closed for an unknown classification", () => {
    expect(refs("", "invalid" as ConnectionFilter)).toEqual([]);
  });
  it("never reads extra secret, note, identifier or serialization properties", () => {
    const row = { ...records[0]! };
    for (const name of ["secret", "notes", "recordId", "toJSON"]) {
      Object.defineProperty(row, name, { enumerable: true, get() { throw new Error("UNREVIEWED_FIELD_READ"); } });
    }
    expect(searchLocalCatalog([row], "mail")).toEqual([row]);
    expect(searchLocalCatalog([row], "UNREVIEWED_FIELD_READ")).toEqual([]);
  });
  it("does not renumber or mutate frozen snapshot entries", () => {
    const result = searchLocalCatalog(records, "runner");
    expect(result[0]).toBe(records[2]);
    expect(result[0]?.reference).toBe(7);
    expect(records.map((row) => row.reference)).toEqual([9, 2, 7]);
  });
  it("handles an empty catalog", () => { expect(searchLocalCatalog([], "mcp")).toEqual([]); });
});

describe("local catalog rendering", () => {
  it("shows four issuer labels and distinguishes absent metadata from an explicitly empty value", () => {
    const html = renderToStaticMarkup(createElement(LocalCatalogResults, { entries: [item(42, {
      issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
      issuerProject: "", issuerEnvironment: "demo",
    })] }));
    for (const label of ["발급 계정", "조직 · 워크스페이스", "프로젝트", "환경", "demo-account", "기록 없음", "빈 값으로 기록됨"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("undefined");
  });

  it.each(["issuerAccountIdentifier", "issuerOrganizationOrWorkspace", "issuerProject", "issuerEnvironment"] as const)(
    "renders private issuer %s as escaped text, never markup or links", (field) => {
      const html = renderToStaticMarkup(createElement(LocalCatalogResults, { entries: [item(42, {
        [field]: '<a href="https://example.invalid">PRIVATE_DEMO</a>',
      })] }));
      expect(html).toContain("&lt;a href="); expect(html).not.toContain("<a ");
      expect(html).toContain("PRIVATE_DEMO&lt;/a&gt;");
    },
  );
  it("renders labels, bounded search input and no form action or external links", () => {
    const html = renderToStaticMarkup(createElement(LocalCatalogSearch, { entries: records }));
    expect(html).toContain('for="local-catalog-query"');
    expect(html).toContain('maxLength="256"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('href=');
  });
  it("renders actual credential types instead of labeling every item as API key", () => {
    const html = renderToStaticMarkup(createElement(LocalCatalogResults, { entries: [records[0]!] }));
    expect(html).toContain("비밀번호 · 사용 중");
    expect(html).not.toContain("API 키 ·");
  });
  it("escapes labels as text instead of rendering markup", () => {
    const html = renderToStaticMarkup(createElement(LocalCatalogResults, { entries: [item(3, {
      itemName: "<b>DEMO item</b>", providerName: "<i>DEMO provider</i>",
      connectionCount: 1, connections: [{ label: "<em>DEMO connection</em>", consumerType: "app" }],
    })] }));
    expect(html).toContain("&lt;b&gt;DEMO item&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;DEMO provider&lt;/i&gt;");
    expect(html).toContain("&lt;em&gt;DEMO connection&lt;/em&gt;");
    expect(html).not.toContain("<b>");
  });
  it("renders an explicit empty result without a stale list", () => {
    const html = renderToStaticMarkup(createElement(LocalCatalogResults, { entries: [] }));
    expect(html).toContain("일치하는 항목이 없습니다");
    expect(html).not.toContain("<ol");
  });
});
