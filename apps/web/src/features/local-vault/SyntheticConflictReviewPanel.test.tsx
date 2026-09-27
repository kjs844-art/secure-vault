import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import { SyntheticVaultSession } from "./SyntheticVaultSession";
import { SyntheticConflictReviewPanel } from "./SyntheticConflictReviewPanel";

const hiddenConflictId = "00000000000000000000000000000001";

function rows(): readonly LocalCatalogEntryV1[] {
  return [{
    reference: 0, itemName: "Synthetic reviewed item", providerName: "Synthetic provider",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo", credentialType: "api_key",
    status: "active", connectionCount: 0, secretFieldCount: 1, mcpConnectionCount: 0,
    connections: [],
  }];
}

async function fixture() {
  const store = {
    read: vi.fn().mockResolvedValue(new Uint8Array([1])),
    createIfAbsent: vi.fn().mockResolvedValue("exists" as const),
    listConflictArchives: vi.fn().mockResolvedValue([{
      conflictId: hiddenConflictId, bytes: new Uint8Array([2]),
    }]),
    deleteConflictArchiveIfEqual: vi.fn().mockResolvedValue("deleted" as const),
  };
  const worker = {
    create: vi.fn().mockResolvedValue(new Uint8Array([1])),
    open: vi.fn().mockResolvedValue(rows()),
    cancel: vi.fn(),
  };
  const session = new SyntheticVaultSession(store, worker);
  await session.open();
  return { session, store };
}

function render(session: SyntheticVaultSession): string {
  return renderToStaticMarkup(createElement(SyntheticConflictReviewPanel, {
    session, vaultGeneration: session.viewGeneration,
  }));
}

describe("synthetic conflict review panel shape", () => {
  it("starts with one explicit list action and never renders a storage ID", async () => {
    const { session, store } = await fixture();
    const html = render(session);
    expect(html).toContain("후보 목록 확인");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain(hiddenConflictId);
    expect(store.listConflictArchives).not.toHaveBeenCalled();
  });

  it("renders authenticated read-only catalog with only the first discard step", async () => {
    const { session } = await fixture();
    await session.loadConflictReviews(session.viewGeneration);
    const html = render(session);
    expect(html).toContain("Synthetic reviewed item");
    expect(html).toContain("이 후보 폐기 검토");
    expect(html).not.toContain("확인하고 후보 폐기");
    expect(html).not.toContain(hiddenConflictId);
    expect(html).not.toMatch(/<(input|textarea|select)/);
  });

  it("renders the destructive confirmation only after the first explicit step", async () => {
    const { session, store } = await fixture();
    await session.loadConflictReviews(session.viewGeneration);
    session.requestConflictDiscard(
      session.conflictReviewState.reviewVersion,
      session.conflictReviewState.items[0]!.reference,
    );
    const html = render(session);
    expect(html).toContain("아직 삭제하지 않았습니다");
    expect(html).toContain("취소");
    expect(html).toContain("확인하고 후보 폐기");
    expect(html).not.toContain("이 후보 폐기 검토");
    expect(store.deleteConflictArchiveIfEqual).not.toHaveBeenCalled();
    expect(html).not.toContain(hiddenConflictId);
  });

  it("shows a manual list action after delete without automatically relisting", async () => {
    const { session, store } = await fixture();
    await session.loadConflictReviews(session.viewGeneration);
    const version = session.conflictReviewState.reviewVersion;
    session.requestConflictDiscard(version, 0);
    await session.confirmConflictDiscard(version, 0);
    const html = render(session);
    expect(html).toContain("목록은 자동으로 다시 읽지 않습니다");
    expect(html).toContain("후보 목록 확인");
    expect(html).not.toContain("보존 후보 1</h3>");
    expect(store.listConflictArchives).toHaveBeenCalledOnce();
    expect(store.deleteConflictArchiveIfEqual).toHaveBeenCalledOnce();
  });
});
