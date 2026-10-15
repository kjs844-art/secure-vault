/**
 * Unsaved-change tracking for forms.
 *
 * Every transition returns a new frozen state. Fields are compared with the
 * last saved baseline, so undoing an edit makes the form clean again. Saves
 * carry a token: a completion or failure for anything but the pending save is
 * ignored, so a late response can never move the baseline.
 */

import type { CopyCatalog } from "../copy/copyCatalog";

export type FormPrimitive = string | number | boolean | null;
export type FormFieldValue = FormPrimitive | readonly FormPrimitive[];
/** Use a type alias, not an interface, so it satisfies the index signature. */
export type FormValues = Readonly<Record<string, FormFieldValue>>;

export type FormPhase = "idle" | "saving" | "failed";

export interface SaveTicket<T extends FormValues> {
  readonly token: number;
  readonly values: T;
}

export interface DirtyFormSummary {
  readonly phase: FormPhase;
  readonly changedFields: readonly string[];
}

export interface DirtyFormState<T extends FormValues> {
  readonly baseline: T;
  readonly current: T;
  readonly phase: FormPhase;
  readonly pending: SaveTicket<T> | null;
  readonly nextToken: number;
  /** Serialises a summary only, so logging a state never prints field values. */
  toJSON(): DirtyFormSummary;
}

function isPrimitive(value: unknown): value is FormPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  );
}

function freezeField(key: string, value: unknown): FormFieldValue {
  if (isPrimitive(value)) return value;
  if (Array.isArray(value) && value.every(isPrimitive)) {
    return Object.freeze([...value]);
  }
  throw new Error(`Form field "${key}" must be a primitive or an array of primitives.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeValues<T extends FormValues>(values: T): T {
  if (!isPlainObject(values)) {
    throw new Error("Form values must be a plain object.");
  }
  const copy: Record<string, FormFieldValue> = {};
  for (const [key, value] of Object.entries(values)) {
    copy[key] = freezeField(key, value);
  }
  return Object.freeze(copy) as T;
}

/** SameValueZero, so NaN equals NaN and 0 equals -0. */
function samePrimitive(a: FormPrimitive, b: FormPrimitive): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

function sameField(a: FormFieldValue, b: FormFieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const right: readonly FormPrimitive[] = b;
    return a.every((item: FormPrimitive, index) => samePrimitive(item, right[index] ?? null));
  }
  return samePrimitive(a as FormPrimitive, b as FormPrimitive);
}

function diffFields(baseline: FormValues, current: FormValues): string[] {
  return Object.keys(baseline)
    .filter((key) => !sameField(baseline[key] ?? null, current[key] ?? null))
    .sort();
}

function makeState<T extends FormValues>(
  fields: Omit<DirtyFormState<T>, "toJSON">,
): DirtyFormState<T> {
  const state = { ...fields } as DirtyFormState<T>;
  Object.defineProperty(state, "toJSON", {
    enumerable: false,
    value: (): DirtyFormSummary => ({
      phase: fields.phase,
      changedFields: diffFields(fields.baseline, fields.current),
    }),
  });
  return Object.freeze(state);
}

export function createDirtyForm<T extends FormValues>(initial: T): DirtyFormState<T> {
  const values = freezeValues(initial);
  return makeState({
    baseline: values,
    current: values,
    phase: "idle",
    pending: null,
    nextToken: 1,
  });
}

/** Applies a partial edit. Unknown fields are rejected rather than added. */
export function editForm<T extends FormValues>(
  state: DirtyFormState<T>,
  patch: Partial<T>,
): DirtyFormState<T> {
  if (!isPlainObject(patch)) {
    throw new Error("Form values must be a plain object.");
  }
  const next: Record<string, FormFieldValue> = { ...state.current };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(state.baseline, key)) {
      throw new Error(`Unknown form field "${key}".`);
    }
    next[key] = freezeField(key, value);
  }
  return makeState({ ...state, current: Object.freeze(next) as T });
}

export function changedFields<T extends FormValues>(state: DirtyFormState<T>): readonly string[] {
  return diffFields(state.baseline, state.current);
}

export function isFormDirty<T extends FormValues>(state: DirtyFormState<T>): boolean {
  return changedFields(state).length > 0;
}

export function canSave<T extends FormValues>(state: DirtyFormState<T>): boolean {
  return state.phase !== "saving" && isFormDirty(state);
}

/**
 * Starts saving the current values. Only one save may be pending; the UI
 * should disable its save control whenever `canSave` is false.
 */
export function beginSave<T extends FormValues>(
  state: DirtyFormState<T>,
): { readonly state: DirtyFormState<T>; readonly ticket: SaveTicket<T> } {
  if (state.phase === "saving") throw new Error("A save is already in progress.");
  if (!isFormDirty(state)) throw new Error("There are no changes to save.");
  const ticket: SaveTicket<T> = Object.freeze({ token: state.nextToken, values: state.current });
  return {
    state: makeState({ ...state, phase: "saving", pending: ticket, nextToken: state.nextToken + 1 }),
    ticket,
  };
}

/**
 * Marks the pending save as stored. The baseline becomes the saved snapshot,
 * so edits made while saving stay dirty. Other tokens are ignored.
 */
export function completeSave<T extends FormValues>(
  state: DirtyFormState<T>,
  token: number,
): DirtyFormState<T> {
  if (state.pending === null || state.pending.token !== token) return state;
  return makeState({ ...state, baseline: state.pending.values, phase: "idle", pending: null });
}

/** Marks the pending save as failed and keeps every edit. Other tokens are ignored. */
export function failSave<T extends FormValues>(
  state: DirtyFormState<T>,
  token: number,
): DirtyFormState<T> {
  if (state.pending === null || state.pending.token !== token) return state;
  return makeState({ ...state, phase: "failed", pending: null });
}

/** Discards local edits. A pending save keeps running. */
export function revertForm<T extends FormValues>(state: DirtyFormState<T>): DirtyFormState<T> {
  return makeState({
    ...state,
    current: state.baseline,
    phase: state.phase === "failed" ? "idle" : state.phase,
  });
}

/** Leaving now could lose edits or interrupt a save. */
export function shouldWarnBeforeLeaving<T extends FormValues>(state: DirtyFormState<T>): boolean {
  return state.phase === "saving" || isFormDirty(state);
}

/** Status line for the form, or null when there is nothing to say. */
export function formStatusText<T extends FormValues>(
  copy: CopyCatalog,
  state: DirtyFormState<T>,
): string | null {
  if (state.phase === "saving") return copy.form.saving;
  if (state.phase === "failed") return copy.form.saveFailed;
  if (isFormDirty(state)) return copy.form.unsavedChanges;
  return null;
}
