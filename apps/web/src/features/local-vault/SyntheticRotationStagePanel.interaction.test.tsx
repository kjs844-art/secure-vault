import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { SyntheticRotationStageReceipt, SyntheticRotationStageReviewState } from "./SyntheticVaultSession";
import { SyntheticRotationStagePanel } from "./SyntheticRotationStagePanel";

// Stable mock hook state tests callbacks only. No DOM, scheduler, subscriptions,
// browser event ordering, workers, or persisted/authenticated vault are tested.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "stage-unit",
  useState<T,>(initial: T | (() => T)) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push(typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.values[slot] as T, (next: T | ((previous: T) => T)) => {
      hooks.values[slot] = typeof next === "function" ? (next as (previous: T) => T)(hooks.values[slot] as T) : next;
    }];
  },
  useRef<T,>(initial: T) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push({ current: initial });
    return hooks.values[slot] as { current: T };
  },
  useSyncExternalStore<T,>(_subscribe: unknown, getSnapshot: () => T) { return getSnapshot(); },
}));

type Node = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, match: (element: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, match); if (result) return result; }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    return match(node) ? node : find(node.props.children as ReactNode, match);
  }
  return undefined;
}
function control(node: ReactNode, id: string): Node {
  const result = find(node, (element) => element.props["data-testid"] === id);
  if (!result) throw new Error(`Missing control ${id}`);
  return result;
}
function click(node: ReactNode, id: string) { (control(node, id).props.onClick as () => void)(); }
function change(node: ReactNode, id: string, value: string | boolean) {
  (control(node, id).props.onChange as (event: { currentTarget: { value: string; checked: boolean } }) => void)(
    { currentTarget: { value: typeof value === "string" ? value : "", checked: value === true } });
}
function row(reference: number, credentialType: "password" | "api_key"): LocalCatalogEntryV1 {
  return { reference, credentialType, status: "active", secretFieldCount: 1, connectionCount: 0,
    mcpConnectionCount: 0, connections: [], issuerAccountIdentifier: null,
    issuerOrganizationOrWorkspace: null, issuerProject: null, issuerEnvironment: null,
    providerName: "Example provider", itemName: `Example ${credentialType}` };
}
function harness(entries: readonly LocalCatalogEntryV1[]) {
  const session = {
    subscribe: vi.fn(() => () => {}),
    rotationStageReviewState: { phase: "idle", reviewVersion: 0, stage: null, errorCode: null } as SyntheticRotationStageReviewState,
    inspectRotationStage: vi.fn(async (_generation: number, _reference: number): Promise<SyntheticRotationStageReceipt | null> => null),
    saveRotationStage: vi.fn(async () => {}), commitRotationCutoverFromStage: vi.fn(async () => {}),
  };
  const render = () => { hooks.cursor = 0; return SyntheticRotationStagePanel({ session, vaultGeneration: 11, entries }); };
  return { session, render };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

describe("API-only stage event callbacks (mocked hook unit tests)", () => {
  it.each([{ entries: [] }, { entries: [row(0, "password")] }, { entries: [row(7, "password"), row(31, "password")] }])("never dispatches disabled actions without an API target", ({ entries }) => {
    const { session, render } = harness(entries);
    let tree = render();
    // Call disabled controls explicitly to check handler guards as well as markup.
    click(tree, "stage-load");
    click(tree, "stage-save");
    change(tree, "stage-reference", "7");
    change(tree, "stage-ack", true);
    tree = render();
    click(tree, "stage-commit");
    for (const id of ["stage-load", "stage-save", "stage-commit"]) expect(control(tree, id).props.disabled).toBe(true);
    expect(session.inspectRotationStage).not.toHaveBeenCalled();
    expect(session.saveRotationStage).not.toHaveBeenCalled();
    expect(session.commitRotationCutoverFromStage).not.toHaveBeenCalled();
  });

  it("keeps actual API references across mixed catalog selection and ignores Password options", () => {
    const { session, render } = harness([row(2, "password"), row(17, "api_key"), row(31, "password"), row(42, "api_key")]);
    let tree = render();
    expect(control(tree, "stage-reference").props.value).toBe(17);
    change(tree, "stage-reference", "31");
    tree = render();
    expect(control(tree, "stage-reference").props.value).toBe(17);
    click(tree, "stage-load");
    expect(session.inspectRotationStage).toHaveBeenCalledExactlyOnceWith(11, 17);
    change(tree, "stage-reference", "42");
    tree = render();
    click(tree, "stage-save");
    expect(session.saveRotationStage).toHaveBeenCalledExactlyOnceWith(11, {
      reference: 42, mcp: "pending", cli: "pending", ci: "pending", supersededRevocation: "pending",
    });
  });

  it("does not apply an unexpected Password receipt to the selected API entry", async () => {
    const { session, render } = harness([row(2, "password"), row(17, "api_key")]);
    session.inspectRotationStage.mockResolvedValue({ reviewVersion: 1, reference: 2, stage: null });
    click(render(), "stage-load");
    await Promise.resolve();
    const tree = render();
    expect(control(tree, "stage-reference").props.value).toBe(17);
    expect(control(tree, "stage-ack").props.checked).toBe(false);
    expect(control(tree, "stage-commit").props.disabled).toBe(true);
    expect(session.commitRotationCutoverFromStage).not.toHaveBeenCalled();
  });

  it("does not apply a late API receipt after the selected target changes", async () => {
    const { session, render } = harness([row(17, "api_key"), row(42, "api_key")]);
    let resolve!: (receipt: SyntheticRotationStageReceipt) => void;
    session.inspectRotationStage.mockImplementation(() => new Promise((done) => { resolve = done; }));
    let tree = render();
    click(tree, "stage-load");
    change(tree, "stage-reference", "42");
    resolve({ reviewVersion: 1, reference: 17, stage: null });
    await Promise.resolve();
    tree = render();
    expect(control(tree, "stage-reference").props.value).toBe(42);
    expect(control(tree, "stage-ack").props.checked).toBe(false);
    expect(control(tree, "stage-commit").props.disabled).toBe(true);
  });

  it("does not apply a different API reference returned for the current request", async () => {
    const { session, render } = harness([row(17, "api_key"), row(42, "api_key")]);
    session.inspectRotationStage.mockResolvedValue({ reviewVersion: 1, reference: 42, stage: null });
    click(render(), "stage-load");
    await Promise.resolve();
    const tree = render();
    expect(control(tree, "stage-reference").props.value).toBe(17);
    expect(control(tree, "stage-ack").props.checked).toBe(false);
    expect(control(tree, "stage-commit").props.disabled).toBe(true);
  });

  it("loads a current API receipt but still requires fresh consent and clears it on target changes", async () => {
    const { session, render } = harness([row(2, "password"), row(17, "api_key"), row(42, "api_key")]);
    const stage = { baseGeneration: "initial_0001", targetGeneration: "rotated_0002", entries: [],
      revocation: "user_confirmed", remainingRequired: 0, remainingOptional: 0, readyForCutover: true } as const;
    session.rotationStageReviewState = { phase: "ready", reviewVersion: 1, stage, errorCode: null };
    session.inspectRotationStage.mockResolvedValue({ reviewVersion: 1, reference: 17, stage });
    click(render(), "stage-load");
    await Promise.resolve();
    let tree = render();
    expect(control(tree, "stage-ack").props.checked).toBe(false);
    expect(control(tree, "stage-ack").props.disabled).toBe(false);
    expect(control(tree, "stage-commit").props.disabled).toBe(true);
    change(tree, "stage-ack", true);
    tree = render();
    expect(control(tree, "stage-commit").props.disabled).toBe(false);
    change(tree, "stage-reference", "42");
    tree = render();
    expect(control(tree, "stage-ack").props.checked).toBe(false);
    expect(control(tree, "stage-commit").props.disabled).toBe(true);
    click(tree, "stage-commit");
    expect(session.commitRotationCutoverFromStage).not.toHaveBeenCalled();
  });
});
