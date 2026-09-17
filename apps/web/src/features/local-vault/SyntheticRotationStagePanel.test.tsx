import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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

describe("saved rotation UI consent policy", () => {
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
