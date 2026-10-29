import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import { IdentityMapPanel } from "./IdentityMapPanel";
import { SYNTHETIC_IDENTITY_MAP_ENTRIES as entries } from "./syntheticIdentityMapFixture";

// Callback/state regression only, not a DOM or React scheduler simulation.
// The separate browser harness verifies actual focus and native events.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[],
  rendering: false, renderStateWrites: 0,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef<T,>(initial: T) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push({ current: initial });
    return hooks.values[slot] as { current: T };
  },
  useMemo<T,>(factory: () => T, deps: readonly unknown[]) {
    const slot = hooks.cursor++;
    const previous = hooks.values[slot] as { deps: readonly unknown[]; value: T } | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.values[slot] = { deps, value: factory() };
    return (hooks.values[slot] as { value: T }).value;
  },
  useId() {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push(`identity-test-${slot}`);
    return hooks.values[slot] as string;
  },
  useLayoutEffect(effect: () => void | (() => void)) {
    hooks.effects.push(() => { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup); });
  },
  useEffect(effect: () => void | (() => void)) {
    hooks.effects.push(() => { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup); });
  },
  useState<T,>(initial: T | (() => T)) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push(typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.values[slot] as T, (next: T | ((previous: T) => T)) => {
      if (hooks.rendering) hooks.renderStateWrites++;
      hooks.values[slot] = typeof next === "function" ? (next as (previous: T) => T)(hooks.values[slot] as T) : next;
    }];
  },
}));

type Node = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, id: string): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, id); if (found) return found; }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    return node.props["data-testid"] === id ? node : find(node.props.children as ReactNode, id);
  }
  return undefined;
}
function control(node: ReactNode, id: string): Node {
  const result = find(node, id);
  if (!result) throw new Error(`Missing control ${id}`);
  return result;
}
function click(node: ReactNode, id: string, trigger?: HTMLButtonElement) {
  (control(node, id).props.onClick as (event: { currentTarget: HTMLButtonElement | undefined }) => void)({ currentTarget: trigger });
}
function render(source: readonly LocalCatalogEntryV1[] = entries, sourceLabel?: string) {
  hooks.cursor = 0;
  hooks.rendering = true;
  let tree: ReturnType<typeof IdentityMapPanel>;
  try { tree = IdentityMapPanel({ entries: source, ...(sourceLabel === undefined ? {} : { sourceLabel }) }); }
  finally { hooks.rendering = false; }
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
const html = (tree: ReactNode) => renderToStaticMarkup(tree);
function openUsage(source: readonly LocalCatalogEntryV1[] = entries) {
  click(render(source), "identity-map-account");
  click(render(source), "identity-map-issuer");
  return render(source);
}

function focusFixture(tree: ReactNode) {
  const owner = { body: {}, activeElement: null as unknown };
  const trigger = { ownerDocument: owner, isConnected: true };
  owner.activeElement = trigger;
  const target = { ownerDocument: owner, isConnected: true, focus: vi.fn() };
  const ref = control(tree, "identity-map-step-account").props.ref as { current: unknown };
  ref.current = target;
  return { owner, trigger, target, element: trigger as unknown as HTMLButtonElement };
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = [];
  hooks.rendering = false; hooks.renderStateWrites = 0;
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("Identity Map callback ownership", () => {
  it("derives a replacement's empty view without render-phase state writes", () => {
    openUsage();
    const replacement = entries.map((entry) => ({ ...entry, itemName: `New ${entry.itemName}` }));
    const tree = render(replacement);
    expect(html(tree)).toContain('data-testid="identity-map-account"');
    expect(html(tree)).not.toContain('data-testid="identity-map-usages"');
    expect(hooks.renderStateWrites).toBe(0);
    // The first committed replacement action starts from its own empty graph,
    // even though the last interaction state still belongs to the original A.
    click(tree, "identity-map-account");
    expect(html(render(replacement))).toContain("New Workshop API Credential");
  });

  it("keeps a selected usage when only the source label changes", () => {
    openUsage();
    expect(html(render(entries, "다른 합성 안내"))).toContain('data-testid="identity-map-usages"');
  });

  it("does not let stale account callbacks reset a replacement selection", () => {
    const old = render();
    const replacement = entries.map((entry) => ({ ...entry, itemName: `New ${entry.itemName}` }));
    openUsage(replacement);
    click(old, "identity-map-account");
    expect(html(render(replacement))).toContain('data-testid="identity-map-usages"');
    expect(html(render(replacement))).toContain("New Workshop API Credential");
  });

  it.each(["identity-map-back", "identity-map-reset", "identity-map-step-account"])("ignores old %s callbacks after replacement", (id) => {
    const old = openUsage();
    const replacement = entries.map((entry) => ({ ...entry }));
    openUsage(replacement);
    click(old, id);
    expect(html(render(replacement))).toContain('data-testid="identity-map-usages"');
  });

  it("rejects original A callbacks after A -> empty -> same A array", () => {
    const old = openUsage();
    expect(html(render([]))).toContain("표시할 합성 계정이 없습니다.");
    openUsage(entries);
    click(old, "identity-map-back");
    expect(html(render(entries))).toContain('data-testid="identity-map-usages"');
  });

  it("does not accept retained actions after unmount cleanup", () => {
    const tree = render();
    const before = html(tree);
    for (const cleanup of hooks.cleanups.splice(0)) cleanup();
    click(tree, "identity-map-account");
    expect(html(render())).toBe(before);
  });

  it("allows same-scope back then reset using the latest state", () => {
    const tree = openUsage();
    click(tree, "identity-map-back");
    click(tree, "identity-map-reset");
    expect(html(render())).toContain('data-testid="identity-map-account"');
    expect(html(render())).not.toContain('data-testid="identity-map-issuer"');
  });

  it("binds Escape to the panel instead of a global window listener", () => {
    const tree = openUsage();
    expect(window.addEventListener).not.toHaveBeenCalledWith("keydown", expect.any(Function));
    const preventDefault = vi.fn();
    (tree.props.onKeyDown as (event: { key: string; defaultPrevented: boolean; preventDefault: () => void }) => void)({
      key: "Escape", defaultPrevented: false, preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(html(render())).toContain('data-testid="identity-map-issuer"');
  });

  it("does not act on a handled Escape", () => {
    const tree = openUsage();
    const preventDefault = vi.fn();
    (tree.props.onKeyDown as (event: { key: string; defaultPrevented: boolean; preventDefault: () => void }) => void)({
      key: "Escape", defaultPrevented: true, preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(html(render())).toContain('data-testid="identity-map-usages"');
  });

  it("restores focus once after the selected account control is removed", () => {
    const tree = render();
    const focus = focusFixture(tree);
    click(tree, "identity-map-account", focus.element);
    focus.trigger.isConnected = false;
    focus.owner.activeElement = focus.owner.body;
    render();
    expect(focus.target.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    render();
    expect(focus.target.focus).toHaveBeenCalledTimes(1);
  });

  it.each(["another control", "still mounted", "unfocused trigger"])("does not steal focus: %s", (condition) => {
    const tree = render();
    const focus = focusFixture(tree);
    if (condition === "unfocused trigger") focus.owner.activeElement = focus.owner.body;
    click(tree, "identity-map-account", focus.element);
    focus.trigger.isConnected = condition === "still mounted";
    focus.owner.activeElement = condition === "another control" ? {} : focus.owner.body;
    render();
    expect(focus.target.focus).not.toHaveBeenCalled();
  });

  it("does not restore old focus after input replacement", () => {
    const tree = render();
    const focus = focusFixture(tree);
    click(tree, "identity-map-account", focus.element);
    focus.trigger.isConnected = false;
    focus.owner.activeElement = focus.owner.body;
    render([]);
    expect(focus.target.focus).not.toHaveBeenCalled();
  });

  it("a stale callback cannot erase a valid focus restoration in the same batch", () => {
    const old = render();
    const replacement = entries.map((entry) => ({ ...entry }));
    const tree = render(replacement);
    const focus = focusFixture(tree);
    click(tree, "identity-map-account", focus.element);
    click(old, "identity-map-step-account");
    focus.trigger.isConnected = false;
    focus.owner.activeElement = focus.owner.body;
    render(replacement);
    expect(focus.target.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
});
