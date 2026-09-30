import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyntheticVaultSession } from "./SyntheticVaultSession";
import { SyntheticToolPanel } from "./SyntheticToolPanel";
import { SyntheticVaultTools } from "./SyntheticVaultTools";

// Unit-level callback harness. This verifies the UI guard without claiming a
// DOM, IME, browser scheduler, or native paste test.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useState<T,>(initial: T | (() => T)) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push(typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.values[slot] as T, (next: T | ((previous: T) => T)) => {
      hooks.values[slot] = typeof next === "function" ? (next as (previous: T) => T)(hooks.values[slot] as T) : next;
    }];
  },
  useSyncExternalStore<T,>(_subscribe: (listener: () => void) => () => void, getSnapshot: () => T) {
    return getSnapshot();
  },
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

function required(node: ReactNode, match: (element: Node) => boolean, label: string): Node {
  const result = find(node, match);
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}

function harness() {
  const session = {
    state: { phase: "open", entries: [], errorCode: null },
    viewGeneration: 1,
    subscribe: () => () => {},
    lock: () => {},
  } as unknown as SyntheticVaultSession;
  const render = () => {
    hooks.cursor = 0;
    return SyntheticToolPanel({ session });
  };
  return { render };
}

function changeQuery(tree: ReactNode, value: string) {
  const input = required(tree, (element) => element.props.id === "local-tool-query", "query input");
  (input.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } });
}

function submit(tree: ReactNode) {
  const form = required(tree, (element) => element.type === "form", "search form");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
}

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  vi.restoreAllMocks();
});

describe("synthetic local tool search callbacks (mocked hook unit tests)", () => {
  it.each([
    ["Korean byte overflow", "가".repeat(43), "local-tool-query-limit", "128 UTF-8 바이트 한도", "검색어 129/128 UTF-8 bytes"],
    ["emoji byte overflow", "😀".repeat(33), "local-tool-query-limit", "128 UTF-8 바이트 한도", "검색어 132/128 UTF-8 bytes"],
    ["malformed Unicode", "\ud800", "local-tool-query-malformed", "올바르지 않은 유니코드", "검색어 3/128 UTF-8 bytes"],
  ])("blocks %s before dispatch and recovers after correction", (_label, query, errorId, message, byteCount) => {
    const execute = vi.spyOn(SyntheticVaultTools.prototype, "executeTool")
      .mockResolvedValue({ kind: "error", code: "NOT_READY" });
    const { render } = harness();
    let tree = render();
    changeQuery(tree, query);
    tree = render();

    const input = required(tree, (element) => element.props.id === "local-tool-query", "query input");
    const button = required(tree, (element) => element.type === "button" && element.props.type === "submit", "submit button");
    expect(input.props["aria-invalid"]).toBe(true);
    expect(input.props["aria-describedby"]).toContain(errorId);
    expect(button.props.disabled).toBe(true);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(message);
    expect(html).toContain(byteCount);
    submit(tree);
    expect(execute).not.toHaveBeenCalled();

    changeQuery(tree, "safe");
    tree = render();
    const correctedInput = required(tree, (element) => element.props.id === "local-tool-query", "query input");
    const correctedButton = required(tree,
      (element) => element.type === "button" && element.props.type === "submit", "submit button");
    expect(correctedInput.props["aria-invalid"]).toBe(false);
    expect(correctedInput.props["aria-describedby"]).not.toContain(errorId);
    expect(correctedButton.props.disabled).toBe(false);
    submit(tree);
    expect(execute).toHaveBeenCalledExactlyOnceWith({ op: "search_catalog", query: "safe" });
  });
});
