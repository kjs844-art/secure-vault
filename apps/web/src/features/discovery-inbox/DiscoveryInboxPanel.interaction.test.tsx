import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoveryInboxPanel } from "./DiscoveryInboxPanel";
import type { DiscoveryInboxItem } from "./discoveryInboxModel";

// Pure callback/state and element-shaped focus-guard checks. This does not
// simulate a browser DOM, React scheduling, actual focus or keyboard delivery.
// The root browser runner independently checks the real rendered screen.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(), queued: [] as (() => void)[],
  queueUpdates: false, updateCalls: 0,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo<T,>(factory: () => T, dependencies: readonly unknown[]) {
    const slot = hooks.cursor++;
    const previous = hooks.values[slot] as { value: T; dependencies: readonly unknown[] } | undefined;
    if (!previous || dependencies.length !== previous.dependencies.length
      || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
      hooks.values[slot] = { value: factory(), dependencies };
    }
    return (hooks.values[slot] as { value: T }).value;
  },
  useRef<T,>(initial: T) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push({ current: initial });
    return hooks.values[slot] as { current: T };
  },
  useLayoutEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
    const slot = hooks.cursor++;
    const previous = hooks.values[slot] as { dependencies?: readonly unknown[] } | undefined;
    if (!previous || dependencies === undefined || previous.dependencies === undefined
      || dependencies.length !== previous.dependencies.length
      || dependencies.some((value, index) => !Object.is(value, previous.dependencies![index]))) {
      hooks.values[slot] = { dependencies };
      hooks.effects.push(() => {
        hooks.cleanups.get(slot)?.();
        hooks.cleanups.delete(slot);
        const cleanup = effect();
        if (cleanup) hooks.cleanups.set(slot, cleanup);
      });
    }
  },
  useState<T,>(initial: T | (() => T)) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push(typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.values[slot] as T, (next: T | ((previous: T) => T)) => {
      hooks.updateCalls++;
      const apply = () => {
        hooks.values[slot] = typeof next === "function" ? (next as (previous: T) => T)(hooks.values[slot] as T) : next;
      };
      if (hooks.queueUpdates) hooks.queued.push(apply);
      else apply();
    }];
  },
}));

type Node = ReactElement<Record<string, unknown>>;
function fixture(label: string): readonly DiscoveryInboxItem[] {
  return [{ id: "synthetic-shared-row", serviceName: label, accountHint: "synthetic account",
    confidence: "needs_review", sourceKind: "manual", sourceLabel: "synthetic only",
    observedOn: "2026-10-27", note: "synthetic evidence" }];
}
function find(node: ReactNode, id: string): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, id); if (result) return result; }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    return node.props["data-testid"] === id ? node : find(node.props.children as ReactNode, id);
  }
  return undefined;
}
function control(tree: ReactNode, id: string): Node {
  const node = find(tree, id);
  if (!node) throw new Error("SYNTHETIC_CONTROL_REQUIRED");
  return node;
}
function click(tree: ReactNode, id: string, trigger?: unknown) {
  (control(tree, id).props.onClick as (event: { currentTarget: unknown }) => void)({ currentTarget: trigger });
}
function focusFixture() {
  const owner = { body: {}, activeElement: null as unknown };
  owner.activeElement = owner.body;
  const targets = Object.fromEntries(["open", "confirmed", "inferred", "needs_review", "dismissed"].map((id) => {
    const target = { ownerDocument: owner, isConnected: true, focus: vi.fn() };
    target.focus.mockImplementation(() => { owner.activeElement = target; });
    return [id, target];
  }));
  const trigger = { ownerDocument: owner, isConnected: true };
  return { owner, targets, trigger };
}
type FocusFixture = ReturnType<typeof focusFixture>;
function render(items: readonly DiscoveryInboxItem[], focus?: FocusFixture) {
  hooks.cursor = 0;
  const tree = DiscoveryInboxPanel({ items });
  if (focus) {
    for (const [id, target] of Object.entries(focus.targets)) {
      const ref = control(tree, `discovery-filter-${id}`).props.ref as { current: unknown } | undefined;
      // A baseline without a focus ref must fail the focus assertion, not throw
      // a harness TypeError before reaching the regression under test.
      if (ref) ref.current = target;
    }
  }
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
function resetHooks() {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups.clear();
  hooks.queued = []; hooks.queueUpdates = false; hooks.updateCalls = 0;
}
function unmount() {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
}
function needsReview(items: readonly DiscoveryInboxItem[], focus: FocusFixture) {
  click(render(items, focus), "discovery-filter-needs_review");
  return render(items, focus);
}
function removeFocusedRow(tree: ReactNode, focus: FocusFixture) {
  focus.owner.activeElement = focus.trigger;
  click(tree, "discovery-action-confirmed", focus.trigger);
  focus.trigger.isConnected = false;
  focus.owner.activeElement = focus.owner.body;
}
const html = (tree: ReactNode) => renderToStaticMarkup(tree);

beforeEach(resetHooks);

describe("DiscoveryInboxPanel focus handoff and callback ownership", () => {
  it("hands off the active removed row trigger to the selected filter exactly once", () => {
    const items = fixture("Synthetic service");
    const focus = focusFixture();
    removeFocusedRow(needsReview(items, focus), focus);
    expect(html(render(items, focus))).toContain("확인 필요 0건");
    expect(focus.targets.needs_review!.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focus.owner.activeElement).toBe(focus.targets.needs_review);
    expect(focus.targets.open!.focus).not.toHaveBeenCalled();
    render(items, focus);
    expect(focus.targets.needs_review!.focus).toHaveBeenCalledTimes(1);
  });

  it.each(["connected trigger", "external active element", "unfocused trigger"])("does not steal focus from %s", (condition) => {
    const items = fixture("Synthetic service");
    const focus = focusFixture();
    const tree = needsReview(items, focus);
    focus.owner.activeElement = condition === "unfocused trigger" ? focus.owner.body : focus.trigger;
    click(tree, "discovery-action-confirmed", focus.trigger);
    focus.trigger.isConnected = condition === "connected trigger";
    const expected = condition === "external active element" ? {} : focus.owner.body;
    focus.owner.activeElement = expected;
    render(items, focus);
    expect(focus.targets.needs_review!.focus).not.toHaveBeenCalled();
    expect(focus.owner.activeElement).toBe(expected);
  });

  it("does not hand off focus to a disconnected selected filter", () => {
    const items = fixture("Synthetic service");
    const focus = focusFixture();
    const tree = needsReview(items, focus);
    focus.targets.needs_review!.isConnected = false;
    removeFocusedRow(tree, focus);
    render(items, focus);
    expect(focus.targets.needs_review!.focus).not.toHaveBeenCalled();
  });

  it("drops a pending handoff when replacement input commits", () => {
    const items = fixture("Synthetic old service");
    const replacement = fixture("Synthetic new service");
    const focus = focusFixture();
    removeFocusedRow(needsReview(items, focus), focus);
    expect(html(render(replacement, focus))).toContain("Synthetic new service");
    expect(Object.values(focus.targets).every((target) => target.focus.mock.calls.length === 0)).toBe(true);
  });

  it.each(["replacement", "ABA"])("a stale filter callback cannot clobber current pending focus after %s", (change) => {
    const original = fixture("Synthetic service A");
    const replacement = fixture("Synthetic service B");
    const focus = focusFixture();
    const oldTree = needsReview(original, focus);
    render(replacement, focus);
    const currentItems = change === "ABA" ? original : replacement;
    const tree = needsReview(currentItems, focus);
    removeFocusedRow(tree, focus);
    click(oldTree, "discovery-filter-dismissed");
    const current = render(currentItems, focus);
    expect(html(current)).toContain("확인 필요 0건");
    expect(control(current, "discovery-filter-needs_review").props["aria-pressed"]).toBe(true);
    expect(focus.targets.needs_review!.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("a stale confidence callback cannot clobber current pending focus", () => {
    const original = fixture("Synthetic service A");
    const replacement = fixture("Synthetic service B");
    const focus = focusFixture();
    const oldTree = needsReview(original, focus);
    removeFocusedRow(needsReview(replacement, focus), focus);
    click(oldTree, "discovery-action-dismissed", focus.trigger);
    expect(html(render(replacement, focus))).toContain("확인 필요 0건");
    expect(focus.targets.needs_review!.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("ignores retained callbacks after owner cleanup before any state write", () => {
    const items = fixture("Synthetic service");
    const focus = focusFixture();
    const tree = needsReview(items, focus);
    unmount();
    const before = hooks.updateCalls;
    click(tree, "discovery-action-confirmed", focus.trigger);
    click(tree, "discovery-filter-confirmed");
    expect(hooks.updateCalls).toBe(before);
  });

  it("an unmounted owner's callback cannot overwrite a fresh owner's pending handoff", () => {
    const items = fixture("Synthetic service");
    const focus = focusFixture();
    const oldTree = needsReview(items, focus);
    unmount();
    resetHooks();
    removeFocusedRow(needsReview(items, focus), focus);
    click(oldTree, "discovery-filter-dismissed");
    expect(html(render(items, focus))).toContain("확인 필요 0건");
    expect(focus.targets.needs_review!.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("queued current-generation actions use the latest reducer state", () => {
    const items = fixture("Synthetic service");
    const focus = focusFixture();
    const tree = render(items, focus);
    hooks.queueUpdates = true;
    click(tree, "discovery-action-confirmed");
    click(tree, "discovery-filter-confirmed");
    hooks.queueUpdates = false;
    for (const apply of hooks.queued.splice(0)) apply();
    const current = render(items, focus);
    expect(control(current, "discovery-filter-confirmed").props["aria-pressed"]).toBe(true);
    expect(html(current)).toContain("확인됨 1건");
  });

  it("a previously accepted queued action cannot overwrite replacement state or pending focus", () => {
    const original = fixture("Synthetic service A");
    const replacement = fixture("Synthetic service B");
    const focus = focusFixture();
    const oldTree = render(original, focus);
    hooks.queueUpdates = true;
    click(oldTree, "discovery-action-dismissed");
    hooks.queueUpdates = false;
    removeFocusedRow(needsReview(replacement, focus), focus);
    for (const apply of hooks.queued.splice(0)) apply();
    const current = render(replacement, focus);
    expect(html(current)).toContain("확인 필요 0건");
    expect(control(current, "discovery-filter-needs_review").props["aria-pressed"]).toBe(true);
    expect(focus.targets.needs_review!.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("a previously accepted queued action cannot write state after owner cleanup", () => {
    const items = fixture("Synthetic service");
    const tree = render(items);
    hooks.queueUpdates = true;
    click(tree, "discovery-action-dismissed");
    hooks.queueUpdates = false;
    unmount();
    const before = hooks.values.slice();
    for (const apply of hooks.queued.splice(0)) apply();
    expect(hooks.values.length).toBe(before.length);
    hooks.values.forEach((value, index) => expect(value).toBe(before[index]));
  });

  it("rendering replacement input does not publish state or callback authority before commit", () => {
    const original = fixture("Synthetic service A");
    const replacement = fixture("Synthetic service B");
    const tree = render(original);
    const committedValues = hooks.values.slice();
    const before = hooks.updateCalls;
    hooks.cursor = 0;
    const uncommittedTree = DiscoveryInboxPanel({ items: replacement });
    expect(html(uncommittedTree)).toContain("Synthetic service B");
    expect(hooks.updateCalls).toBe(before);
    click(uncommittedTree, "discovery-action-dismissed");
    expect(hooks.updateCalls).toBe(before);
    // Discard only the harness's speculative hook slots/effects, not shared refs.
    // This checks the callback boundary, not React's actual Suspense scheduling.
    hooks.values = committedValues;
    hooks.effects = [];
    click(tree, "discovery-action-confirmed");
    click(tree, "discovery-filter-confirmed");
    expect(html(render(original))).toContain("확인됨 1건");
  });
});
