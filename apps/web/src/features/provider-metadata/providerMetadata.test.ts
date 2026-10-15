import { describe, expect, it } from "vitest";
import {
  findProviderMetadataV1,
  parseCuratedProviderMetadataJsonV1,
  PROVIDER_METADATA_V1,
  PROVIDER_METADATA_JSON_MAX_BYTES_V1,
  validateCuratedProviderMetadataCatalogV1,
  validateProviderMetadataCatalogV1,
  type ProviderMetadataIssueReportV1,
  type ProviderMetadataIssueV1,
  type ProviderMetadataV1,
} from "./providerMetadata";

const VALID: ProviderMetadataV1 = {
  id: "example",
  displayName: "Example",
  category: "cloud",
  officialHosts: ["example.com"],
  credentialTypes: ["api_key"],
  docLinks: [{ kind: "credentials", url: "https://docs.example.com/keys" }],
  linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: "2026-09-24" },
};

// 테스트용으로 신뢰하지 않는 입력을 흉내 내려고 타입을 일부러 우회한다.
function issuesFor(patch: Record<string, unknown>): ProviderMetadataIssueV1[] {
  const entry = { ...VALID, ...patch } as unknown as ProviderMetadataV1;
  return validateProviderMetadataCatalogV1([entry]).map((report) => report.issue);
}

describe("PROVIDER_METADATA_V1", () => {
  it("passes its own validator", () => {
    expect(validateProviderMetadataCatalogV1(PROVIDER_METADATA_V1)).toEqual([]);
    expect(validateCuratedProviderMetadataCatalogV1(PROVIDER_METADATA_V1)).toEqual([]);
  });

  it("is deeply frozen", () => {
    const first = PROVIDER_METADATA_V1[0]!;
    expect(Object.isFrozen(PROVIDER_METADATA_V1)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.officialHosts)).toBe(true);
    expect(Object.isFrozen(first.linkCheck)).toBe(true);
  });

  it("contains no Secret-shaped or private material", () => {
    const serialized = JSON.stringify(PROVIDER_METADATA_V1);
    // 흔한 key prefix 형태가 공개 metadata에 섞이지 않아야 한다.
    for (const pattern of [/\bsk-[A-Za-z0-9]/, /AKIA[0-9A-Z]{8}/, /\bgh[pousr]_[A-Za-z0-9]/, /\bxox[abprs]-/, /[a-z]+:\/\/[^/]*@/]) {
      expect(serialized).not.toMatch(pattern);
    }
  });

  it("marks unreachable documentation as UNKNOWN without links", () => {
    const openai = findProviderMetadataV1("openai");
    expect(openai?.docLinks).toEqual([]);
    expect(openai?.linkCheck).toEqual({ result: "UNKNOWN", scope: "http_reachability", checkedOn: null });
  });

  it("finds entries by exact id only", () => {
    expect(findProviderMetadataV1("github")?.displayName).toBe("GitHub");
    expect(findProviderMetadataV1("GitHub")).toBeUndefined();
    expect(findProviderMetadataV1("")).toBeUndefined();
  });
});

describe("validateCuratedProviderMetadataCatalogV1", () => {
  it("rejects an unreviewed provider even when its structure is valid", () => {
    expect(validateProviderMetadataCatalogV1([VALID])).toEqual([]);
    expect(validateCuratedProviderMetadataCatalogV1([VALID]))
      .toEqual([{ index: 0, issue: "UNTRUSTED_PROVIDER" }]);
  });

  it("rejects a self-consistent forged GitHub host and documentation URL", () => {
    const github = findProviderMetadataV1("github")!;
    const forged = {
      ...github,
      officialHosts: ["attacker.test"],
      docLinks: [{ kind: "credentials", url: "https://attacker.test/keys" }],
    };
    expect(validateProviderMetadataCatalogV1([forged])).toEqual([]);
    expect(validateCuratedProviderMetadataCatalogV1([forged])).toEqual([
      { index: 0, issue: "UNTRUSTED_HOSTS" },
      { index: 0, issue: "DOC_LINK_OFF_HOST" },
      { index: 0, issue: "UNTRUSTED_DOC_LINK" },
      { index: 0, issue: "UNTRUSTED_METADATA" },
    ]);
  });

  it("rejects a user-controlled path on an otherwise pinned official host", () => {
    const github = findProviderMetadataV1("github")!;
    const forged = {
      ...github,
      docLinks: [{ kind: "credentials", url: "https://github.com/attacker/keys" }],
    };
    expect(validateProviderMetadataCatalogV1([forged])).toEqual([]);
    expect(validateCuratedProviderMetadataCatalogV1([forged]))
      .toEqual([
        { index: 0, issue: "UNTRUSTED_DOC_LINK" },
        { index: 0, issue: "UNTRUSTED_METADATA" },
      ]);
  });

  it("rejects an added host even if the documentation still uses the pinned host", () => {
    const github = findProviderMetadataV1("github")!;
    const forged = { ...github, officialHosts: ["github.com", "attacker.test"] };
    expect(validateProviderMetadataCatalogV1([forged])).toEqual([]);
    expect(validateCuratedProviderMetadataCatalogV1([forged]))
      .toEqual([{ index: 0, issue: "UNTRUSTED_HOSTS" }]);
  });

  it("rejects altered provider labels, credential types, and link evidence", () => {
    const github = findProviderMetadataV1("github")!;
    for (const forged of [
      { ...github, displayName: "GitHub Support" },
      { ...github, credentialTypes: ["api_key"] },
      { ...github, docLinks: [{ kind: "api_overview", url: github.docLinks[0]!.url }] },
      { ...github, linkCheck: { result: "UNKNOWN", scope: "http_reachability", checkedOn: null }, docLinks: [] },
    ]) {
      expect(validateProviderMetadataCatalogV1([forged])).toEqual([]);
      expect(validateCuratedProviderMetadataCatalogV1([forged]))
        .toContainEqual({ index: 0, issue: "UNTRUSTED_METADATA" });
    }
  });
});

describe("parseCuratedProviderMetadataJsonV1", () => {
  it("returns frozen code-owned entries after validating a bounded JSON snapshot", () => {
    const parsed = parseCuratedProviderMetadataJsonV1(JSON.stringify(PROVIDER_METADATA_V1));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(PROVIDER_METADATA_V1.length);
    expect(parsed.entries[0]).toBe(PROVIDER_METADATA_V1[0]);
    expect(Object.isFrozen(parsed.entries)).toBe(true);
  });

  it("rejects malformed and over-limit JSON before trusting any entry", () => {
    for (const raw of [null, "{", "x".repeat(PROVIDER_METADATA_JSON_MAX_BYTES_V1 + 1)]) {
      expect(parseCuratedProviderMetadataJsonV1(raw)).toEqual({
        ok: false, issues: [{ index: null, issue: "INVALID_CATALOG" }],
      });
    }
  });

  it("rejects a structurally valid forged provider snapshot", () => {
    const github = findProviderMetadataV1("github")!;
    const raw = JSON.stringify([{ ...github, displayName: "GitHub Support" }]);
    expect(parseCuratedProviderMetadataJsonV1(raw)).toEqual({
      ok: false, issues: [{ index: 0, issue: "UNTRUSTED_METADATA" }],
    });
  });
});

describe("validateProviderMetadataCatalogV1", () => {
  it("accepts a well-formed entry", () => {
    expect(issuesFor({})).toEqual([]);
  });

  it.each([
    ["uppercase id", { id: "Example" }, "INVALID_ID"],
    ["trailing hyphen id", { id: "example-" }, "INVALID_ID"],
    ["overlong id", { id: "x".repeat(65) }, "INVALID_ID"],
    ["empty name", { displayName: "" }, "INVALID_DISPLAY_NAME"],
    ["padded name", { displayName: " Example" }, "INVALID_DISPLAY_NAME"],
    ["long name", { displayName: "x".repeat(65) }, "INVALID_DISPLAY_NAME"],
    ["unknown category", { category: "crypto_exchange" }, "INVALID_CATEGORY"],
    ["no hosts", { officialHosts: [] }, "INVALID_HOSTS"],
    ["host with scheme", { officialHosts: ["https://example.com"] }, "INVALID_HOSTS"],
    ["uppercase host", { officialHosts: ["Example.com"] }, "INVALID_HOSTS"],
    ["overlong hostname", { officialHosts: [`${"a.".repeat(126)}com`] }, "INVALID_HOSTS"],
    ["too many hosts", {
      officialHosts: Array.from({ length: 33 }, (_value, index) => `h${index}.example.com`),
    }, "INVALID_HOSTS"],
    ["duplicate host", { officialHosts: ["example.com", "example.com"] }, "INVALID_HOSTS"],
    ["no credential types", { credentialTypes: [] }, "INVALID_CREDENTIAL_TYPES"],
    ["too many credential types", { credentialTypes: Array.from({ length: 33 }, () => "api_key") }, "INVALID_CREDENTIAL_TYPES"],
    ["overlong credential type", { credentialTypes: ["x".repeat(10_000)] }, "INVALID_CREDENTIAL_TYPES"],
    ["unknown credential type", { credentialTypes: ["session_cookie"] }, "INVALID_CREDENTIAL_TYPES"],
    ["duplicate credential type", { credentialTypes: ["api_key", "api_key"] }, "INVALID_CREDENTIAL_TYPES"],
  ] as const)("rejects %s", (_name, patch, issue) => {
    expect(issuesFor(patch)).toContain(issue);
  });

  it.each([
    ["http", "http://docs.example.com/keys"],
    ["embedded credentials", "https://user:pw@docs.example.com/keys"],
    ["explicit port", "https://docs.example.com:8443/keys"],
    ["query string", "https://docs.example.com/keys?ref=keyatlas"],
    ["fragment", "https://docs.example.com/keys#top"],
    ["non-canonical form", "https://DOCS.example.com/keys"],
    ["not a URL", "docs.example.com/keys"],
  ])("rejects a doc link with %s", (_name, url) => {
    expect(issuesFor({ docLinks: [{ kind: "credentials", url }] })).toContain("INVALID_DOC_LINK");
  });

  it("rejects documentation URLs over the bounded input size", () => {
    const url = `https://example.com/${"x".repeat(4_097)}`;
    expect(issuesFor({ docLinks: [{ kind: "credentials", url }] })).toContain("INVALID_DOC_LINK");
  });

  it("rejects more documentation links than the catalog supports", () => {
    const link = { kind: "credentials", url: "https://example.com/keys" };
    expect(issuesFor({ docLinks: [link, link, link] })).toEqual(["INVALID_DOC_LINK"]);
  });

  it("rejects doc links outside the official hosts, including lookalikes", () => {
    for (const url of ["https://example.org/keys", "https://evilexample.com/keys", "https://example.com.evil.test/keys"]) {
      expect(issuesFor({ docLinks: [{ kind: "credentials", url }] })).toContain("DOC_LINK_OFF_HOST");
    }
  });

  it("rejects unknown link kinds and duplicate kinds", () => {
    expect(issuesFor({ docLinks: [{ kind: "login", url: "https://example.com/a" }] })).toContain("INVALID_DOC_LINK");
    expect(issuesFor({
      docLinks: [
        { kind: "credentials", url: "https://example.com/a" },
        { kind: "credentials", url: "https://example.com/b" },
      ],
    })).toContain("DUPLICATE_DOC_LINK_KIND");
  });

  it.each([
    ["PASS without links", { docLinks: [] }],
    ["PASS without date", { linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: null } }],
    ["impossible date", { linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: "2026-02-30" } }],
    ["oversized date", { linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: "x".repeat(4_097) } }],
    ["UNKNOWN with date", { linkCheck: { result: "UNKNOWN", scope: "http_reachability", checkedOn: "2026-09-24" } }],
    ["unknown result", { linkCheck: { result: "OK", scope: "http_reachability", checkedOn: "2026-09-24" } }],
    ["content scope", { linkCheck: { result: "PASS", scope: "content_review", checkedOn: "2026-09-24" } }],
  ])("rejects a link check with %s", (_name, patch) => {
    expect(issuesFor(patch)).toContain("INVALID_LINK_CHECK");
  });

  it("rejects fields outside the allowlist at every level", () => {
    expect(issuesFor({ apiKeyExample: "placeholder" })).toEqual(["UNEXPECTED_FIELD"]);
    expect(issuesFor({ docLinks: [{ kind: "credentials", url: "https://example.com/a", note: "x" }] }))
      .toContain("INVALID_DOC_LINK");
    expect(issuesFor({ linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: "2026-09-24", by: "x" } }))
      .toContain("INVALID_LINK_CHECK");
  });

  it("requires unique ids in ascending order", () => {
    const b = { ...VALID, id: "b" };
    const a = { ...VALID, id: "a" };
    expect(validateProviderMetadataCatalogV1([a, b])).toEqual([]);
    expect(validateProviderMetadataCatalogV1([b, a])).toEqual([{ index: 1, issue: "UNSORTED_IDS" }]);
    expect(validateProviderMetadataCatalogV1([a, a]).map((r) => r.issue)).toEqual(["DUPLICATE_ID", "UNSORTED_IDS"]);
  });
});

// malformed 입력은 예외 없이 끝나야 하고, 정확한 index·issue 목록을 돌려줘야 한다.
function expectReports(catalog: unknown, expected: readonly ProviderMetadataIssueReportV1[]): void {
  let reports: readonly ProviderMetadataIssueReportV1[] = [];
  expect(() => {
    reports = validateProviderMetadataCatalogV1(catalog);
  }).not.toThrow();
  expect(reports).toEqual(expected);
}

function atZero(...issues: ProviderMetadataIssueV1[]): ProviderMetadataIssueReportV1[] {
  return issues.map((issue) => ({ index: 0, issue }));
}

describe("validateProviderMetadataCatalogV1 with untrusted runtime input", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["a number", 42],
    ["a string", "[]"],
    ["a plain object", { 0: VALID, length: 1 }],
  ])("reports INVALID_CATALOG with a null index for %s", (_name, catalog) => {
    expectReports(catalog, [{ index: null, issue: "INVALID_CATALOG" }]);
  });

  it.each([
    ["null", null],
    ["a boolean", false],
    ["a number", 0],
    ["a string", "example"],
    ["an array", [VALID]],
    ["a Date object", new Date(0)],
  ])("reports INVALID_ENTRY at the exact index for %s", (_name, element) => {
    const first = { ...VALID, id: "a" };
    expectReports([first, element], [{ index: 1, issue: "INVALID_ENTRY" }]);
  });

  it("reports INVALID_ENTRY for holes in a sparse catalog", () => {
    const sparse: unknown[] = [];
    sparse[1] = { ...VALID };
    expectReports(sparse, [{ index: 0, issue: "INVALID_ENTRY" }]);
  });

  it("rejects catalogs above 2,048 entries without walking them", () => {
    expectReports(new Array(2_049), [{ index: null, issue: "INVALID_CATALOG" }]);
  });

  it("accepts the 2,048-entry catalog limit", () => {
    const atLimit = Array.from({ length: 2_048 }, (_value, index) => ({
      ...VALID,
      id: `provider-${String(index).padStart(4, "0")}`,
    }));
    expect(validateProviderMetadataCatalogV1(atLimit)).toEqual([]);
  });

  it("keeps UNEXPECTED_FIELD for plain records with missing or extra fields", () => {
    const { linkCheck: _omitted, ...missing } = VALID;
    expectReports([missing], atZero("UNEXPECTED_FIELD"));
    expectReports([{ ...VALID, apiKeyExample: "placeholder" }], atZero("UNEXPECTED_FIELD"));
    expectReports([{}], atZero("UNEXPECTED_FIELD"));
  });

  it("rejects symbol and non-enumerable fields outside the exact allowlist", () => {
    const symbolEntry = { ...VALID, [Symbol("synthetic-extra")]: "synthetic" };
    const hiddenEntry = { ...VALID } as ProviderMetadataV1 & Record<string, unknown>;
    Object.defineProperty(hiddenEntry, "apiKeyExample", {
      configurable: true,
      enumerable: false,
      value: "synthetic-placeholder",
    });

    expectReports([symbolEntry], atZero("UNEXPECTED_FIELD"));
    expectReports([hiddenEntry], atZero("UNEXPECTED_FIELD"));
  });

  it("rejects a wide JSON object with unapproved fields", () => {
    const wide = { ...VALID } as ProviderMetadataV1 & Record<string, unknown>;
    for (let index = 0; index < 20_000; index += 1) wide[`extra${index}`] = index;
    expectReports([wide], atZero("UNEXPECTED_FIELD"));
  });

  it("rejects symbol fields on nested exact-key records", () => {
    const docLink = {
      kind: "credentials",
      url: "https://docs.example.com/keys",
      [Symbol("synthetic-extra")]: "synthetic",
    };
    const linkCheck = {
      result: "PASS",
      scope: "http_reachability",
      checkedOn: "2026-09-24",
      [Symbol("synthetic-extra")]: "synthetic",
    };

    expectReports([{ ...VALID, docLinks: [docLink] }], atZero("INVALID_DOC_LINK"));
    expectReports([{ ...VALID, linkCheck }], atZero("INVALID_LINK_CHECK"));
  });

  const fieldCases: readonly [string, Record<string, unknown>, ProviderMetadataIssueV1[]][] = [
    ["null id", { id: null }, ["INVALID_ID"]],
    ["number id", { id: 7 }, ["INVALID_ID"]],
    ["null displayName", { displayName: null }, ["INVALID_DISPLAY_NAME"]],
    ["number displayName", { displayName: 7 }, ["INVALID_DISPLAY_NAME"]],
    ["null category", { category: null }, ["INVALID_CATEGORY"]],
    ["number category", { category: 7 }, ["INVALID_CATEGORY"]],
    ["null officialHosts", { officialHosts: null }, ["INVALID_HOSTS"]],
    ["string officialHosts", { officialHosts: "example.com" }, ["INVALID_HOSTS"]],
    ["officialHosts [null]", { officialHosts: [null] }, ["INVALID_HOSTS"]],
    ["null credentialTypes", { credentialTypes: null }, ["INVALID_CREDENTIAL_TYPES"]],
    ["string credentialTypes", { credentialTypes: "api_key" }, ["INVALID_CREDENTIAL_TYPES"]],
    ["credentialTypes [null]", { credentialTypes: [null] }, ["INVALID_CREDENTIAL_TYPES"]],
    // docLinks가 배열이 아니면 확인된 링크가 없으므로 PASS 증거도 함께 거부된다.
    ["null docLinks", { docLinks: null }, ["INVALID_DOC_LINK", "INVALID_LINK_CHECK"]],
    ["string docLinks", { docLinks: "https://docs.example.com/keys" }, ["INVALID_DOC_LINK", "INVALID_LINK_CHECK"]],
    ["docLinks [null]", { docLinks: [null] }, ["INVALID_DOC_LINK"]],
    ["docLinks [array]", { docLinks: [["credentials", "https://docs.example.com/keys"]] }, ["INVALID_DOC_LINK"]],
    ["doc link with null url", { docLinks: [{ kind: "credentials", url: null }] }, ["INVALID_DOC_LINK"]],
    ["doc link with null kind", { docLinks: [{ kind: null, url: "https://docs.example.com/keys" }] }, ["INVALID_DOC_LINK"]],
    ["doc link missing url", { docLinks: [{ kind: "credentials" }] }, ["INVALID_DOC_LINK"]],
    ["doc link with extra field",
      { docLinks: [{ kind: "credentials", url: "https://docs.example.com/keys", note: "x" }] }, ["INVALID_DOC_LINK"]],
    ["null linkCheck", { linkCheck: null }, ["INVALID_LINK_CHECK"]],
    ["string linkCheck", { linkCheck: "PASS" }, ["INVALID_LINK_CHECK"]],
    ["array linkCheck", { linkCheck: ["PASS", "http_reachability", "2026-09-24"] }, ["INVALID_LINK_CHECK"]],
    ["number result", { linkCheck: { result: 1, scope: "http_reachability", checkedOn: "2026-09-24" } }, ["INVALID_LINK_CHECK"]],
    ["null scope", { linkCheck: { result: "PASS", scope: null, checkedOn: "2026-09-24" } }, ["INVALID_LINK_CHECK"]],
    ["number checkedOn", { linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: 20260924 } }, ["INVALID_LINK_CHECK"]],
    ["linkCheck missing checkedOn", { linkCheck: { result: "UNKNOWN", scope: "http_reachability" } }, ["INVALID_LINK_CHECK"]],
  ];

  it.each(fieldCases)("reports %s without throwing", (_name, patch, issues) => {
    expectReports([{ ...VALID, ...patch }], atZero(...issues));
  });

  it("still detects id ordering and duplicates across malformed entries", () => {
    const b = { ...VALID, id: "b" };
    expectReports([b, { ...VALID, id: null }, null, { ...VALID, id: "a" }, { ...VALID, id: "b" }], [
      { index: 1, issue: "INVALID_ID" },
      { index: 2, issue: "INVALID_ENTRY" },
      { index: 3, issue: "UNSORTED_IDS" },
      { index: 4, issue: "DUPLICATE_ID" },
    ]);
  });
});

describe("validateProviderMetadataCatalogV1 link check dates", () => {
  const linkCheck = (result: string, checkedOn: unknown) => ({
    linkCheck: { result, scope: "http_reachability", checkedOn },
  });
  const noon = (day: string) => ({ now: new Date(`${day}T12:00:00Z`) });

  it.each([
    ["an impossible date", linkCheck("PASS", "2026-02-30")],
    ["a far-future date", linkCheck("PASS", "9999-12-31")],
    ["UNKNOWN with a date", linkCheck("UNKNOWN", "2026-09-24")],
    ["PASS with a null date", linkCheck("PASS", null)],
    ["a non-ISO date", linkCheck("PASS", "2026-9-24")],
  ])("rejects %s with exactly INVALID_LINK_CHECK", (_name, patch) => {
    expectReports([{ ...VALID, ...patch }], atZero("INVALID_LINK_CHECK"));
  });

  it("accepts today and rejects tomorrow using the UTC calendar day", () => {
    const today = [{ ...VALID, ...linkCheck("PASS", "2026-09-24") }];
    const tomorrow = [{ ...VALID, ...linkCheck("PASS", "2026-09-25") }];
    expect(validateProviderMetadataCatalogV1(today, noon("2026-09-24"))).toEqual([]);
    expect(validateProviderMetadataCatalogV1(tomorrow, noon("2026-09-24"))).toEqual(atZero("INVALID_LINK_CHECK"));
    // KST 2026-09-24 08:00은 UTC로 아직 9월 23일이므로 24일 기록은 미래다.
    expect(validateProviderMetadataCatalogV1(today, { now: new Date("2026-09-24T08:00:00+09:00") }))
      .toEqual(atZero("INVALID_LINK_CHECK"));
  });

  it("fails closed when the reference clock is invalid", () => {
    const entry = [{ ...VALID }];
    expect(validateProviderMetadataCatalogV1(entry, { now: new Date(Number.NaN) })).toEqual(atZero("INVALID_LINK_CHECK"));
  });
});
