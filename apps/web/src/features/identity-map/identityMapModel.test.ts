import { describe, expect, it } from "vitest";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  buildIdentityMap,
  emptyIdentityMapView,
  recordedLabel,
  reduceIdentityMap,
} from "./identityMapModel";
import { SYNTHETIC_IDENTITY_MAP_ENTRIES } from "./syntheticIdentityMapFixture";

function row(overrides: Partial<LocalCatalogEntryV1> = {}): LocalCatalogEntryV1 {
  return {
    reference: 0,
    providerName: "Example AI Workshop",
    itemName: "Workshop API Credential",
    issuerAccountIdentifier: "demo-account",
    issuerOrganizationOrWorkspace: "demo-org",
    issuerProject: "demo-project",
    issuerEnvironment: "demo",
    credentialType: "api_key",
    status: "active",
    secretFieldCount: 1,
    connectionCount: 1,
    mcpConnectionCount: 1,
    connections: [{ label: "Example MCP", consumerType: "mcp_server" }],
    ...overrides,
  };
}

describe("recordedLabel", () => {
  it.each([
    { value: null, text: "기록 없음", recorded: false },
    { value: "", text: "빈 값으로 기록됨", recorded: true },
    { value: "demo-account", text: "demo-account", recorded: true },
  ])("distinguishes $text", ({ value, text, recorded }) => {
    expect(recordedLabel(value)).toEqual({ text, recorded });
  });
});

describe("buildIdentityMap", () => {
  it("returns an empty frozen graph for missing or non-array input", () => {
    expect(buildIdentityMap(null).accounts).toEqual([]);
    expect(buildIdentityMap(undefined).accounts).toEqual([]);
    expect(Object.isFrozen(buildIdentityMap([]))).toBe(true);
  });

  it("groups the closed synthetic fixture into accounts and three exploration hops", () => {
    const graph = buildIdentityMap(SYNTHETIC_IDENTITY_MAP_ENTRIES);
    expect(graph.accounts.map((account) => [account.serviceName, account.accountLabel, account.issuerCount, account.usageCount])).toEqual([
      ["Example AI Workshop", "demo-workshop-owner", 2, 2],
      ["Example Cloud Lab", "demo-lab-owner", 1, 2],
      ["Example Cloud Lab", "기록 없음", 1, 0],
    ]);
    const workshop = graph.accounts[0]!;
    const issuers = graph.issuersByAccount[workshop.id]!;
    expect(issuers.map((issuer) => issuer.itemName)).toEqual([
      "Workshop API Credential",
      "Workshop Recovery Envelope",
    ]);
    expect(graph.usagesByIssuer[issuers[0]!.id]!.map((usage) => usage.label)).toEqual([
      "Example MCP",
      "Example CLI",
    ]);
    expect(graph.usagesByIssuer[issuers[1]!.id]).toEqual([]);
  });

  it("keeps unrecorded and recorded-empty accounts separate regardless of input order", () => {
    const missing = row({ reference: 0, issuerAccountIdentifier: null, itemName: "Synthetic missing-account item" });
    const empty = row({ reference: 1, issuerAccountIdentifier: "", itemName: "Synthetic empty-account item" });
    for (const entries of [[missing, empty], [empty, missing]]) {
      const graph = buildIdentityMap(entries);
      expect(graph.accounts).toHaveLength(2);
      expect(new Set(graph.accounts.map((account) => account.id)).size).toBe(2);
      expect(graph.accounts.map((account) => ({ label: account.accountLabel, recorded: account.accountRecorded })))
        .toEqual(entries.map((entry) => ({
          label: entry.issuerAccountIdentifier === null ? "기록 없음" : "빈 값으로 기록됨",
          recorded: entry.issuerAccountIdentifier !== null,
        })));
      for (const [index, account] of graph.accounts.entries()) {
        expect(account.issuerCount).toBe(1);
        expect(account.usageCount).toBe(1);
        const issuers = graph.issuersByAccount[account.id]!;
        expect(issuers).toHaveLength(1);
        expect(issuers[0]!.itemName).toBe(entries[index]!.itemName);
        expect(issuers[0]!.snapshotReference).toBe(entries[index]!.reference);
      }
    }
  });

  it("keeps delimiter-bearing provider/account tuples and their issuer usages distinct", () => {
    const entries = [
      row({ reference: 0, providerName: "Example\0Provider", issuerAccountIdentifier: "demo-owner",
        itemName: "Synthetic first issuer", connections: [{ label: "Synthetic first MCP", consumerType: "mcp_server" }] }),
      row({ reference: 1, providerName: "Example", issuerAccountIdentifier: "Provider\0demo-owner",
        itemName: "Synthetic second issuer", connections: [{ label: "Synthetic second MCP", consumerType: "mcp_server" }] }),
    ];
    const graph = buildIdentityMap(entries);
    expect(graph.accounts).toHaveLength(2);
    expect(new Set(graph.accounts.map((account) => account.id)).size).toBe(2);
    expect(graph.accounts.map((account) => [account.serviceName, account.accountLabel]))
      .toEqual(entries.map((entry) => [entry.providerName, entry.issuerAccountIdentifier]));
    for (const [index, account] of graph.accounts.entries()) {
      const selected = reduceIdentityMap(graph, emptyIdentityMapView(graph), { type: "select-account", accountId: account.id });
      expect(selected.issuers).toHaveLength(1);
      const issuer = selected.issuers[0]!;
      expect(issuer.itemName).toBe(entries[index]!.itemName);
      expect(issuer.accountId).toBe(account.id);
      const usage = reduceIdentityMap(graph, selected, { type: "select-issuer", issuerId: issuer.id });
      expect(usage.usages.map((target) => [target.label, target.issuerId]))
        .toEqual([[entries[index]!.connections[0]!.label, issuer.id]]);
      expect(account.issuerCount).toBe(1);
      expect(account.usageCount).toBe(1);
    }
  });

  it("skips malformed rows instead of inventing nodes", () => {
    const graph = buildIdentityMap([
      row(),
      row({ reference: 0.5, itemName: "broken-ref" }),
      row({ connections: null as unknown as LocalCatalogEntryV1["connections"], itemName: "broken-connections" }),
      row({ connectionCount: 0, itemName: "count-mismatch" }),
    ]);
    expect(graph.accounts).toHaveLength(1);
    expect(graph.issuersByAccount[graph.accounts[0]!.id]).toHaveLength(1);
    expect(graph.issuersByAccount[graph.accounts[0]!.id]![0]!.itemName).toBe("Workshop API Credential");
  });

  it("does not copy secret-bearing fields onto graph nodes", () => {
    const graph = buildIdentityMap([row({ secretFieldCount: 9 })]);
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain("secretFieldCount");
    expect(serialized).not.toContain("DEMO_VALUE");
    expect(serialized).not.toMatch(/sk-|AKIA|Bearer /);
  });
});

describe("reduceIdentityMap", () => {
  const graph = buildIdentityMap(SYNTHETIC_IDENTITY_MAP_ENTRIES);
  const start = emptyIdentityMapView(graph);

  it("starts on the account step with no selection", () => {
    expect(start.step).toBe("account");
    expect(start.selectedAccount).toBeNull();
    expect(start.issuers).toEqual([]);
    expect(start.usages).toEqual([]);
    expect(start.accounts).toHaveLength(3);
  });

  it("walks account to issuer to usage and back without crossing accounts", () => {
    const account = graph.accounts[0]!;
    const afterAccount = reduceIdentityMap(graph, start, { type: "select-account", accountId: account.id });
    expect(afterAccount.step).toBe("issuer");
    expect(afterAccount.selectedAccount?.serviceName).toBe("Example AI Workshop");
    expect(afterAccount.issuers).toHaveLength(2);
    expect(afterAccount.usages).toEqual([]);

    const issuer = afterAccount.issuers[0]!;
    const afterIssuer = reduceIdentityMap(graph, afterAccount, { type: "select-issuer", issuerId: issuer.id });
    expect(afterIssuer.step).toBe("usage");
    expect(afterIssuer.selectedIssuer?.itemName).toBe("Workshop API Credential");
    expect(afterIssuer.usages.map((usage) => usage.label)).toEqual(["Example MCP", "Example CLI"]);

    const otherIssuer = graph.issuersByAccount[graph.accounts[1]!.id]![0]!;
    const rejectedCross = reduceIdentityMap(graph, afterAccount, { type: "select-issuer", issuerId: otherIssuer.id });
    expect(rejectedCross).toBe(afterAccount);

    const backToIssuers = reduceIdentityMap(graph, afterIssuer, { type: "back" });
    expect(backToIssuers.step).toBe("issuer");
    expect(backToIssuers.selectedIssuer).toBeNull();
    const backToAccounts = reduceIdentityMap(graph, backToIssuers, { type: "back" });
    expect(backToAccounts.step).toBe("account");
    expect(backToAccounts.selectedAccount).toBeNull();
  });

  it("ignores unknown ids and reset returns to accounts", () => {
    const account = graph.accounts[0]!;
    const selected = reduceIdentityMap(graph, start, { type: "select-account", accountId: account.id });
    expect(reduceIdentityMap(graph, start, { type: "select-account", accountId: "missing" }).selectedAccount).toBeNull();
    expect(reduceIdentityMap(graph, selected, { type: "select-issuer", issuerId: "missing" }).step).toBe("issuer");
    expect(reduceIdentityMap(graph, selected, { type: "reset" }).step).toBe("account");
  });

  it("opens only reachable steps from the breadcrumb", () => {
    const account = graph.accounts[0]!;
    const selected = reduceIdentityMap(graph, start, { type: "select-account", accountId: account.id });
    const issuer = selected.issuers[0]!;
    const usage = reduceIdentityMap(graph, selected, { type: "select-issuer", issuerId: issuer.id });

    expect(reduceIdentityMap(graph, start, { type: "open-step", step: "issuer" })).toBe(start);
    expect(reduceIdentityMap(graph, start, { type: "open-step", step: "usage" })).toBe(start);
    expect(reduceIdentityMap(graph, selected, { type: "open-step", step: "usage" })).toBe(selected);
    expect(reduceIdentityMap(graph, usage, { type: "open-step", step: "issuer" }).step).toBe("issuer");
    expect(reduceIdentityMap(graph, usage, { type: "open-step", step: "account" }).step).toBe("account");
  });
});
