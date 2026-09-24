import { describe, expect, it } from "vitest";
import {
  findProviderMetadataV1,
  PROVIDER_METADATA_V1,
  validateProviderMetadataCatalogV1,
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

describe("validateProviderMetadataCatalogV1", () => {
  it("accepts a well-formed entry", () => {
    expect(issuesFor({})).toEqual([]);
  });

  it.each([
    ["uppercase id", { id: "Example" }, "INVALID_ID"],
    ["trailing hyphen id", { id: "example-" }, "INVALID_ID"],
    ["empty name", { displayName: "" }, "INVALID_DISPLAY_NAME"],
    ["padded name", { displayName: " Example" }, "INVALID_DISPLAY_NAME"],
    ["long name", { displayName: "x".repeat(65) }, "INVALID_DISPLAY_NAME"],
    ["unknown category", { category: "crypto_exchange" }, "INVALID_CATEGORY"],
    ["no hosts", { officialHosts: [] }, "INVALID_HOSTS"],
    ["host with scheme", { officialHosts: ["https://example.com"] }, "INVALID_HOSTS"],
    ["uppercase host", { officialHosts: ["Example.com"] }, "INVALID_HOSTS"],
    ["duplicate host", { officialHosts: ["example.com", "example.com"] }, "INVALID_HOSTS"],
    ["no credential types", { credentialTypes: [] }, "INVALID_CREDENTIAL_TYPES"],
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
