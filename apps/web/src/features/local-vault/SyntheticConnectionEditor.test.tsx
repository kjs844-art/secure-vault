import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import { LocalCatalogResults } from "./LocalCatalogSearch";
import { searchLocalCatalog } from "./searchLocalCatalog";
import { SyntheticConnectionEditor, SyntheticEditableCatalog } from "./SyntheticConnectionEditor";

type ConnectionId = 0 | 1 | 2;
const CONNECTIONS = [
  { label: "Example MCP", consumerType: "mcp_server" },
  { label: "Example CLI", consumerType: "cli" },
  { label: "Example CI", consumerType: "ci_cd" },
] as const;

function entry(
  reference = 0,
  ids: readonly ConnectionId[] = [],
  overrides: Partial<LocalCatalogEntryV1> = {},
): LocalCatalogEntryV1 {
  return Object.freeze({
    reference, itemName: "Example Workshop API Credential", providerName: "Example AI Workshop",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo", credentialType: "api_key",
    status: "active", secretFieldCount: 2, connectionCount: ids.length,
    mcpConnectionCount: ids.includes(0) ? 1 : 0,
    connections: Object.freeze(ids.map((id) => Object.freeze({ ...CONNECTIONS[id] }))),
    ...overrides,
  });
}

function renderEditor(row: LocalCatalogEntryV1, active = true) {
  const editConnections = vi.fn(async () => {});
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const html = renderToStaticMarkup(<SyntheticConnectionEditor entry={row} generation={19}
    session={{ editConnections }} active={active} onOpen={onOpen} onClose={onClose} />);
  return { html, editConnections, onOpen, onClose };
}

function tagByTestId(html: string, tag: "input" | "button", testId: string): string {
  const found = html.match(new RegExp(`<${tag}\\b[^>]*>`, "g"))
    ?.find((candidate) => candidate.includes(`data-testid="${testId}"`));
  expect(found, `expected ${tag} for ${testId}`).toBeDefined();
  return found!;
}

/** SSR shape and render purity only; this does not execute clicks, effects,
 * focus restoration, submissions, cancellation, lock races, or persistence. */
describe("synthetic connection editor initial rendering", () => {
  it.each([false, true])("explains Password capability limits even when active=%s", (active) => {
    const { html, editConnections, onOpen, onClose } = renderEditor(entry(31, [], {
      credentialType: "password", providerName: "Example Password Service", issuerAccountIdentifier: null,
    }), active);
    expect(html).toContain('data-testid="connection-edit-unavailable-31"');
    expect(html).toContain("비밀번호 항목은 보관·목록 확인만 지원");
    expect(html).toContain("API 키 항목만 지원");
    expect(html).toContain("계정 식별자 원문은 표시하지 않습니다");
    expect(html).not.toMatch(/<(button|form|input)\b/);
    expect(editConnections).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("renders a closed opener with the snapshot reference and no editable inputs", () => {
    const { html, editConnections, onOpen, onClose } = renderEditor(entry(7, [0]), false);
    expect(tagByTestId(html, "button", "connection-edit-open-7")).toContain('type="button"');
    expect(html).toContain("예시 8 연결 기록 편집");
    expect(html).not.toMatch(/<(form|input|textarea)\b/);
    expect(html).not.toContain('data-testid="connection-editor"');
    expect(editConnections).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    { itemName: "Unsupported synthetic item" },
    { credentialType: "token" as const },
    { status: "rotating" as const },
    { connectionCount: 1, connections: [{ label: "Example MCP", consumerType: "cli" as const }] },
  ])("shows the no-modification message for an unsupported projection %j", (overrides) => {
    for (const active of [false, true]) {
      const { html, editConnections, onOpen, onClose } = renderEditor(entry(5, [], overrides), active);
      expect(html).toContain('data-testid="connection-edit-unavailable-5"');
      expect(html).toContain("현재 합성 연결 편집 화면에서 지원하지 않습니다");
      expect(html).toContain("기존 기록은 변경하지 않습니다");
      expect(html).not.toMatch(/<(button|form|input)\b/);
      expect(editConnections).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    }
  });

  it.each([
    { ids: [], order: "연결 기록 없음" },
    { ids: [0], order: "Example MCP" },
    { ids: [2, 0, 1], order: "Example CI → Example MCP → Example CLI" },
  ] as const)("prefills the exact $ids selection and order with saving disabled", ({ ids, order }) => {
    const row = entry(11, ids);
    const { html, editConnections } = renderEditor(row);
    expect(html).toContain('data-testid="connection-editor"');
    expect(html).toContain("예시 12의 연결 기록 수정");
    expect(html).toContain(`현재 기록 순서: ${order}`);
    expect(html).toContain(`변경 후 순서: ${order}`);
    for (const id of [0, 1, 2] as const) {
      const choice = tagByTestId(html, "input", `connection-edit-choice-${id}`);
      expect(choice.includes('checked=""')).toBe((ids as readonly ConnectionId[]).includes(id));
    }
    expect(tagByTestId(html, "input", "connection-edit-acknowledgement")).not.toContain('checked=""');
    expect(tagByTestId(html, "button", "connection-edit-submit")).toContain('disabled=""');
    expect(html).toContain("아직 변경한 내용이 없습니다");
    expect(html).toContain("같은 선택과 순서는 다시 저장하지 않습니다");
    expect(html).not.toContain('data-testid="connection-edit-removal"');
    expect(row.connections.map((connection) => connection.label)).toEqual(ids.map((id) => CONNECTIONS[id].label));
    expect(editConnections).not.toHaveBeenCalled();
  });

  it.each([
    { providerName: "Example AI Workshop", itemName: "Example Workshop Registered API Key" },
    { providerName: "Example Cloud Lab", itemName: "Example Cloud Lab Registered API Key" },
  ])("renders the supported registration profile $providerName", (profile) => {
    const { html, editConnections } = renderEditor(entry(6, [1], profile));
    expect(html).toContain(profile.providerName);
    expect(html).toContain(profile.itemName);
    expect(html).toContain("현재 기록 순서: Example CLI");
    expect(tagByTestId(html, "input", "connection-edit-choice-1")).toContain('checked=""');
    expect(tagByTestId(html, "button", "connection-edit-submit")).toContain('disabled=""');
    expect(editConnections).not.toHaveBeenCalled();
  });

  it("accepts no free-text or secret input and never reads extra private payload fields", () => {
    const unexpectedRead = vi.fn(() => { throw new Error("UNREVIEWED_PRIVATE_FIELD"); });
    const row = { ...entry(0, [2]) };
    for (const field of ["secret", "secretValues", "notes", "recordId", "revisionId", "toJSON"]) {
      Object.defineProperty(row, field, { enumerable: true, get: unexpectedRead });
    }
    const { html, editConnections } = renderEditor(row);
    expect(html.match(/<input\b/g)).toHaveLength(4);
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html).not.toMatch(/<(textarea|select|iframe)\b|type="(text|search|password|file|email|url)"/);
    expect(html).not.toMatch(/\b(action|formAction|href|contentEditable)=/i);
    expect(html).not.toContain("DEMO_VALUE_ONLY_API_KEY_0001");
    expect(html).not.toContain("DEMO_VALUE_ONLY_TOKEN_0002");
    expect(html).toContain("실제 MCP/CLI 실행이나 외부 연결 확인은 하지 않습니다");
    expect(unexpectedRead).not.toHaveBeenCalled();
    expect(editConnections).not.toHaveBeenCalled();
  });

  it.each([
    { account: null, text: "기록 없음" },
    { account: "", text: "빈 값으로 기록됨" },
    { account: "demo-account", text: "demo-account" },
  ])("distinguishes issuer absence, empty text, and recorded text: $text", ({ account, text }) => {
    const { html } = renderEditor(entry(0, [], { issuerAccountIdentifier: account }));
    expect(html).toContain(`발급 계정: ${text}`);
  });

  it("escapes private issuer display text without turning it into markup or a link", () => {
    const { html, editConnections } = renderEditor(entry(0, [], {
      issuerAccountIdentifier: '<a href="https://example.invalid/private">DEMO & private</a>',
    }));
    expect(html).toContain("&lt;a href=&quot;https://example.invalid/private&quot;&gt;DEMO &amp; private&lt;/a&gt;");
    expect(html).not.toMatch(/<a\b|<iframe\b/);
    expect(editConnections).not.toHaveBeenCalled();
  });

  it("offers cancellation with a record-preservation label and no premature success", () => {
    const { html, editConnections, onClose } = renderEditor(entry());
    const cancel = tagByTestId(html, "button", "connection-edit-cancel");
    expect(cancel).toContain('type="button"');
    expect(cancel).not.toContain('disabled=""');
    expect(html).toContain("취소 · 기록 유지");
    expect(html).toContain("0개를 선택하면 이 항목의 연결 기록만 비웁니다");
    expect(html).toContain("API 키와 계정 정보는 그대로 보관합니다");
    expect(html).not.toMatch(/저장 완료|변경 완료|저장 확인 중|role="status"/);
    expect(editConnections).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("synthetic editable catalog render boundary", () => {
  it.each([false, true])("keeps Password rows in the catalog and counts with mixed=%s", (mixed) => {
    const password = entry(17, [], {
      credentialType: "password", providerName: "Example Password Service",
      itemName: "Example Registered Password", issuerAccountIdentifier: null,
      issuerProject: null, issuerEnvironment: null, secretFieldCount: 1,
    });
    const entries = mixed ? [password, entry(42, [0])] : [password];
    const editConnections = vi.fn(async () => {});
    const html = renderToStaticMarkup(<SyntheticEditableCatalog entries={entries} generation={31}
      session={{ editConnections }} />);
    expect(html).toContain(`전체 ${entries.length}개 중 ${entries.length}개`);
    expect(html).toContain("Example Password Service");
    expect(html).toContain("Example Registered Password");
    expect(html).toContain("보관된 비밀 필드 1개");
    expect(html).toContain('data-testid="connection-edit-unavailable-17"');
    expect(html).not.toContain('data-testid="connection-edit-open-17"');
    expect(html.includes('data-testid="connection-edit-open-42"')).toBe(mixed);
    expect(editConnections).not.toHaveBeenCalled();
  });
  it("keeps snapshot references through filtered LocalCatalogResults entry actions", () => {
    const source = Object.freeze([
      entry(9, [], { issuerProject: "DEMO other-project" }),
      entry(2, [0], { issuerProject: "DEMO other-project" }),
      entry(73, [2, 0, 1], { issuerProject: "DEMO selected-project" }),
    ]);
    const matches = searchLocalCatalog(source, "selected-project");
    expect(matches).toEqual([source[2]]);
    expect(matches[0]).toBe(source[2]);
    const editConnections = vi.fn(async () => {});
    const renderEntryActions = vi.fn((row: LocalCatalogEntryV1) => (
      <SyntheticConnectionEditor entry={row} generation={29} session={{ editConnections }}
        active={false} onOpen={() => {}} onClose={() => {}} />
    ));
    const html = renderToStaticMarkup(<LocalCatalogResults entries={matches} renderEntryActions={renderEntryActions} />);
    expect(renderEntryActions).toHaveBeenCalledExactlyOnceWith(source[2]);
    expect(html).toContain('data-testid="connection-edit-open-73"');
    expect(html).toContain("예시 74 연결 기록 편집");
    expect(html).not.toContain('data-testid="connection-edit-open-0"');
    expect(source.map((row) => row.reference)).toEqual([9, 2, 73]);
    expect(editConnections).not.toHaveBeenCalled();
  });

  it("starts with independent closed entry openers and no session edits during render", () => {
    const entries = Object.freeze([entry(9), entry(42, [0]), entry(7, [2, 0, 1])]);
    const editConnections = vi.fn(async () => {});
    const html = renderToStaticMarkup(<SyntheticEditableCatalog entries={entries} generation={31}
      session={{ editConnections }} />);
    for (const reference of [9, 42, 7]) {
      expect(html).toContain(`data-testid="connection-edit-open-${reference}"`);
    }
    expect(html.match(/data-testid="connection-edit-open-/g)).toHaveLength(3);
    expect(html).not.toContain('data-testid="connection-editor"');
    expect(html).not.toContain('data-testid="connection-edit-submit"');
    expect(editConnections).not.toHaveBeenCalled();
  });

  it("escapes unsupported private provider and item display text in the containing catalog", () => {
    const row = entry(4, [], { providerName: "<em>DEMO provider</em>", itemName: "<b>DEMO item</b>" });
    const editConnections = vi.fn(async () => {});
    const html = renderToStaticMarkup(<SyntheticEditableCatalog entries={[row]} generation={31}
      session={{ editConnections }} />);
    expect(html).toContain("&lt;em&gt;DEMO provider&lt;/em&gt;");
    expect(html).toContain("&lt;b&gt;DEMO item&lt;/b&gt;");
    expect(html).not.toMatch(/<em>|<b>/);
    expect(html).toContain('data-testid="connection-edit-unavailable-4"');
    expect(html).not.toContain('data-testid="connection-edit-open-4"');
    expect(editConnections).not.toHaveBeenCalled();
  });
});
