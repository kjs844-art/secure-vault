import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoveryInboxPanel } from "./DiscoveryInboxPanel";
import type { DiscoveryInboxItem } from "./discoveryInboxModel";

// These tests exercise the component's callbacks and reducer state, not React's
// scheduler or a browser DOM. Real rerender/click checks remain a separate gate.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo<T,>(factory: () => T, dependencies: readonly unknown[]) {
    const slot = hooks.cursor++;
    const previous = hooks.values[slot] as { value: T; dependencies: readonly unknown[] } | undefined;
    if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
      hooks.values[slot] = { value: factory(), dependencies };
    }
    return (hooks.values[slot] as { value: T }).value;
  },
  useRef<T,>(initial: T) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push({ current: initial });
    return hooks.values[slot] as { current: T };
  },
  useLayoutEffect(effect: () => void) { hooks.effects.push(effect); },
  useState<T,>(initial: T | (() => T)) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push(typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.values[slot] as T, (next: T | ((previous: T) => T)) => {
      hooks.values[slot] = typeof next === "function" ? (next as (previous: T) => T)(hooks.values[slot] as T) : next;
    }];
  },
}));

function fixture(serviceName: string): readonly DiscoveryInboxItem[] {
  return [{ id: "synthetic-shared-id", serviceName, accountHint: "synthetic account", confidence: "needs_review",
    sourceKind: "manual", sourceLabel: "synthetic only", observedOn: "2026-10-27", note: "synthetic evidence" }];
}
function find(node: ReactNode, id: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const match = find(child, id); if (match) return match; }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    return node.props["data-testid"] === id ? node : find(node.props.children as ReactNode, id);
  }
  return undefined;
}
function click(tree: ReactNode, id: string) {
  const control = find(tree, id);
  if (!control) throw new Error(`Missing synthetic control ${id}`);
  (control.props.onClick as (event: { currentTarget: undefined }) => void)({ currentTarget: undefined });
}
function render(items: readonly DiscoveryInboxItem[], sourceLabel = "synthetic only") {
  hooks.cursor = 0;
  const tree = DiscoveryInboxPanel({ items, sourceLabel });
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
const html = (tree: ReactNode) => renderToStaticMarkup(tree);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

describe("DiscoveryInboxPanel refreshed input", () => {
  it("retains filter and confidence actions within the current input", () => {
    const items = fixture("Synthetic initial service");
    click(render(items), "discovery-filter-needs_review");
    expect(find(render(items), "discovery-filter-needs_review")?.props["aria-pressed"]).toBe(true);
    click(render(items), "discovery-action-confirmed");
    expect(html(render(items))).toContain("확인 필요 0건");
    click(render(items), "discovery-filter-confirmed");
    expect(html(render(items))).toContain("확인됨 1건");
  });

  it("applies the first post-refresh action to new rows even when IDs are reused", () => {
    const original = fixture("Synthetic old service");
    const replacement = fixture("Synthetic refreshed service");
    render(original);
    click(render(replacement), "discovery-action-dismissed");
    expect(html(render(replacement))).toContain("열린 항목 0건");
    click(render(replacement), "discovery-filter-dismissed");
    const result = html(render(replacement));
    expect(result).toContain("Synthetic refreshed service");
    expect(result).not.toContain("Synthetic old service");
    expect(result).toContain("오탐 1건");
  });

  it("preserves edits when only the source label changes", () => {
    const items = fixture("Synthetic service");
    click(render(items), "discovery-action-dismissed");
    expect(html(render(items, "renamed synthetic source"))).toContain("열린 항목 0건");
  });

  it("resets filter and edits across replacement, empty input, and A to B to A", () => {
    const original = fixture("Synthetic service A");
    const replacement = fixture("Synthetic service B");
    click(render(original), "discovery-action-dismissed");
    click(render(original), "discovery-filter-dismissed");
    expect(html(render(replacement))).toContain("열린 항목 1건");
    expect(html(render([]))).toContain("열린 항목 0건");
    expect(html(render(original))).toContain("열린 항목 1건");
  });

  it("ignores old callbacks after replacing rows with the same IDs", () => {
    const original = fixture("Synthetic service A");
    const replacement = fixture("Synthetic service B");
    const oldTree = render(original);
    render(replacement);
    click(oldTree, "discovery-action-dismissed");
    click(oldTree, "discovery-filter-dismissed");
    expect(html(render(replacement))).toContain("열린 항목 1건");
  });

  it("rejects old A callbacks after the identical A input array returns", () => {
    const original = fixture("Synthetic service A");
    const oldTree = render(original);
    render([]);
    render(original);
    click(oldTree, "discovery-action-dismissed");
    click(oldTree, "discovery-filter-dismissed");
    expect(html(render(original))).toContain("열린 항목 1건");
  });

  it("allows queued actions in one input generation to use the latest state", () => {
    const items = fixture("Synthetic service");
    const tree = render(items);
    click(tree, "discovery-action-dismissed");
    click(tree, "discovery-filter-dismissed");
    expect(html(render(items))).toContain("오탐 1건");
  });
});
