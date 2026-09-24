import { describe, expect, it } from "vitest";

import { getCopy, locales } from "../copy/copyCatalog";
import {
  beginSave,
  canSave,
  changedFields,
  completeSave,
  createDirtyForm,
  editForm,
  failSave,
  formStatusText,
  isFormDirty,
  revertForm,
  shouldWarnBeforeLeaving,
  type FormValues,
} from "./dirtyFormModel";

type ConnectionForm = {
  label: string;
  environment: string;
  enabled: boolean;
  connectionIds: readonly number[];
  note: string | null;
};

const initial: ConnectionForm = {
  label: "예시 연결",
  environment: "development",
  enabled: true,
  connectionIds: [0, 2],
  note: null,
};

describe("createDirtyForm", () => {
  it("starts clean and idle", () => {
    const state = createDirtyForm(initial);
    expect(state.phase).toBe("idle");
    expect(state.pending).toBeNull();
    expect(isFormDirty(state)).toBe(false);
    expect(changedFields(state)).toEqual([]);
    expect(canSave(state)).toBe(false);
    expect(shouldWarnBeforeLeaving(state)).toBe(false);
  });

  it("copies and freezes the values so the caller cannot mutate them later", () => {
    const source = { tags: ["a"] as string[] };
    const state = createDirtyForm(source);
    source.tags.push("b");
    expect(state.current.tags).toEqual(["a"]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.current)).toBe(true);
    expect(Object.isFrozen(state.current.tags)).toBe(true);
  });

  it("rejects values the comparison rules do not cover", () => {
    const bad: unknown[] = [
      { nested: { a: 1 } },
      { list: [{ a: 1 }] },
      { fn: () => 1 },
      { missing: undefined },
      { date: new Date(0) },
    ];
    for (const values of bad) {
      expect(() => createDirtyForm(values as FormValues)).toThrow(/must be a primitive/);
    }
    expect(() => createDirtyForm(new Map() as unknown as FormValues)).toThrow(
      "Form values must be a plain object.",
    );
    expect(() => createDirtyForm([] as unknown as FormValues)).toThrow(
      "Form values must be a plain object.",
    );
  });
});

describe("editing", () => {
  it("tracks changed fields and becomes clean again when an edit is undone", () => {
    const start = createDirtyForm(initial);
    const edited = editForm(start, { label: "새 이름", enabled: false });
    expect(changedFields(edited)).toEqual(["enabled", "label"]);
    expect(isFormDirty(edited)).toBe(true);
    expect(canSave(edited)).toBe(true);
    expect(shouldWarnBeforeLeaving(edited)).toBe(true);

    const undone = editForm(edited, { label: "예시 연결", enabled: true });
    expect(isFormDirty(undone)).toBe(false);
  });

  it("never mutates the previous state", () => {
    const start = createDirtyForm(initial);
    editForm(start, { label: "새 이름" });
    expect(start.current.label).toBe("예시 연결");
    expect(isFormDirty(start)).toBe(false);
  });

  it("compares arrays element by element and in order", () => {
    const start = createDirtyForm(initial);
    expect(isFormDirty(editForm(start, { connectionIds: [0, 2] }))).toBe(false);
    expect(changedFields(editForm(start, { connectionIds: [2, 0] }))).toEqual(["connectionIds"]);
    expect(changedFields(editForm(start, { connectionIds: [0] }))).toEqual(["connectionIds"]);
  });

  it("treats NaN as equal to NaN and 0 as equal to -0", () => {
    const start = createDirtyForm({ amount: Number.NaN, offset: 0 });
    expect(isFormDirty(editForm(start, { amount: Number.NaN, offset: -0 }))).toBe(false);
  });

  it("rejects unknown fields and unsupported values", () => {
    const start = createDirtyForm(initial);
    expect(() => editForm(start, { extra: "x" } as Partial<ConnectionForm>)).toThrow(
      'Unknown form field "extra".',
    );
    expect(() =>
      editForm(start, { note: { text: "x" } } as unknown as Partial<ConnectionForm>),
    ).toThrow(/must be a primitive/);
  });
});

describe("saving", () => {
  it("moves the baseline to the saved snapshot", () => {
    const edited = editForm(createDirtyForm(initial), { label: "새 이름" });
    const { state: saving, ticket } = beginSave(edited);
    expect(saving.phase).toBe("saving");
    expect(ticket.values.label).toBe("새 이름");
    expect(canSave(saving)).toBe(false);
    expect(shouldWarnBeforeLeaving(saving)).toBe(true);

    const saved = completeSave(saving, ticket.token);
    expect(saved.phase).toBe("idle");
    expect(saved.pending).toBeNull();
    expect(saved.baseline.label).toBe("새 이름");
    expect(isFormDirty(saved)).toBe(false);
  });

  it("keeps edits made while saving dirty against the saved snapshot", () => {
    const { state: saving, ticket } = beginSave(
      editForm(createDirtyForm(initial), { label: "첫 저장" }),
    );
    const editedDuringSave = editForm(saving, { label: "저장 중 수정" });
    const saved = completeSave(editedDuringSave, ticket.token);
    expect(saved.baseline.label).toBe("첫 저장");
    expect(saved.current.label).toBe("저장 중 수정");
    expect(changedFields(saved)).toEqual(["label"]);
  });

  it("ignores completions and failures for any token but the pending one", () => {
    const edited = editForm(createDirtyForm(initial), { label: "A" });
    const first = beginSave(edited);
    const afterFailure = failSave(first.state, first.ticket.token);
    const second = beginSave(editForm(afterFailure, { label: "B" }));

    // The first save's late answers must not touch the second save.
    expect(completeSave(second.state, first.ticket.token)).toBe(second.state);
    expect(failSave(second.state, first.ticket.token)).toBe(second.state);
    expect(completeSave(second.state, 999)).toBe(second.state);

    const saved = completeSave(second.state, second.ticket.token);
    expect(saved.baseline.label).toBe("B");
    // Once settled, a repeated completion is a no-op.
    expect(completeSave(saved, second.ticket.token)).toBe(saved);
  });

  it("keeps edits after a failure and allows a retry", () => {
    const edited = editForm(createDirtyForm(initial), { label: "새 이름" });
    const { state: saving, ticket } = beginSave(edited);
    const failed = failSave(saving, ticket.token);
    expect(failed.phase).toBe("failed");
    expect(failed.baseline.label).toBe("예시 연결");
    expect(failed.current.label).toBe("새 이름");
    expect(canSave(failed)).toBe(true);
    const retry = beginSave(failed);
    expect(retry.ticket.token).toBeGreaterThan(ticket.token);
  });

  it("refuses to start a second save or to save a clean form", () => {
    const { state: saving } = beginSave(editForm(createDirtyForm(initial), { label: "x" }));
    expect(() => beginSave(saving)).toThrow("A save is already in progress.");
    expect(() => beginSave(createDirtyForm(initial))).toThrow("There are no changes to save.");
  });
});

describe("revertForm", () => {
  it("discards edits and clears a failure", () => {
    const edited = editForm(createDirtyForm(initial), { label: "새 이름" });
    const { state: saving, ticket } = beginSave(edited);
    const reverted = revertForm(failSave(saving, ticket.token));
    expect(reverted.phase).toBe("idle");
    expect(isFormDirty(reverted)).toBe(false);
  });

  it("lets a pending save finish, which makes the reverted form dirty again", () => {
    const { state: saving, ticket } = beginSave(
      editForm(createDirtyForm(initial), { label: "저장한 값" }),
    );
    const reverted = revertForm(saving);
    expect(reverted.phase).toBe("saving");
    const saved = completeSave(reverted, ticket.token);
    expect(saved.baseline.label).toBe("저장한 값");
    expect(saved.current.label).toBe("예시 연결");
    expect(isFormDirty(saved)).toBe(true);
  });
});

describe("serialisation", () => {
  it("never writes field values when a state is logged as JSON", () => {
    const edited = editForm(
      createDirtyForm({ label: "DEMO_VALUE_ONLY_before", secretLike: "DEMO_VALUE_ONLY_x" }),
      { secretLike: "DEMO_VALUE_ONLY_after" },
    );
    const { state } = beginSave(edited);
    const json = JSON.stringify(state);
    expect(json).not.toContain("DEMO_VALUE_ONLY");
    expect(JSON.parse(json)).toEqual({ phase: "saving", changedFields: ["secretLike"] });
    expect(Object.keys(state)).not.toContain("toJSON");
  });
});

describe("formStatusText", () => {
  it.each(locales)("maps each phase to %s catalog wording", (locale) => {
    const copy = getCopy(locale);
    const clean = createDirtyForm(initial);
    const dirty = editForm(clean, { label: "x" });
    const { state: saving, ticket } = beginSave(dirty);
    expect(formStatusText(copy, clean)).toBeNull();
    expect(formStatusText(copy, dirty)).toBe(copy.form.unsavedChanges);
    expect(formStatusText(copy, saving)).toBe(copy.form.saving);
    expect(formStatusText(copy, failSave(saving, ticket.token))).toBe(copy.form.saveFailed);
  });
});
