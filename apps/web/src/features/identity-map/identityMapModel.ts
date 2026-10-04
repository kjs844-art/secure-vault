import type {
  CatalogConnectionTypeV1,
  CatalogCredentialTypeV1,
  CatalogStatusV1,
  LocalCatalogEntryV1,
} from "../../bridge/catalogProtocol";

export const IDENTITY_MAP_STEPS = ["account", "issuer", "usage"] as const;
export type IdentityMapStep = (typeof IDENTITY_MAP_STEPS)[number];

export interface IdentityMapAccount {
  readonly id: string;
  readonly serviceName: string;
  readonly accountLabel: string;
  readonly accountRecorded: boolean;
  readonly issuerCount: number;
  readonly usageCount: number;
}

export interface IdentityMapIssuer {
  readonly id: string;
  readonly accountId: string;
  readonly itemName: string;
  readonly credentialType: CatalogCredentialTypeV1;
  readonly status: CatalogStatusV1;
  readonly organizationLabel: string;
  readonly projectLabel: string;
  readonly environmentLabel: string;
  readonly usageCount: number;
  readonly snapshotReference: number;
}

export interface IdentityMapUsage {
  readonly id: string;
  readonly issuerId: string;
  readonly label: string;
  readonly consumerType: CatalogConnectionTypeV1;
}

export interface IdentityMapGraph {
  readonly accounts: readonly IdentityMapAccount[];
  readonly issuersByAccount: Readonly<Record<string, readonly IdentityMapIssuer[]>>;
  readonly usagesByIssuer: Readonly<Record<string, readonly IdentityMapUsage[]>>;
}

export interface IdentityMapView {
  readonly step: IdentityMapStep;
  readonly selectedAccountId: string | null;
  readonly selectedIssuerId: string | null;
  readonly accounts: readonly IdentityMapAccount[];
  readonly issuers: readonly IdentityMapIssuer[];
  readonly usages: readonly IdentityMapUsage[];
  readonly selectedAccount: IdentityMapAccount | null;
  readonly selectedIssuer: IdentityMapIssuer | null;
}

export type IdentityMapAction =
  | { readonly type: "select-account"; readonly accountId: string }
  | { readonly type: "select-issuer"; readonly issuerId: string }
  | { readonly type: "open-step"; readonly step: IdentityMapStep }
  | { readonly type: "back" }
  | { readonly type: "reset" };

const EMPTY_GRAPH: IdentityMapGraph = Object.freeze({
  accounts: Object.freeze([]),
  issuersByAccount: Object.freeze({}),
  usagesByIssuer: Object.freeze({}),
});

export function recordedLabel(value: string | null): { readonly text: string; readonly recorded: boolean } {
  if (value === null) return { text: "기록 없음", recorded: false };
  if (value === "") return { text: "빈 값으로 기록됨", recorded: true };
  return { text: value, recorded: true };
}

function accountId(entry: LocalCatalogEntryV1): string {
  return JSON.stringify([entry.providerName, entry.issuerAccountIdentifier]);
}

function issuerId(entry: LocalCatalogEntryV1): string {
  return `${accountId(entry)}\0${entry.reference}`;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

function isUsableEntry(entry: LocalCatalogEntryV1): boolean {
  if (entry == null) return false;
  if (typeof entry.providerName !== "string" || typeof entry.itemName !== "string") return false;
  if (!isFiniteInteger(entry.reference) || entry.reference < 0) return false;
  if (!Array.isArray(entry.connections)) return false;
  if (!isFiniteInteger(entry.connectionCount) || entry.connectionCount !== entry.connections.length) return false;
  return entry.connections.every((connection) => (
    connection != null
    && typeof connection.label === "string"
    && typeof connection.consumerType === "string"
  ));
}

export function buildIdentityMap(entries: readonly LocalCatalogEntryV1[] | null | undefined): IdentityMapGraph {
  if (!Array.isArray(entries)) return EMPTY_GRAPH;
  const accountOrder: string[] = [];
  const accounts = new Map<string, {
    serviceName: string;
    accountLabel: string;
    accountRecorded: boolean;
    issuerCount: number;
    usageCount: number;
  }>();
  const issuersByAccount = new Map<string, IdentityMapIssuer[]>();
  const usagesByIssuer = new Map<string, IdentityMapUsage[]>();

  for (const entry of entries) {
    if (!isUsableEntry(entry)) continue;
    const currentAccountId = accountId(entry);
    const account = recordedLabel(entry.issuerAccountIdentifier);
    if (!accounts.has(currentAccountId)) {
      accountOrder.push(currentAccountId);
      accounts.set(currentAccountId, {
        serviceName: entry.providerName,
        accountLabel: account.text,
        accountRecorded: account.recorded,
        issuerCount: 0,
        usageCount: 0,
      });
      issuersByAccount.set(currentAccountId, []);
    }
    const bucket = accounts.get(currentAccountId)!;
    const currentIssuerId = issuerId(entry);
    const usages = Object.freeze(entry.connections.map((connection: LocalCatalogEntryV1["connections"][number], index: number) => Object.freeze({
      id: `${currentIssuerId}\0${index}`,
      issuerId: currentIssuerId,
      label: connection.label,
      consumerType: connection.consumerType,
    })));
    usagesByIssuer.set(currentIssuerId, usages);
    issuersByAccount.get(currentAccountId)!.push(Object.freeze({
      id: currentIssuerId,
      accountId: currentAccountId,
      itemName: entry.itemName,
      credentialType: entry.credentialType,
      status: entry.status,
      organizationLabel: recordedLabel(entry.issuerOrganizationOrWorkspace).text,
      projectLabel: recordedLabel(entry.issuerProject).text,
      environmentLabel: recordedLabel(entry.issuerEnvironment).text,
      usageCount: usages.length,
      snapshotReference: entry.reference,
    }));
    bucket.issuerCount += 1;
    bucket.usageCount += usages.length;
  }

  const frozenIssuers: Record<string, readonly IdentityMapIssuer[]> = {};
  for (const [id, issuers] of issuersByAccount) {
    frozenIssuers[id] = Object.freeze(issuers.map((issuer) => Object.freeze(issuer)));
  }
  const frozenUsages: Record<string, readonly IdentityMapUsage[]> = {};
  for (const [id, usages] of usagesByIssuer) {
    frozenUsages[id] = usages;
  }
  return Object.freeze({
    accounts: Object.freeze(accountOrder.map((id) => {
      const account = accounts.get(id)!;
      return Object.freeze({
        id,
        serviceName: account.serviceName,
        accountLabel: account.accountLabel,
        accountRecorded: account.accountRecorded,
        issuerCount: account.issuerCount,
        usageCount: account.usageCount,
      });
    })),
    issuersByAccount: Object.freeze(frozenIssuers),
    usagesByIssuer: Object.freeze(frozenUsages),
  });
}

export function emptyIdentityMapView(graph: IdentityMapGraph): IdentityMapView {
  return Object.freeze({
    step: "account",
    selectedAccountId: null,
    selectedIssuerId: null,
    accounts: graph.accounts,
    issuers: Object.freeze([]),
    usages: Object.freeze([]),
    selectedAccount: null,
    selectedIssuer: null,
  });
}

function accountById(graph: IdentityMapGraph, accountIdValue: string | null): IdentityMapAccount | null {
  if (accountIdValue === null) return null;
  return graph.accounts.find((account) => account.id === accountIdValue) ?? null;
}

function issuerById(graph: IdentityMapGraph, issuerIdValue: string | null): IdentityMapIssuer | null {
  if (issuerIdValue === null) return null;
  for (const issuers of Object.values(graph.issuersByAccount)) {
    const found = issuers.find((issuer) => issuer.id === issuerIdValue);
    if (found) return found;
  }
  return null;
}

function viewFromSelection(
  graph: IdentityMapGraph,
  selectedAccountId: string | null,
  selectedIssuerId: string | null,
): IdentityMapView {
  const selectedAccount = accountById(graph, selectedAccountId);
  const selectedIssuer = issuerById(graph, selectedIssuerId);
  if (selectedIssuer && selectedAccount && selectedIssuer.accountId === selectedAccount.id) {
    return Object.freeze({
      step: "usage",
      selectedAccountId: selectedAccount.id,
      selectedIssuerId: selectedIssuer.id,
      accounts: graph.accounts,
      issuers: graph.issuersByAccount[selectedAccount.id] ?? Object.freeze([]),
      usages: graph.usagesByIssuer[selectedIssuer.id] ?? Object.freeze([]),
      selectedAccount,
      selectedIssuer,
    });
  }
  if (selectedAccount) {
    return Object.freeze({
      step: "issuer",
      selectedAccountId: selectedAccount.id,
      selectedIssuerId: null,
      accounts: graph.accounts,
      issuers: graph.issuersByAccount[selectedAccount.id] ?? Object.freeze([]),
      usages: Object.freeze([]),
      selectedAccount,
      selectedIssuer: null,
    });
  }
  return emptyIdentityMapView(graph);
}

export function reduceIdentityMap(
  graph: IdentityMapGraph,
  view: IdentityMapView,
  action: IdentityMapAction,
): IdentityMapView {
  switch (action.type) {
    case "reset":
      return emptyIdentityMapView(graph);
    case "select-account":
      return viewFromSelection(graph, action.accountId, null);
    case "select-issuer": {
      const issuer = issuerById(graph, action.issuerId);
      if (issuer === null) return view;
      if (view.selectedAccountId !== null && issuer.accountId !== view.selectedAccountId) return view;
      return viewFromSelection(graph, issuer.accountId, issuer.id);
    }
    case "open-step":
      if (action.step === "account") return emptyIdentityMapView(graph);
      if (action.step === "issuer") {
        if (view.selectedAccountId === null) return view;
        return viewFromSelection(graph, view.selectedAccountId, null);
      }
      if (view.selectedIssuerId === null) return view;
      return viewFromSelection(graph, view.selectedAccountId, view.selectedIssuerId);
    case "back":
      if (view.step === "usage") return viewFromSelection(graph, view.selectedAccountId, null);
      return emptyIdentityMapView(graph);
    default:
      return view;
  }
}
