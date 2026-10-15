/**
 * Pure synthetic QA reporting core. No browser, filesystem, network or clock.
 * Valid evidence is internally consistent, not proof that a mock or runner told
 * the truth. Browser actions/timeouts and actual observations belong to callers.
 */
export const SCENARIO_CHECKS = Object.freeze({
  S1: Object.freeze(["archivePresent", "quotaReported", "archivePreserved", "reopenedFromStoredArchive"]),
  S2: Object.freeze(["privateDomRemoved", "reloadLocked", "archivePreserved", "reopenedFromStoredArchive"]),
  S3: Object.freeze(["enterLocked", "privateDomRemoved", "tabStayedOutsidePrivateControls"]),
  S4: Object.freeze(["unlockedNoHorizontalOverflow", "lockedNoHorizontalOverflow"]),
  S5: Object.freeze(["futureVersion", "incompatibleReported", "archivePreserved", "storeLayoutPreserved"]),
});
const IDS = Object.freeze(Object.keys(SCENARIO_CHECKS));
const OBSERVATION_KEYS = Object.freeze({
  S1: ["before", "after", "reopened"],
  S2: ["before", "after", "reopened"],
  S3: [],
  S4: ["unlockedWidth", "lockedWidth"],
  S5: ["before", "after", "versionBefore", "versionAfter"],
});

function fixedError(code) {
  return Object.freeze(Object.assign(new Error(code), { code }));
}
function invalid() { throw fixedError("INVALID_EVIDENCE"); }
function fields(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function archive(value) {
  const raw = fields(value, ["bytes", "sha256"]);
  const bytes = integer(raw.bytes, 1, 524288);
  if (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256) || raw.sha256.length !== 64) invalid();
  return Object.freeze({ bytes, sha256: raw.sha256 });
}
function width(value) {
  const raw = fields(value, ["client", "scroll"]);
  return Object.freeze({ client: integer(raw.client, 1, 10000), scroll: integer(raw.scroll, 1, 10000) });
}
function sameArchive(left, right) { return left.bytes === right.bytes && left.sha256 === right.sha256; }

/** Accept the original spelling only; URL normalization cannot widen this gate. */
export function validateBaseUrl(value) {
  if (typeof value !== "string") throw fixedError("CONFIG");
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/\?view=local-vault$/u.exec(value);
  if (!match || match[0] !== value || Number(match[1]) > 65535) throw fixedError("CONFIG");
  return value;
}

/** Exact, detached projection: no raw errors, HTML, labels or arbitrary strings. */
export function validateEvidence(id, value) {
  try {
    if (!IDS.includes(id)) invalid();
    const raw = fields(value, ["checks", "observations"]);
    const rawChecks = fields(raw.checks, SCENARIO_CHECKS[id]);
    const checks = {};
    for (const name of SCENARIO_CHECKS[id]) {
      if (typeof rawChecks[name] !== "boolean") invalid();
      checks[name] = rawChecks[name];
    }
    const observed = fields(raw.observations, OBSERVATION_KEYS[id]);
    const observations = {};
    for (const name of OBSERVATION_KEYS[id]) {
      observations[name] = name === "before" || name === "after" || name === "reopened" ? archive(observed[name])
        : name === "unlockedWidth" || name === "lockedWidth" ? width(observed[name])
        : integer(observed[name], 1, 99);
    }
    if (id === "S1" || id === "S2" || id === "S5") {
      if (checks.archivePreserved !== sameArchive(observations.before, observations.after)) invalid();
    }
    if (id === "S1" || id === "S2") {
      if (checks.reopenedFromStoredArchive !== sameArchive(observations.before, observations.reopened)) invalid();
    }
    if (id === "S1" && !checks.archivePresent) invalid();
    if (id === "S4") {
      if (checks.unlockedNoHorizontalOverflow !== (observations.unlockedWidth.scroll <= observations.unlockedWidth.client)
        || checks.lockedNoHorizontalOverflow !== (observations.lockedWidth.scroll <= observations.lockedWidth.client)) invalid();
    }
    if (id === "S5" && (observations.versionBefore !== 1 || observations.versionAfter !== 99 || !checks.futureVersion)) invalid();
    return Object.freeze({ checks: Object.freeze(checks), observations: Object.freeze(observations) });
  } catch {
    // Even a descriptor/prototype proxy exception is untrusted and discarded.
    throw fixedError("INVALID_EVIDENCE");
  }
}

function configuration(options) {
  try {
    const raw = fields(options, ["scenarios", "createContext"]);
    if (typeof raw.createContext !== "function" || !Array.isArray(raw.scenarios)
      || Object.getPrototypeOf(raw.scenarios) !== Array.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw.scenarios);
    if (descriptors.length?.value !== IDS.length || Reflect.ownKeys(descriptors).length !== IDS.length + 1) invalid();
    const scenarios = IDS.map((id, index) => {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
      const row = fields(descriptor.value, ["id", "run"]);
      if (row.id !== id || typeof row.run !== "function") invalid();
      return Object.freeze({ id, run: row.run });
    });
    return { scenarios, createContext: raw.createContext };
  } catch { throw fixedError("CONFIG"); }
}

/**
 * Contexts are request-local owned resources; each distinct returned context is
 * closed once, including after a run/validation failure. A reused context is
 * never run or closed again. A malformed context cannot promise usable cleanup.
 */
export async function runScenarioSuite(options) {
  const config = configuration(options);
  const seen = new WeakSet();
  const results = [];
  for (const scenario of config.scenarios) {
    let context;
    let close;
    let owned = false;
    let result = { id: scenario.id, status: "BLOCKED", code: "CONTEXT_FAILED", evidence: null };
    try {
      try { context = await config.createContext(); } catch { /* Fixed context failure below. */ }
      if (context !== null && typeof context === "object") {
        if (seen.has(context)) {
          result = { id: scenario.id, status: "FAIL", code: "CONTEXT_REUSED", evidence: null };
        } else {
          seen.add(context);
          owned = true;
          let usable = false;
          try {
            close = context.close;
            usable = !Array.isArray(context) && typeof close === "function";
          } catch { /* A hostile accessor or revoked proxy is not evidence. */ }
          if (usable) {
            let returned;
            let completed = false;
            try {
              returned = await scenario.run(context);
              completed = true;
            } catch {
              result = { id: scenario.id, status: "FAIL", code: "SCENARIO_FAILED", evidence: null };
            }
            if (completed) {
              try {
                const evidence = validateEvidence(scenario.id, returned);
                const passed = Object.values(evidence.checks).every((check) => check);
                result = { id: scenario.id, status: passed ? "PASS" : "FAIL", code: passed ? "OK" : "CHECK_FAILED", evidence };
              } catch {
                result = { id: scenario.id, status: "FAIL", code: "INVALID_EVIDENCE", evidence: null };
              }
            }
          }
        }
      }
    } finally {
      if (owned && typeof close === "function") {
        try { await close.call(context); }
        catch { result = { id: scenario.id, status: "FAIL", code: "CLEANUP_FAILED", evidence: null }; }
      }
    }
    results.push(Object.freeze(result));
  }
  return Object.freeze({ scenarios: Object.freeze(results), exitCode: results.every(({ status }) => status === "PASS") ? 0 : 1 });
}
