import { describe, expect, it, vi } from "vitest";
import { CATALOG_STATUSES_V1, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  SYNTHETIC_CONNECTION_OPTIONS, seedSyntheticConnectionEdit, sameSyntheticConnectionOrder,
  type SyntheticConnectionId,
} from "./syntheticConnectionEditorModel";

function row(ids: readonly SyntheticConnectionId[] = []): LocalCatalogEntryV1 {
  return {
    reference: 0, providerName: "Example AI Workshop", itemName: "Example Workshop API Credential",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo", credentialType: "api_key", status: "active",
    connectionCount: ids.length, mcpConnectionCount: ids.includes(0) ? 1 : 0, secretFieldCount: 1,
    connections: ids.map((id) => ({ label: SYNTHETIC_CONNECTION_OPTIONS[id].label,
      consumerType: SYNTHETIC_CONNECTION_OPTIONS[id].consumerType })),
  };
}

describe("synthetic connection editor UI-only model", () => {
  it("exports only the three frozen public connection choices", () => {
    expect(SYNTHETIC_CONNECTION_OPTIONS).toEqual([
      { id: 0, label: "Example MCP", consumerType: "mcp_server", description: "MCP 서버" },
      { id: 1, label: "Example CLI", consumerType: "cli", description: "명령줄 도구" },
      { id: 2, label: "Example CI", consumerType: "ci_cd", description: "CI/CD 자동화" },
    ]);
    expect(Object.isFrozen(SYNTHETIC_CONNECTION_OPTIONS)).toBe(true);
    for (const option of SYNTHETIC_CONNECTION_OPTIONS) expect(Object.isFrozen(option)).toBe(true);
  });
  it.each([
    { reference: 0, ids: [] }, { reference: 1, ids: [0] }, { reference: 2, ids: [0, 1, 2] },
  ] as const)("prefills original synthetic fixture $reference in its projected order", ({ reference, ids }) => {
    const entry = { ...row(ids), reference, secretFieldCount: reference === 2 ? 2 : 1 };
    expect(seedSyntheticConnectionEdit(entry)).toEqual(ids);
  });
  it.each([
    ["Example AI Workshop", "Example Workshop Registered API Key"],
    ["Example Cloud Lab", "Example Cloud Lab Registered API Key"],
  ])("prefills the registered fixture %s / %s", (providerName, itemName) => {
    expect(seedSyntheticConnectionEdit({ ...row([2, 0]), providerName, itemName, reference: 127 })).toEqual([2, 0]);
  });
  it.each(CATALOG_STATUSES_V1.filter((status) => status !== "rotating"))(
    "allows known visible status %s only as a prefill hint, leaving hidden validation to Rust", (status) => {
      expect(seedSyntheticConnectionEdit({ ...row([1]), status })).toEqual([1]);
    },
  );
  it("returns a separate frozen ordered ID list without altering the projection", () => {
    const entry = row([2, 0, 1]);
    const before = structuredClone(entry);
    const result = seedSyntheticConnectionEdit(entry);
    expect(result).toEqual([2, 0, 1]);
    expect(result).not.toBe(entry.connections);
    expect(Object.isFrozen(result)).toBe(true);
    expect(entry).toEqual(before);
    (entry.connections as { label: string; consumerType: "ci_cd" }[])[0]!.label = "changed";
    expect(result).toEqual([2, 0, 1]);
  });
  it("distinguishes known empty connections from unsupported metadata", () => {
    expect(seedSyntheticConnectionEdit(row())).toEqual([]);
    expect(seedSyntheticConnectionEdit({ ...row(), providerName: "Unsupported" })).toBeNull();
  });
  it.each([
    { providerName: "Example Cloud Lab" },
    { itemName: "Example Cloud Lab Registered API Key" },
    { itemName: "Example Workshop Registered API Key " },
    { providerName: "example ai workshop" },
    { itemName: "Unknown" },
    { credentialType: "token" }, { status: "rotating" }, { status: "future" },
    { reference: -1 }, { reference: 128 }, { reference: 0.5 }, { reference: NaN }, { reference: "0" },
    { connectionCount: -1 }, { connectionCount: 4 }, { connectionCount: 0.5 }, { connectionCount: NaN },
    { connectionCount: 1 }, { mcpConnectionCount: 1 }, { mcpConnectionCount: -1 }, { mcpConnectionCount: NaN },
    { connections: null }, { connections: {} },
  ])("returns null for an unsupported or inconsistent projection %j", (override) => {
    expect(seedSyntheticConnectionEdit({ ...row(), ...override } as LocalCatalogEntryV1)).toBeNull();
  });
  it.each([
    { label: "Example MCP", consumerType: "cli" },
    { label: "Example CLI", consumerType: "mcp_server" },
    { label: "Example CI", consumerType: "app" },
    { label: "Custom MCP", consumerType: "mcp_server" },
    { label: "Example MCP ", consumerType: "mcp_server" },
    { label: "Example MCP", consumerType: "unknown" },
  ])("never infers a fixture ID from label or type alone: %j", (connection) => {
    expect(seedSyntheticConnectionEdit({ ...row([0]), connections: [connection] } as LocalCatalogEntryV1)).toBeNull();
  });
  it.each([
    { ...row([0]), connections: [row([0]).connections[0]!, row([0]).connections[0]!], connectionCount: 2, mcpConnectionCount: 2 },
    { ...row([1]), connections: [row([1]).connections[0]!, row([1]).connections[0]!], connectionCount: 2 },
    { ...row([0]), mcpConnectionCount: 0 },
    { ...row([1]), mcpConnectionCount: 1 },
    { ...row([0]), connections: new Array(1) as LocalCatalogEntryV1["connections"] },
  ])("rejects duplicate, mismatched-count or sparse relations", (entry) => {
    expect(seedSyntheticConnectionEdit(entry)).toBeNull();
  });
  it("does not inspect private issuer/secret metadata or expose it through the result", () => {
    const readPrivate = vi.fn(() => { throw new Error("PRIVATE_METADATA"); });
    const entry = Object.defineProperties(row([2, 0]), {
      issuerAccountIdentifier: { get: readPrivate }, issuerOrganizationOrWorkspace: { get: readPrivate },
      issuerProject: { get: readPrivate }, issuerEnvironment: { get: readPrivate },
      secretFieldCount: { get: readPrivate }, recordId: { get: readPrivate }, revisionId: { get: readPrivate },
    });
    const result = seedSyntheticConnectionEdit(entry);
    expect(result).toEqual([2, 0]);
    expect(JSON.stringify(result)).toBe("[2,0]");
    expect(readPrivate).not.toHaveBeenCalled();
  });
  it("returns null when the required projection is unavailable instead of throwing", () => {
    const entry = Object.defineProperty(row(), "providerName", { get() { throw new Error("unavailable"); } });
    expect(seedSyntheticConnectionEdit(entry)).toBeNull();
    expect(seedSyntheticConnectionEdit(null as unknown as LocalCatalogEntryV1)).toBeNull();
  });
});

describe("sameSyntheticConnectionOrder", () => {
  it.each([
    { left: [], right: [], same: true },
    { left: [0], right: [0], same: true },
    { left: [2, 0, 1], right: [2, 0, 1], same: true },
    { left: [0, 1], right: [1, 0], same: false },
    { left: [2, 0, 1], right: [0, 1, 2], same: false },
    { left: [0], right: [], same: false },
    { left: [0], right: [1], same: false },
  ] as const)("compares order without sorting or modifying either array: $left / $right", ({ left, right, same }) => {
    const beforeLeft = [...left]; const beforeRight = [...right];
    expect(sameSyntheticConnectionOrder(Object.freeze(left), Object.freeze(right))).toBe(same);
    expect(left).toEqual(beforeLeft); expect(right).toEqual(beforeRight);
  });
});
