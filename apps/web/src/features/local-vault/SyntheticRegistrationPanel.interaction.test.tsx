import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyntheticRegistrationPanel } from "./SyntheticRegistrationPanel";

// Invoke component event callbacks with stable mocked hook state. This is a
// unit-level interaction harness, not a DOM/browser/React scheduler test, and
// does not authenticate, encrypt, write IndexedDB, or prove lock/remount races.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "registration-unit",
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
function change(element: Node, value: string | boolean) {
  (element.props.onChange as (event: { currentTarget: { value: string; checked: boolean } }) => void)(
    { currentTarget: { value: typeof value === "string" ? value : "", checked: value === true } });
}
function submit(node: ReactNode) {
  const form = find(node, (element) => element.type === "form");
  if (!form) throw new Error("Missing form");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
}
function harness(entryCount = 3) {
  const register = vi.fn(async () => {});
  const render = () => {
    hooks.cursor = 0;
    return SyntheticRegistrationPanel({ session: { register }, entryCount });
  };
  return { register, render };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

describe("closed registration event callbacks (mocked hook unit tests)", () => {
  it.each([
    ["password_only", 1, "계정 식별자는 포함하지 않습니다"],
    ["password_with_identifier", 2, "계정 식별자 포함(원문 비표시)"],
  ] as const)("registers only the closed %s fixture after explicit consent", (kind, credentialId, explanation) => {
    const { render, register } = harness();
    let tree = render();
    change(control(tree, "registration-connection-2"), true);
    change(control(tree, "registration-acknowledgement"), true);
    change(control(tree, "registration-kind"), kind);
    tree = render();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Example Password Service");
    expect(html).toContain(explanation);
    expect(html).toContain("연결처 없이 저장");
    expect(html.match(/<input /g)).toHaveLength(1);
    expect(html.match(/<select /g)).toHaveLength(1);
    expect(html).not.toMatch(/type="(password|text|email)"|<textarea\b/);
    expect(html).not.toContain('data-testid="registration-profile"');
    expect(html).not.toContain('data-testid="registration-connection-');
    expect(control(tree, "registration-acknowledgement").props.checked).toBe(false);
    expect(control(tree, "registration-submit").props.disabled).toBe(true);
    submit(tree);
    expect(register).not.toHaveBeenCalled();
    change(control(tree, "registration-acknowledgement"), true);
    tree = render();
    expect(control(tree, "registration-submit").props.disabled).toBe(false);
    submit(tree);
    expect(register).toHaveBeenCalledExactlyOnceWith({ profileId: 2, credentialId, connectionIds: [] });
  });

  it.each(["profile", "connection", "kind"])("invalidates acknowledged consent synchronously on a %s change", (changed) => {
    const { render, register } = harness();
    let tree = render();
    change(control(tree, "registration-acknowledgement"), true);
    tree = render();
    expect(control(tree, "registration-submit").props.disabled).toBe(false);
    if (changed === "profile") change(control(tree, "registration-profile"), "1");
    if (changed === "connection") change(control(tree, "registration-connection-0"), true);
    if (changed === "kind") change(control(tree, "registration-kind"), "password_only");
    // Retain the previous render's handler: state must be invalid before rerender.
    submit(tree);
    expect(register).not.toHaveBeenCalled();
    tree = render();
    expect(control(tree, "registration-acknowledgement").props.checked).toBe(false);
    expect(control(tree, "registration-submit").props.disabled).toBe(true);
  });

  it("clears connections and consent when changing kinds and ignores old API control callbacks", () => {
    const { render, register } = harness();
    let tree = render();
    const staleConnection = control(tree, "registration-connection-0");
    const staleProfile = control(tree, "registration-profile");
    change(staleConnection, true);
    change(control(tree, "registration-acknowledgement"), true);
    change(control(tree, "registration-kind"), "password_only");
    change(staleConnection, true);
    change(staleProfile, "1");
    tree = render();
    change(control(tree, "registration-acknowledgement"), true);
    change(control(tree, "registration-kind"), "password_with_identifier");
    tree = render();
    expect(control(tree, "registration-acknowledgement").props.checked).toBe(false);
    change(control(tree, "registration-kind"), "api_key");
    tree = render();
    expect(control(tree, "registration-profile").props.value).toBe(0);
    for (const id of [0, 1, 2]) expect(control(tree, `registration-connection-${id}`).props.checked).toBe(false);
    expect(control(tree, "registration-acknowledgement").props.checked).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("preserves supported API profiles and connection order, and blocks duplicate stale submits", () => {
    const { render, register } = harness();
    let tree = render();
    change(control(tree, "registration-profile"), "1");
    change(control(tree, "registration-connection-2"), true);
    change(control(tree, "registration-connection-0"), true);
    change(control(tree, "registration-connection-1"), true);
    change(control(tree, "registration-acknowledgement"), true);
    tree = render();
    submit(tree);
    submit(tree);
    change(control(tree, "registration-kind"), "password_only");
    expect(register).toHaveBeenCalledExactlyOnceWith({ profileId: 1, credentialId: 0, connectionIds: [2, 0, 1] });
    tree = render();
    expect(control(tree, "registration-kind").props.value).toBe("api_key");
    expect(control(tree, "registration-submit").props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain("저장 확인 중");
  });

  it.each(["api_key", "password_only", "password_with_identifier"])("never submits %s at archive item capacity", (kind) => {
    const { render, register } = harness(128);
    let tree = render();
    change(control(tree, "registration-kind"), kind);
    change(control(tree, "registration-acknowledgement"), true);
    tree = render();
    expect(control(tree, "registration-submit").props.disabled).toBe(true);
    submit(tree);
    expect(register).not.toHaveBeenCalled();
  });

  it("ignores unknown closed choices without converting them into registration input", () => {
    const { render, register } = harness();
    let tree = render();
    change(control(tree, "registration-kind"), "custom");
    change(control(tree, "registration-profile"), "2");
    tree = render();
    expect(control(tree, "registration-kind").props.value).toBe("api_key");
    expect(control(tree, "registration-profile").props.value).toBe(0);
    expect(register).not.toHaveBeenCalled();
  });
});
