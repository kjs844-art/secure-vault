export type UnsavedChangesTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * Asks the browser to confirm before the page is closed or reloaded while
 * `shouldWarn` returns true. Browsers show their own generic wording. If the
 * check throws, the warning is shown: losing edits is worse than one prompt.
 * Returns an idempotent dispose function.
 */
export function bindUnsavedChangesWarning(
  shouldWarn: () => boolean,
  target: UnsavedChangesTarget = window,
): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    let warn = true;
    try {
      warn = shouldWarn();
    } catch {
      warn = true;
    }
    if (!warn) return;
    event.preventDefault();
    // Older browsers only prompt when returnValue is set.
    event.returnValue = true;
  };
  target.addEventListener("beforeunload", onBeforeUnload);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    target.removeEventListener("beforeunload", onBeforeUnload);
  };
}
