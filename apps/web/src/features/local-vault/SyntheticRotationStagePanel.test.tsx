import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { LocalRotationStageV1 } from "../../bridge/rotationStageProtocol";
import type { SyntheticRotationStageReceipt, SyntheticRotationStageReviewState } from "./SyntheticVaultSession";
import { canCommitSavedRotation, selectionFromSavedStage, SyntheticRotationStagePanel } from "./SyntheticRotationStagePanel";

const stage: LocalRotationStageV1 = {
  baseGeneration: "initial_0001", targetGeneration: "rotated_0002",
  entries: [{ fixture: "mcp", requiredForCutover: true, completion: "user_confirmed" }],
  revocation: "user_confirmed", remainingRequired: 0, remainingOptional: 0, readyForCutover: true,
};
const receipt: SyntheticRotationStageReceipt = { reviewVersion: 3, reference: 2, stage };
const review: SyntheticRotationStageReviewState = { phase: "ready", reviewVersion: 3, stage, errorCode: null };

function row(reference: number, credentialType: "password" | "api_key"): LocalCatalogEntryV1 {
  return { reference, credentialType, status: "active", secretFieldCount: 1, connectionCount: 0,
    mcpConnectionCount: 0, connections: [], issuerAccountIdentifier: null,
    issuerOrganizationOrWorkspace: null, issuerProject: null, issuerEnvironment: null,
    providerName: credentialType === "password" ? "Example Password Service" : "Example AI Workshop",
    itemName: `Example ${credentialType} ${reference}` };
}

function renderRows(entries: readonly LocalCatalogEntryV1[]) {
  const session = { subscribe: vi.fn(() => () => {}), rotationStageReviewState: review,
    inspectRotationStage: vi.fn(async () => null), saveRotationStage: vi.fn(async () => {}),
    commitRotationCutoverFromStage: vi.fn(async () => {}) };
  return { session, html: renderToStaticMarkup(createElement(SyntheticRotationStagePanel,
    { session, vaultGeneration: 9, entries })) };
}

describe("saved rotation UI consent policy", () => {
  // Static rendering assertions are not browser interaction/persistence proof.
  it("offers only API-key references without renumbering a mixed catalog", () => {
    const { html, session } = renderRows([row(2, "password"), row(17, "api_key"), row(31, "password"), row(42, "api_key")]);
    const targets = html.match(/<select[^>]*data-testid="stage-reference"[^>]*>(.*?)<\/select>/)?.[1];
    expect(targets).toBeDefined();
    expect(targets).toContain('value="17" selected=""');
    expect(targets).toContain('value="42"');
    expect(targets).not.toContain('value="2"');
    expect(targets).not.toContain('value="31"');
    expect(targets).not.toContain("Example Password Service");
    expect(html).toContain("비밀번호 2개는 금고 목록에 그대로 보관");
    expect(html).not.toContain('data-testid="stage-no-api-keys"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="stage-commit"/);
    expect(session.inspectRotationStage).not.toHaveBeenCalled();
    expect(session.saveRotationStage).not.toHaveBeenCalled();
    expect(session.commitRotationCutoverFromStage).not.toHaveBeenCalled();
  });

  it.each([{ entries: [] }, { entries: [row(7, "password"), row(19, "password")] }])("disables all rotation actions when no API key exists", ({ entries }) => {
    const { html, session } = renderRows(entries);
    expect(html).toContain('data-testid="stage-no-api-keys"');
    expect(html).toContain("교체할 API 키 항목이 없습니다");
    for (const id of ["stage-load", "stage-save", "stage-commit"]) {
      expect(html.match(/<button\b[^>]*>/g)?.find((tag) => tag.includes(`data-testid="${id}"`))).toContain('disabled=""');
    }
    expect(html.match(/<select\b[^>]*>/g)?.find((tag) => tag.includes('data-testid="stage-reference"'))).toContain('disabled=""');
    expect(html).toContain('<fieldset disabled=""');
    expect(session.inspectRotationStage).not.toHaveBeenCalled();
    expect(session.saveRotationStage).not.toHaveBeenCalled();
    expect(session.commitRotationCutoverFromStage).not.toHaveBeenCalled();
  });
  it("requires the current saved receipt, unchanged selection and new explicit consent", () => {
    const selection = selectionFromSavedStage(2, stage);
    expect(selection).toEqual({ reference: 2, mcp: "user_confirmed", cli: "pending", ci: "pending", supersededRevocation: "user_confirmed" });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(canCommitSavedRotation(review, receipt, selection, true)).toBe(true);
    expect(canCommitSavedRotation(review, receipt, selection, false)).toBe(false);
    expect(canCommitSavedRotation(review, null, selection, true)).toBe(false);
    expect(canCommitSavedRotation(review, { ...receipt, reviewVersion: 2 }, selection, true)).toBe(false);
    expect(canCommitSavedRotation(review, receipt, { ...selection, reference: 0 }, true)).toBe(false);
    expect(canCommitSavedRotation(review, receipt, { ...selection, mcp: "pending" }, true)).toBe(false);
    expect(canCommitSavedRotation(review, receipt, { ...selection, supersededRevocation: "provider_verified" }, true)).toBe(false);
    expect(canCommitSavedRotation({ ...review, phase: "loading" }, receipt, selection, true)).toBe(false);
    expect(canCommitSavedRotation({ ...review, stage: { ...stage, readyForCutover: false } }, receipt, selection, true)).toBe(false);
  });

  it("mounting against an existing ready review never restores consent or makes any call", () => {
    const session = { subscribe: vi.fn(() => () => {}), rotationStageReviewState: review,
      inspectRotationStage: vi.fn(async () => null), saveRotationStage: vi.fn(async () => {}),
      commitRotationCutoverFromStage: vi.fn(async () => {}) };
    const html = renderToStaticMarkup(createElement(SyntheticRotationStagePanel, { session, vaultGeneration: 9, entries: [] }));
    expect(html).toContain("실제 키 입력 금지");
    expect(html).toContain("진행만 암호화 저장");
    expect(html).toContain('data-testid="stage-capacity-note"');
    expect(html).toContain("기존 이력은 자동 삭제하지 않습니다");
    expect(html).toContain("기기 저장 공간까지 보장하는 것은 아닙니다");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain("checked=");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="stage-commit"/);
    expect(session.inspectRotationStage).not.toHaveBeenCalled();
    expect(session.saveRotationStage).not.toHaveBeenCalled();
    expect(session.commitRotationCutoverFromStage).not.toHaveBeenCalled();
  });
});
