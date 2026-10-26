// Test-runner ownership only. The caller verifies exact route and POST before
// claiming, then retains that Request identity for later ERR_ABORTED matching.
export interface ExpectedAbortArm {
  readonly pending: boolean;
  claim(observedPage: object | null, observedStage: string): boolean;
}

export function createExpectedAbortArm(page: object, stage: string): Readonly<ExpectedAbortArm> {
  if (page === null || typeof page !== "object" || typeof stage !== "string" || stage.length === 0)
    throw new TypeError("Expected-abort arm requires a page object and a nonempty stage.");
  let pending = true;
  return Object.freeze({
    get pending() { return pending; },
    claim(observedPage: object | null, observedStage: string): boolean {
      if (!pending) return false;
      // A mismatching first attempt must not leave an allowance for a later
      // request. Neither page properties nor request/payload data are inspected.
      pending = false;
      return observedPage === page && observedStage === stage;
    },
  });
}
