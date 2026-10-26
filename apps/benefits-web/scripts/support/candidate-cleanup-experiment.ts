// Test-runner build transform only. The caller must scope this to the exact
// candidate-batch-client.ts module; this pure helper has no module/path lookup.
export type CandidateCleanupExperimentMode = "observe" | "omit_perform_success_discard";
export const CANDIDATE_CLEANUP_EXPERIMENT_KEY = "__KEYATLAS_TEST_CANDIDATE_CLEANUP_EXPERIMENT__";
export const CANDIDATE_CLEANUP_EXPERIMENT_COUNTER_LIMIT = 1_000_000;

const ORIGINAL = "finally { life.close(completedSuccess); discard(response); }";

/**
 * Changes exactly one perform-cleanup site, or throws without returning source.
 * performSuccess is NOT final public success: the unchanged final-delivery fence
 * can still fail. Omission therefore also affects that later-failed path.
 * Both modes add synchronous measurement overhead; neither is a production fix
 * or proof of causality. Default builds must not call this opt-in transformer.
 */
export function transformCandidateCleanupExperiment(
  source: string,
  mode: CandidateCleanupExperimentMode,
): string {
  if (mode !== "observe" && mode !== "omit_perform_success_discard")
    throw new Error("Candidate cleanup experiment requires an explicit supported mode.");
  if (typeof source !== "string") throw new TypeError("Candidate cleanup experiment requires source text.");
  const index = source.indexOf(ORIGINAL);
  if (index < 0 || source.indexOf(ORIGINAL, index + ORIGINAL.length) >= 0)
    throw new Error("Candidate cleanup experiment requires exactly one original cleanup site.");

  // Preserve every byte outside the exact single-line site, including CRLF.
  // The replacement is plain JavaScript so tests can execute synthetic inputs
  // with Function without transpilation or importing any product implementation.
  const replacement = [
    "finally {",
    "      life.close(completedSuccess);",
    "      // TEST ONLY: performSuccess is not final public success; the final fence remains unchanged.",
    `      const probeKey = ${JSON.stringify(CANDIDATE_CLEANUP_EXPERIMENT_KEY)};`,
    "      const probeDescriptor = Object.getOwnPropertyDescriptor(globalThis, probeKey);",
    "      let probe;",
    "      if (probeDescriptor === undefined) {",
    "        probe = Object.seal({ performSuccess: 0, performOther: 0, discardInvoked: 0, discardOmitted: 0, overflow: false });",
    "        Object.defineProperty(globalThis, probeKey, { value: probe, configurable: true });",
    "      } else {",
    "        // Reject a colliding accessor/object instead of invoking hooks or retaining arbitrary data.",
    "        probe = probeDescriptor.value;",
    "        if (!(\"value\" in probeDescriptor) || probe === null || typeof probe !== \"object\"",
    "          || Object.getPrototypeOf(probe) !== Object.prototype || !Object.isSealed(probe)",
    "          || Reflect.ownKeys(probe).length !== 5)",
    "          throw new Error(\"Invalid test-only candidate cleanup counters.\");",
    "        for (const field of [\"performSuccess\", \"performOther\", \"discardInvoked\", \"discardOmitted\", \"overflow\"]) {",
    "          const descriptor = Object.getOwnPropertyDescriptor(probe, field);",
    "          if (descriptor === undefined || !(\"value\" in descriptor) || descriptor.writable !== true",
    `            || (field === "overflow" ? typeof descriptor.value !== "boolean" : !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > ${CANDIDATE_CLEANUP_EXPERIMENT_COUNTER_LIMIT}))`,
    "            throw new Error(\"Invalid test-only candidate cleanup counters.\");",
    "        }",
    "      }",
    "      const performCounter = completedSuccess === true ? \"performSuccess\" : \"performOther\";",
    `      if (probe[performCounter] < ${CANDIDATE_CLEANUP_EXPERIMENT_COUNTER_LIMIT}) probe[performCounter] += 1;`,
    "      else probe.overflow = true;",
    `      if (${mode === "omit_perform_success_discard" ? "completedSuccess === true" : "false"}) {`,
    `        if (probe.discardOmitted < ${CANDIDATE_CLEANUP_EXPERIMENT_COUNTER_LIMIT}) probe.discardOmitted += 1;`,
    "        else probe.overflow = true;",
    "      } else {",
    `        if (probe.discardInvoked < ${CANDIDATE_CLEANUP_EXPERIMENT_COUNTER_LIMIT}) probe.discardInvoked += 1;`,
    "        else probe.overflow = true;",
    "        discard(response);",
    "      }",
    "    }",
  ].join(source.includes("\r\n") ? "\r\n" : "\n");
  return source.slice(0, index) + replacement + source.slice(index + ORIGINAL.length);
}
