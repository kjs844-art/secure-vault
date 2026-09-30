import { describe, expect, it } from "vitest";
import { MailDiscoveryError, mailMetadataAccessPolicy } from "./signupMailAccessPolicy";

describe("metadata-only mail permission policy", () => {
  it.each([
    ["synthetic_fixture", [], true],
    ["gmail", ["https://www.googleapis.com/auth/gmail.metadata"], false],
    ["microsoft_graph", ["Mail.ReadBasic"], false],
  ] as const)("accepts only the minimal proposed %s permission", (provider, scopes, available) => {
    const policy = mailMetadataAccessPolicy(provider, [...scopes]);
    expect(policy.scopes).toEqual(scopes);
    expect(policy.adapterAvailable).toBe(available);
    expect(policy.fields).toEqual(["senderDomain", "subject", "receivedAt"]);
    expect(policy.bodyAccess).toBe(false);
    expect(policy.attachmentAccess).toBe(false);
    expect(policy.mailboxWrites).toBe(false);
    expect(policy.fullTextQuery).toBe(false);
    expect(policy.processing).toBe("local");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.scopes)).toBe(true);
    expect(Object.isFrozen(policy.fields)).toBe(true);
  });

  it.each([
    ["gmail", ["https://www.googleapis.com/auth/gmail.readonly"]],
    ["gmail", ["https://www.googleapis.com/auth/gmail.modify"]],
    ["gmail", ["https://mail.google.com/"]],
    ["gmail", ["https://www.googleapis.com/auth/gmail.metadata", "email"]],
    ["microsoft_graph", ["Mail.Read"]],
    ["microsoft_graph", ["Mail.ReadWrite"]],
    ["microsoft_graph", ["Mail.ReadBasic.All"]],
    ["microsoft_graph", ["Mail.ReadBasic", "Mail.Send"]],
    ["synthetic_fixture", ["Mail.ReadBasic"]],
    ["gmail", []],
    ["gmail", null],
  ])("rejects broad, extra or missing %s permission", (provider, scopes) => {
    expect(() => mailMetadataAccessPolicy(provider, scopes)).toThrowError(new MailDiscoveryError("EXCESSIVE_PERMISSION"));
  });

  it.each(["naver", "kakao", "imap", "future-provider", undefined, {}, 1])("fails closed for an unimplemented provider", (provider) => {
    expect(() => mailMetadataAccessPolicy(provider, [])).toThrowError(new MailDiscoveryError("UNSUPPORTED_PROVIDER"));
  });

  it("rejects accessor, sparse, duplicate and decorated scope arrays", () => {
    let reads = 0;
    const getter: string[] = [];
    Object.defineProperty(getter, "0", { enumerable: true, get: () => { reads += 1; return "Mail.ReadBasic"; } });
    for (const scopes of [getter, new Array(1), ["Mail.ReadBasic", "Mail.ReadBasic"], Object.assign(["Mail.ReadBasic"], { token: "synthetic-only-canary" })]) {
      expect(() => mailMetadataAccessPolicy("microsoft_graph", scopes)).toThrowError(new MailDiscoveryError("EXCESSIVE_PERMISSION"));
    }
    expect(reads).toBe(0);
  });

  it("does not echo exceptional scope input", () => {
    const scopes = new Proxy([], { get: () => { throw Error("synthetic-only-private-canary"); } });
    expect(() => mailMetadataAccessPolicy("synthetic_fixture", scopes)).toThrowError(new MailDiscoveryError("EXCESSIVE_PERMISSION"));
  });
});
