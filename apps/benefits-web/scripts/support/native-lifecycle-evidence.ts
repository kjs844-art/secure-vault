// Pure test-runner evidence classification. No browser, clocks, identifiers,
// product behavior or error-counter mutation. The caller establishes document
// identity and retains bounded safe event samples separately when required.
export interface NativeLifecycleSample {
  readonly type: string;
  readonly trusted: boolean;
  readonly persisted: boolean | null;
  readonly open: string | null;
  readonly privateNodes: number;
}

export interface NativeLifecycleEvidence {
  readonly bfcacheObserved: boolean;
  readonly privacyObserved: "NOT_OBSERVED" | "CLOSED" | "EXPOSED";
  readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
}

export function classifyNativeLifecycleEvidence(
  sameDocument: boolean,
  events: readonly NativeLifecycleSample[],
): Readonly<NativeLifecycleEvidence> {
  // Events from another document cannot prove this document's lifecycle or
  // privacy. Empty evidence is not a successful privacy observation.
  const observed = sameDocument && events.length > 0;
  const bfcacheObserved = sameDocument && events.length === 2
    && events[0]?.type === "pagehide" && events[1]?.type === "pageshow"
    && events.every((event) => event.trusted === true && event.persisted === true);
  const privacyObserved = !observed ? "NOT_OBSERVED"
    : events.every((event) => event.open === "no" && event.privateNodes === 0) ? "CLOSED" : "EXPOSED";
  const status = privacyObserved === "EXPOSED" ? "FAIL"
    : bfcacheObserved && privacyObserved === "CLOSED" ? "PASS" : "INCONCLUSIVE";
  return Object.freeze({ bfcacheObserved, privacyObserved, status });
}
