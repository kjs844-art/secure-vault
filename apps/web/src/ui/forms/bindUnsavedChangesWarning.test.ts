import { describe, expect, it, vi } from "vitest";

import { bindUnsavedChangesWarning, type UnsavedChangesTarget } from "./bindUnsavedChangesWarning";

class Target {
  listeners = new Set<EventListenerOrEventListenerObject>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (type === "beforeunload" && listener !== null) this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (type === "beforeunload" && listener !== null) this.listeners.delete(listener);
  }
  unload() {
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    for (const listener of this.listeners) {
      if (typeof listener === "function") listener(event as unknown as Event);
      else listener.handleEvent(event as unknown as Event);
    }
    return event;
  }
}

function bind(shouldWarn: () => boolean) {
  const target = new Target();
  const dispose = bindUnsavedChangesWarning(shouldWarn, target as unknown as UnsavedChangesTarget);
  return { target, dispose };
}

describe("bindUnsavedChangesWarning", () => {
  it("asks for confirmation only while there is something to lose", () => {
    let dirty = false;
    const { target } = bind(() => dirty);

    const quiet = target.unload();
    expect(quiet.preventDefault).not.toHaveBeenCalled();
    expect(quiet.returnValue).toBeUndefined();

    dirty = true;
    const warned = target.unload();
    expect(warned.preventDefault).toHaveBeenCalledOnce();
    expect(warned.returnValue).toBe(true);
  });

  it("warns when the check itself fails", () => {
    const { target } = bind(() => {
      throw new Error("state unavailable");
    });
    expect(target.unload().preventDefault).toHaveBeenCalledOnce();
  });

  it("removes its listener once, even if disposed twice", () => {
    const { target, dispose } = bind(() => true);
    expect(target.listeners.size).toBe(1);
    dispose();
    dispose();
    expect(target.listeners.size).toBe(0);
    expect(target.unload().preventDefault).not.toHaveBeenCalled();
  });
});
