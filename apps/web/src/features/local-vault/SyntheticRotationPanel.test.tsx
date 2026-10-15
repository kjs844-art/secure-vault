import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { LocalRotationChecklistV1 } from "../../bridge/rotationProtocol";
import type { SyntheticRotationReviewState } from "./SyntheticVaultSession";
import type { SyntheticRotationSelection } from "./syntheticRotation";
import {
  canCommitSyntheticRotation,
  sameSyntheticRotationSelection,
  SyntheticRotationPanel,
} from "./SyntheticRotationPanel";

const draft: SyntheticRotationSelection = Object.freeze({
  reference: 0,
  mcp: "user_confirmed",
  cli: "pending",
  ci: "pending",
  supersededRevocation: "user_confirmed",
});

const readyChecklist: LocalRotationChecklistV1 = Object.freeze({
  generation: "initial_0001",
  readinessState: "ready",
  entries: Object.freeze([
    Object.freeze({ fixture: "mcp", requiredForCutover: true }),
    Object.freeze({ fixture: "cli", requiredForCutover: false }),
  ]),
  remainingRequired: 0,
  remainingOptional: 1,
});

const reviewed = Object.freeze({ reviewVersion: 7, selection: draft });

function review(
  phase: SyntheticRotationReviewState["phase"] = "idle",
  checklist: LocalRotationChecklistV1 | null = null,
): SyntheticRotationReviewState {
  return Object.freeze({ phase, reviewVersion: 7, checklist, errorCode: null });
}

function entry(reference: number, providerName: string, itemName: string): LocalCatalogEntryV1 {
  return Object.freeze({
    reference,
    itemName,
    providerName,
    issuerAccountIdentifier: "demo-account",
    issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project",
    issuerEnvironment: "demo",
    credentialType: "api_key",
    status: "active",
    connectionCount: 0,
    secretFieldCount: 1,
    mcpConnectionCount: 0,
    connections: Object.freeze([]),
  });
}

function render(state: SyntheticRotationReviewState = review()) {
  const inspectRotation = vi.fn(async () => null);
  const commitRotationCutover = vi.fn(async () => {});
  const session = {
    subscribe: vi.fn(() => () => {}),
    get rotationReviewState() { return state; },
    inspectRotation,
    commitRotationCutover,
  };
  const html = renderToStaticMarkup(createElement(SyntheticRotationPanel, {
    session,
    vaultGeneration: 11,
    entries: [
      entry(0, "Example AI Workshop", "Synthetic API key"),
      entry(1, "Example Cloud Lab", "Synthetic service token"),
    ],
  }));
  return { html, inspectRotation, commitRotationCutover };
}

describe("synthetic rotation panel policy", () => {
  it("requires exact reviewed choices, ready state and explicit acknowledgement", () => {
    const ready = review("ready", readyChecklist);
    expect(canCommitSyntheticRotation(ready, reviewed, draft, true)).toBe(true);
    expect(canCommitSyntheticRotation(ready, reviewed, draft, false)).toBe(false);
    expect(canCommitSyntheticRotation(ready, null, draft, true)).toBe(false);
    expect(canCommitSyntheticRotation(review("loading"), reviewed, draft, true)).toBe(false);
    expect(canCommitSyntheticRotation(
      ready,
      reviewed,
      Object.freeze({ ...draft, mcp: "provider_verified" }),
      true,
    )).toBe(false);
    expect(canCommitSyntheticRotation(
      ready,
      Object.freeze({ reviewVersion: 6, selection: draft }),
      draft,
      true,
    )).toBe(false);
  });

  it("never treats pending-required or terminal checklists as committable", () => {
    const pending = Object.freeze({
      ...readyChecklist,
      readinessState: "required_pending" as const,
      remainingRequired: 1,
      remainingOptional: 0,
    });
    const terminal = Object.freeze({
      ...readyChecklist,
      generation: "terminal_0003" as const,
      readinessState: "terminal" as const,
      entries: Object.freeze([]),
      remainingRequired: 0,
      remainingOptional: 0,
    });
    expect(canCommitSyntheticRotation(review("ready", pending), reviewed, draft, true)).toBe(false);
    expect(canCommitSyntheticRotation(review("ready", terminal), reviewed, draft, true)).toBe(false);
  });

  it("compares every closed selection field without coercion", () => {
    expect(sameSyntheticRotationSelection(draft, Object.freeze({ ...draft }))).toBe(true);
    expect(sameSyntheticRotationSelection(draft, Object.freeze({ ...draft, reference: 1 }))).toBe(false);
    expect(sameSyntheticRotationSelection(draft, Object.freeze({
      ...draft, supersededRevocation: "provider_verified",
    }))).toBe(false);
    expect(sameSyntheticRotationSelection(null, draft)).toBe(false);
  });
});

describe("synthetic rotation panel static boundary", () => {
  it("renders only closed choices and performs no work during render", () => {
    const { html, inspectRotation, commitRotationCutover } = render();
    expect(html.match(/<select/g)).toHaveLength(5);
    expect(html.match(/<option/g)).toHaveLength(13);
    expect(html).not.toMatch(/<(textarea|iframe)|type="(text|password|file|email)"/);
    expect(html).toContain("실제 키·비밀번호 입력 금지");
    expect(html).toContain("실제 공급자 API를 호출하거나 실제 키를 갱신·폐기하지 않습니다");
    expect(html).toContain("Synthetic API key · 예시 1");
    expect(html).toContain("Synthetic service token · 예시 2");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="rotation-commit"/);
    expect(html).not.toContain("DEMO_VALUE_ONLY_API_KEY_0001");
    expect(inspectRotation).not.toHaveBeenCalled();
    expect(commitRotationCutover).not.toHaveBeenCalled();
  });

  it("distinguishes duplicate item names using the stable catalog reference", () => {
    const state = review();
    const html = renderToStaticMarkup(createElement(SyntheticRotationPanel, {
      session: {
        subscribe: () => () => {},
        get rotationReviewState() { return state; },
        inspectRotation: async () => null,
        commitRotationCutover: async () => {},
      },
      vaultGeneration: 11,
      entries: [entry(1, "Example AI", "Same name"), entry(5, "Example AI", "Same name")],
    }));
    expect(html).toContain("Example AI · Same name · 예시 2");
    expect(html).toContain("Example AI · Same name · 예시 6");
    expect(html).toMatch(/<option value="1"/);
    expect(html).toMatch(/<option value="5"/);
  });

  it("shows a projected checklist but fails closed after a remount without UI review identity", () => {
    const { html, commitRotationCutover } = render(review("ready", readyChecklist));
    expect(html).toContain("필수 조건이 준비됐습니다");
    expect(html).toContain("initial_0001");
    expect(html).toContain("Example MCP · 필수");
    expect(html).toContain("Example CLI · 선택");
    expect(html).toContain("현재 선택을 다시 검토하세요");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*data-testid="rotation-acknowledgement"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="rotation-commit"/);
    expect(commitRotationCutover).not.toHaveBeenCalled();
  });
});
