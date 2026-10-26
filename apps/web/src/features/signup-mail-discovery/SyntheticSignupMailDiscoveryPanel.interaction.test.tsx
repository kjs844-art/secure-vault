import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyntheticSignupMailDiscoveryPanel } from "./SyntheticSignupMailDiscoveryPanel";
import { SyntheticSignupMailDiscoverySession } from "./signupMailDiscovery";
import { DiscoveryInboxReview } from "../discovery-inbox/DiscoveryInboxReview";
import type { DiscoveryInboxAction, DiscoveryInboxView } from "../discovery-inbox/discoveryInboxModel";

// Direct callback/lifecycle unit tests. Native navigation and React scheduling
// remain separate browser evidence; these events do not prove actual bfcache.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  deferFunctional: false, deferred: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "synthetic-scope-heading",
  useRef<T,>(initial: T) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push({ current: initial });
    return hooks.values[slot] as { current: T };
  },
  useState<T,>(initial: T | (() => T)) {
    const slot = hooks.cursor++;
    if (slot >= hooks.values.length) hooks.values.push(typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.values[slot] as T, (next: T | ((previous: T) => T)) => {
      const apply = () => { hooks.values[slot] = typeof next === "function"
        ? (next as (previous: T) => T)(hooks.values[slot] as T) : next; };
      if (hooks.deferFunctional && typeof next === "function") hooks.deferred.push(apply);
      else apply();
    }];
  },
  useLayoutEffect(effect: () => void | (() => void), deps: unknown[]) {
    const slot = hooks.cursor++;
    const previous = hooks.values[slot] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    hooks.effects.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      hooks.values[slot] = { deps, ...(cleanup ? { cleanup } : {}) };
    });
  },
}));
type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result; }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    return predicate(node) ? node : find(node.props.children as ReactNode, predicate);
  }
  return undefined;
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : "";
}
function click(tree: ReactNode, label: string) {
  const control = find(tree, (element) => element.type === "button" && text(element.props.children as ReactNode) === label);
  if (!control) throw Error("Missing synthetic button: " + label);
  (control.props.onClick as () => void)();
}
function review(tree: ReactNode, action: DiscoveryInboxAction) {
  const panel = find(tree, (element) => element.type === DiscoveryInboxReview);
  if (!panel) throw Error("Missing synthetic review");
  (panel.props.onAction as (action: DiscoveryInboxAction) => void)(action);
}
function inbox(tree: ReactNode) { return find(tree, (element) => element.type === DiscoveryInboxReview)?.props.view as DiscoveryInboxView | undefined; }
function render() {
  hooks.cursor = 0;
  const tree = SyntheticSignupMailDiscoveryPanel();
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
function scan() {
  click(render(), "탐색 범위 미리보기");
  click(render(), "선택한 범위에 동의하고 탐색");
  return render();
}
function unmount() {
  for (const value of hooks.values) if (value && typeof value === "object" && "cleanup" in value) {
    (value as { cleanup: () => void }).cleanup();
  }
}
const confirm: DiscoveryInboxAction = { type: "set-confidence", id: "aurora-demo", confidence: "confirmed" };
let events: EventTarget;
let intervals: Map<number, () => void>;
let now: number;
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.deferFunctional = false; hooks.deferred = [];
  events = new EventTarget(); intervals = new Map(); now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    setInterval: (callback: () => void) => { intervals.set(1, callback); return 1; },
    clearInterval: (id: number) => { intervals.delete(id); },
  });
});
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("C06 owner and consent lifecycle callbacks", () => {
  it("selection changes revoke older prepare callbacks and capture checkbox values immediately", () => {
    const old = render();
    const checkbox = find(old, (element) => element.type === "input")!;
    const target = { checked: false };
    hooks.deferFunctional = true;
    (checkbox.props.onChange as (event: { target: typeof target }) => void)({ target });
    target.checked = true;
    for (const apply of hooks.deferred.splice(0)) apply();
    hooks.deferFunctional = false;
    const selected = render();
    click(old, "탐색 범위 미리보기");
    expect(text(render())).not.toContain("이 범위로 탐색할까요?");
    click(selected, "탐색 범위 미리보기");
    click(render(), "선택한 범위에 동의하고 탐색");
    expect(inbox(render())?.items.map((item) => item.id)).toEqual(["cedar-demo"]);
  });
  it("period changes revoke older prepare callbacks and use only the newly selected range", () => {
    const approve = vi.spyOn(SyntheticSignupMailDiscoverySession.prototype, "approve");
    const old = render();
    const select = find(old, (element) => element.type === "select")!;
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "7" } });
    const selected = render();
    click(old, "탐색 범위 미리보기");
    expect(text(render())).not.toContain("이 범위로 탐색할까요?");
    click(selected, "탐색 범위 미리보기");
    click(render(), "선택한 범위에 동의하고 탐색");
    const session = approve.mock.contexts[0];
    if (!(session instanceof SyntheticSignupMailDiscoverySession)) throw Error("Missing approved synthetic session");
    const preview = session.view().preview;
    expect(preview.to - preview.from).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it("requires preview and exact current consent before showing supplied candidates", () => {
    const initial = render();
    expect(inbox(initial)).toBeUndefined();
    click(initial, "탐색 범위 미리보기");
    const preview = render();
    expect(inbox(preview)).toBeUndefined();
    click(preview, "선택한 범위에 동의하고 탐색");
    const result = render();
    expect(inbox(result)?.items.map((item) => item.id)).toEqual(["aurora-demo", "cedar-demo"]);
  });
  it("cannot approve a new session using a retained previous consent callback", () => {
    click(render(), "탐색 범위 미리보기");
    const previous = render();
    click(previous, "범위 다시 선택");
    click(render(), "탐색 범위 미리보기");
    const current = render();
    click(previous, "선택한 범위에 동의하고 탐색");
    expect(inbox(render())).toBeUndefined();
    click(current, "선택한 범위에 동의하고 탐색");
    expect(inbox(render())?.items).toHaveLength(2);
  });
  it("cannot classify fresh same-ID candidates through a retained old session callback", () => {
    const old = scan();
    click(old, "범위 다시 선택");
    const current = scan();
    review(old, confirm);
    review(old, { type: "filter", filter: "dismissed" });
    expect(inbox(render())?.counts.confirmed).toBe(0);
    review(current, confirm);
    expect(inbox(render())?.counts.confirmed).toBe(1);
  });
  it("cancel clears candidates and retained review/consent/reset cannot resurrect them", () => {
    const old = scan();
    click(old, "후보 지우기");
    render();
    review(old, confirm);
    click(old, "범위 다시 선택");
    const cancelled = render();
    expect(inbox(cancelled)).toBeUndefined();
    expect(text(cancelled)).toContain("탐색을 취소하고 후보를 지웠습니다");
  });
  it("rejects an older same-session review callback after classification and filter changes", () => {
    const previous = scan();
    review(previous, { type: "set-confidence", id: "aurora-demo", confidence: "dismissed" });
    review(render(), { type: "filter", filter: "dismissed" });
    const current = render();
    review(previous, confirm);
    const unchanged = inbox(render());
    expect(unchanged?.filter).toBe("dismissed");
    expect(unchanged?.counts.dismissed).toBe(1);
    expect(unchanged?.counts.confirmed).toBe(0);
    review(current, confirm);
    expect(inbox(render())?.counts.confirmed).toBe(1);
  });
  it("rejects a second review action from one frame before the next commit", () => {
    const previous = scan();
    review(previous, { type: "set-confidence", id: "aurora-demo", confidence: "dismissed" });
    review(previous, confirm);
    expect(inbox(render())?.counts.dismissed).toBe(1);
    expect(inbox(render())?.counts.confirmed).toBe(0);
  });
  it("filter and classification do not extend expiry, including before the next polling tick", () => {
    const old = scan();
    now = 299999;
    review(old, confirm);
    review(render(), { type: "filter", filter: "confirmed" });
    expect(inbox(render())?.visible).toHaveLength(1);
    now = 300000;
    review(render(), { type: "filter", filter: "open" });
    expect(inbox(render())).toBeUndefined();
    now = 0;
    review(old, confirm);
    expect(inbox(render())).toBeUndefined();
  });
  it("polling at the deadline removes candidates without renewing the session", () => {
    scan(); now = 300000;
    for (const tick of intervals.values()) tick();
    expect(inbox(render())).toBeUndefined();
    expect(text(render())).toContain("확인 시간이 만료되어 후보를 지웠습니다");
  });
  it.each(["pagehide", "persisted pageshow"])("clears on %s and rejects previously retained callbacks", (kind) => {
    const old = scan();
    const event = new Event(kind === "pagehide" ? "pagehide" : "pageshow");
    if (kind !== "pagehide") Object.defineProperty(event, "persisted", { value: true });
    events.dispatchEvent(event);
    render();
    review(old, confirm);
    click(old, "범위 다시 선택");
    expect(inbox(render())).toBeUndefined();
    expect(text(render())).toContain("탐색 범위 미리보기");
  });
  it("non-persisted pageshow does not erase an active synthetic review", () => {
    scan();
    events.dispatchEvent(new Event("pageshow"));
    expect(inbox(render())?.items).toHaveLength(2);
  });
  it("unmount disposes the sole session and ignores late callbacks and events", () => {
    const approve = vi.spyOn(SyntheticSignupMailDiscoverySession.prototype, "approve");
    const confidence = vi.spyOn(SyntheticSignupMailDiscoverySession.prototype, "setConfidence");
    const old = scan();
    const session = approve.mock.contexts[0];
    if (!(session instanceof SyntheticSignupMailDiscoverySession)) throw Error("Missing approved synthetic session");
    unmount();
    expect(session.view().phase).toBe("disposed");
    expect(session.view().hints).toEqual([]);
    expect(intervals.size).toBe(0);
    review(old, confirm);
    events.dispatchEvent(new Event("pagehide"));
    expect(confidence).not.toHaveBeenCalled();
  });
});
