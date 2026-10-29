import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoveryInboxReview } from "./DiscoveryInboxReview";
import { buildDiscoveryInbox } from "./discoveryInboxModel";

// Callback/ownership decisions only, not a DOM or React scheduler simulation.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0,
  effects: [] as (() => void | (() => void))[], cleanup: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef<T,>(initial: T) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push({ current: initial });
    return hooks.values[slot] as { current: T };
  },
  useLayoutEffect(effect: () => void | (() => void)) { hooks.effects.push(effect); },
  useState<T,>(initial: T | (() => T)) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push(typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.values[slot] as T, (next: T) => { hooks.values[slot] = next; }];
  },
}));
type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, id: string): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, id); if (result) return result; }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    return node.props["data-testid"] === id ? node : find(node.props.children as ReactNode, id);
  }
  return undefined;
}
function button(node: ReactNode, id: string): Element {
  const result = find(node, id);
  if (!result) throw new Error("Missing synthetic test control");
  return result;
}
function click(tree: ReactNode, id: string, trigger?: HTMLButtonElement) {
  (button(tree, id).props.onClick as (event: { currentTarget: HTMLButtonElement | undefined }) => void)({ currentTarget: trigger });
}
const view = buildDiscoveryInbox([{ id: "aurora-demo", serviceName: "Aurora 예제", accountHint: "계정 정보 없음",
  confidence: "needs_review", sourceKind: "mail_hint", sourceLabel: "합성 예제", observedOn: "2026-09-29", note: "가입 환영 문구" }]);
function render(owner: object, onAction = vi.fn(), commit = true, shown = view) {
  hooks.cursor = 0;
  const tree = DiscoveryInboxReview({ view: shown, onAction, focusScope: owner });
  const effects = hooks.effects.splice(0);
  if (commit) for (const effect of effects) { const cleanup = effect(); if (cleanup) hooks.cleanup.push(cleanup); }
  return tree;
}
function focusFixture(tree: ReactNode) {
  const owner = { body: {}, activeElement: null as unknown };
  const trigger = { ownerDocument: owner, isConnected: true };
  owner.activeElement = trigger;
  const target = { ownerDocument: owner, isConnected: true, focus: vi.fn() };
  (button(tree, "discovery-filter-open").props.ref as { current: unknown }).current = target;
  return { owner, trigger, target, element: trigger as unknown as HTMLButtonElement };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanup = []; });

describe("controlled C06 review", () => {
  it("shows only supplied candidates, supported review actions and UTC dates", () => {
    const html = renderToStaticMarkup(render({}));
    expect(html).toContain("Aurora 예제");
    expect(html).toContain("<h3>");
    expect(html).toContain("UTC 날짜");
    expect(html).not.toContain("discovery-filter-inferred");
    expect(html).not.toContain("discovery-action-inferred");
    expect(html).not.toContain("Example AI Workshop");
    expect(renderToStaticMarkup(render({}, vi.fn(), true, buildDiscoveryInbox([])))).toContain("열린 항목 0건");
  });
  it("dispatches without mutating or internally retaining its supplied view", () => {
    const action = vi.fn();
    const owner = {};
    const tree = render(owner, action);
    click(tree, "discovery-action-confirmed");
    expect(action).toHaveBeenCalledExactlyOnceWith({ type: "set-confidence", id: "aurora-demo", confidence: "confirmed" });
    expect(renderToStaticMarkup(render(owner, action))).toContain("확인 필요");
    expect(view.items[0]?.confidence).toBe("needs_review");
  });
  it("ignores replaced and old A callbacks after A -> B -> identical A", () => {
    const ownerA = {}, ownerB = {}, action = vi.fn();
    const oldA = render(ownerA, action);
    render(ownerB, action);
    render(ownerA, action);
    click(oldA, "discovery-action-confirmed");
    click(oldA, "discovery-filter-dismissed");
    expect(action).not.toHaveBeenCalled();
  });
  it("rejects callbacks before initial commit and after unmount", () => {
    const owner = {}, action = vi.fn();
    click(render(owner, action, false), "discovery-action-confirmed");
    expect(action).not.toHaveBeenCalled();
    const tree = render(owner, action);
    for (const cleanup of hooks.cleanup) cleanup();
    click(tree, "discovery-action-confirmed");
    expect(action).not.toHaveBeenCalled();
  });
  it("restores the selected filter only when the focused action is removed", () => {
    const owner = {}, action = vi.fn();
    const tree = render(owner, action);
    const focus = focusFixture(tree);
    click(tree, "discovery-action-confirmed", focus.element);
    focus.trigger.isConnected = false;
    focus.owner.activeElement = focus.owner.body;
    render(owner, action);
    expect(focus.target.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
  it.each(["another control", "connected", "unfocused"])("does not steal focus: %s", (reason) => {
    const owner = {}, action = vi.fn();
    const tree = render(owner, action);
    const focus = focusFixture(tree);
    if (reason === "unfocused") focus.owner.activeElement = focus.owner.body;
    click(tree, "discovery-action-confirmed", focus.element);
    focus.trigger.isConnected = reason === "connected";
    focus.owner.activeElement = reason === "another control" ? {} : focus.owner.body;
    render(owner, action);
    expect(focus.target.focus).not.toHaveBeenCalled();
  });
  it("stale callbacks cannot erase the current owner's pending focus", () => {
    const oldTree = render({});
    const owner = {}, action = vi.fn();
    const current = render(owner, action);
    const focus = focusFixture(current);
    click(current, "discovery-action-confirmed", focus.element);
    click(oldTree, "discovery-filter-dismissed");
    focus.trigger.isConnected = false;
    focus.owner.activeElement = focus.owner.body;
    render(owner, action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(focus.target.focus).toHaveBeenCalledTimes(1);
  });
  it("retained same-owner callbacks cannot erase a later frame's pending focus", () => {
    const owner = {}, action = vi.fn();
    const previous = render(owner, action);
    const current = render(owner, action);
    const focus = focusFixture(current);
    click(current, "discovery-action-confirmed", focus.element);
    click(previous, "discovery-filter-dismissed");
    focus.trigger.isConnected = false;
    focus.owner.activeElement = focus.owner.body;
    render(owner, action);
    expect(focus.target.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("consumes an action frame before a synchronous owner callback can reenter it", () => {
    const owner = {};
    let tree: ReactNode;
    const action = vi.fn(() => {
      if (action.mock.calls.length === 1) click(tree, "discovery-filter-dismissed");
    });
    tree = render(owner, action);
    const focus = focusFixture(tree);
    click(tree, "discovery-action-confirmed", focus.element);
    focus.trigger.isConnected = false;
    focus.owner.activeElement = focus.owner.body;
    render(owner, action);
    expect(focus.target.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("does not publish an abandoned same-owner action frame or revoke the committed one", () => {
    const owner = {}, action = vi.fn();
    const committedTree = render(owner, action);
    const abandonedTree = render(owner, action, false);
    click(abandonedTree, "discovery-filter-dismissed");
    expect(action).not.toHaveBeenCalled();
    click(committedTree, "discovery-filter-confirmed");
    expect(action).toHaveBeenCalledExactlyOnceWith({ type: "filter", filter: "confirmed" });
  });
  it("accepts a fresh committed frame after consuming the previous frame", () => {
    const owner = {}, action = vi.fn();
    const previous = render(owner, action);
    click(previous, "discovery-filter-confirmed");
    click(previous, "discovery-filter-dismissed");
    expect(action).toHaveBeenCalledTimes(1);
    const current = render(owner, action);
    click(current, "discovery-filter-dismissed");
    expect(action).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenLastCalledWith({ type: "filter", filter: "dismissed" });
  });
});
