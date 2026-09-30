import assert from "node:assert/strict";
import { test } from "node:test";
import { SCENARIO_CHECKS, runScenarioSuite, validateBaseUrl, validateEvidence } from "./qa-core.mjs";

// All observations and contexts below are mocks; no browser or I/O is invoked.
const PRIVATE_DETAIL = "SYNTHETIC_QA_PRIVATE_DETAIL";
const IDS = ["S1", "S2", "S3", "S4", "S5"];
const HASH = "0123456789abcdef".repeat(4);
const archive = (patch = {}) => ({ bytes: 3892, sha256: HASH, ...patch });
function evidence(id) {
  const checks = Object.fromEntries(SCENARIO_CHECKS[id].map((key) => [key, true]));
  const observations = id === "S1" || id === "S2" ? { before: archive(), after: archive(), reopened: archive() }
    : id === "S3" ? {} : id === "S4" ? { unlockedWidth: { client: 360, scroll: 360 }, lockedWidth: { client: 360, scroll: 360 } }
      : { before: archive(), after: archive(), versionBefore: 1, versionAfter: 99 };
  return { checks, observations };
}
function fixture() {
  const created = [];
  const runs = [];
  const closed = [];
  const scenarios = IDS.map((id) => ({ id, async run(context) { runs.push({ id, context }); return evidence(id); } }));
  const createContext = async () => {
    const context = { async close() { assert.equal(this, context); closed.push(context); } };
    created.push(context);
    return context;
  };
  return { scenarios, createContext, created, runs, closed };
}
function options(f) { return { scenarios: f.scenarios, createContext: f.createContext }; }
function checkError(error, code) {
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.ok(Object.isFrozen(error));
  assert.ok(!JSON.stringify(error).includes(PRIVATE_DETAIL));
  assert.ok(!error.stack.includes(PRIVATE_DETAIL));
  return true;
}
function invalid(action) { assert.throws(action, (error) => checkError(error, "INVALID_EVIDENCE")); }
function projected(result, id, status, code) {
  assert.deepEqual(Object.keys(result).sort(), ["code", "evidence", "id", "status"]);
  assert.equal(result.id, id);
  assert.equal(result.status, status);
  assert.equal(result.code, code);
  assert.ok(Object.isFrozen(result));
  assert.ok(!JSON.stringify(result).includes(PRIVATE_DETAIL));
}

test("scenario contract and nested check arrays are immutable", () => {
  assert.deepEqual(Object.keys(SCENARIO_CHECKS), IDS);
  assert.ok(Object.isFrozen(SCENARIO_CHECKS));
  for (const checks of Object.values(SCENARIO_CHECKS)) assert.ok(Object.isFrozen(checks));
  assert.deepEqual(SCENARIO_CHECKS.S1, ["archivePresent", "quotaReported", "archivePreserved", "reopenedFromStoredArchive"]);
  assert.deepEqual(SCENARIO_CHECKS.S2, ["privateDomRemoved", "reloadLocked", "archivePreserved", "reopenedFromStoredArchive"]);
  assert.deepEqual(SCENARIO_CHECKS.S3, ["enterLocked", "privateDomRemoved", "tabStayedOutsidePrivateControls"]);
  assert.deepEqual(SCENARIO_CHECKS.S4, ["unlockedNoHorizontalOverflow", "lockedNoHorizontalOverflow"]);
  assert.deepEqual(SCENARIO_CHECKS.S5, ["futureVersion", "incompatibleReported", "archivePreserved", "storeLayoutPreserved"]);
});
for (const port of [1, 80, 4173, 65535]) {
  test(`accepts only the original exact loopback URL at port ${port}`, () => {
    const url = `http://127.0.0.1:${port}/?view=local-vault`;
    assert.equal(validateBaseUrl(url), url);
  });
}
for (const url of [null, undefined, 4173, {}, "", "http://127.0.0.1/?view=local-vault",
  "http://127.0.0.1:0/?view=local-vault", "http://127.0.0.1:65536/?view=local-vault", "http://127.0.0.1:04173/?view=local-vault",
  "http://127.0.0.1:+4173/?view=local-vault", "https://127.0.0.1:4173/?view=local-vault",
  "http://localhost:4173/?view=local-vault", "http://[::1]:4173/?view=local-vault", "http://127.1:4173/?view=local-vault",
  "http://2130706433:4173/?view=local-vault", "http://0x7f000001:4173/?view=local-vault", "http://127.0.0.01:4173/?view=local-vault",
  "http://example.test:4173/?view=local-vault", "http://127.0.0.1.example.test:4173/?view=local-vault",
  "http://user@127.0.0.1:4173/?view=local-vault", "http://127.0.0.1:4173@other.test/?view=local-vault",
  "HTTP://127.0.0.1:4173/?view=local-vault", " http://127.0.0.1:4173/?view=local-vault",
  "http://127.0.0.1:4173/?view=local-vault\n", "http://127.0.0.1:4173/?view=local-vault#",
  "http://127.0.0.1:4173/?view=local-vault&other=1", "http://127.0.0.1:4173/?view=local-vault&view=local-vault",
  "http://127.0.0.1:4173/?view=%6cocal-vault", "http://127.0.0.1:4173?view=local-vault",
  "http://127.0.0.1:4173/./?view=local-vault", "http://127.0.0.1:4173/other/../?view=local-vault",
  "http:\\127.0.0.1:4173\\?view=local-vault", "http://127.0.0.1:4173//?view=local-vault"]) {
  test(`rejects unapproved URL spelling ${JSON.stringify(url)}`, () => {
    assert.throws(() => validateBaseUrl(url), (error) => checkError(error, "CONFIG"));
  });
}

for (const id of IDS) {
  test(`${id} returns a detached frozen exact evidence projection`, () => {
    const raw = evidence(id);
    const copy = validateEvidence(id, raw);
    assert.deepEqual(copy, raw);
    assert.notEqual(copy, raw);
    assert.notEqual(copy.checks, raw.checks);
    assert.notEqual(copy.observations, raw.observations);
    assert.ok(Object.isFrozen(copy));
    assert.ok(Object.isFrozen(copy.checks));
    assert.ok(Object.isFrozen(copy.observations));
    for (const [key, value] of Object.entries(copy.observations)) if (typeof value === "object") {
      assert.notEqual(value, raw.observations[key]);
      assert.ok(Object.isFrozen(value));
    }
    raw.checks[SCENARIO_CHECKS[id][0]] = false;
    assert.equal(copy.checks[SCENARIO_CHECKS[id][0]], true);
  });
  test(`${id} rejects missing evidence, unknown keys and non-boolean checks`, () => {
    for (const raw of [null, undefined, {}, { ...evidence(id), body: PRIVATE_DETAIL }, { checks: evidence(id).checks }]) invalid(() => validateEvidence(id, raw));
    for (const key of SCENARIO_CHECKS[id]) {
      const missing = evidence(id); delete missing.checks[key];
      invalid(() => validateEvidence(id, missing));
      for (const value of [1, 0, "true", null, undefined]) {
        const wrong = evidence(id); wrong.checks[key] = value;
        invalid(() => validateEvidence(id, wrong));
      }
    }
    const extra = evidence(id); extra.checks.note = PRIVATE_DETAIL;
    invalid(() => validateEvidence(id, extra));
    const other = evidence(id); other.observations.body = PRIVATE_DETAIL;
    invalid(() => validateEvidence(id, other));
  });
  test(`${id} rejects each missing required observation even when all checks are true`, () => {
    for (const key of Object.keys(evidence(id).observations)) {
      const raw = evidence(id); delete raw.observations[key];
      invalid(() => validateEvidence(id, raw));
    }
  });
}
test("S3 permits no observation body or unrelated allowed-scenario fields", () => {
  for (const value of [{ before: archive() }, { versionBefore: 1 }, PRIVATE_DETAIL, [], null]) {
    invalid(() => validateEvidence("S3", { checks: evidence("S3").checks, observations: value }));
  }
  invalid(() => validateEvidence("S6", evidence("S3")));
});
for (const bytes of [0, -1, 1.5, NaN, Infinity, 524289, "3892", null]) {
  test(`rejects invalid archive bytes ${String(bytes)}`, () => {
    const raw = evidence("S1"); raw.observations.before.bytes = bytes;
    invalid(() => validateEvidence("S1", raw));
  });
}
for (const sha256 of [HASH.toUpperCase(), "a".repeat(63), "a".repeat(65), "g".repeat(64), HASH + "\n", null, 1, PRIVATE_DETAIL]) {
  test(`rejects noncanonical archive digest ${String(sha256)}`, () => {
    const raw = evidence("S1"); raw.observations.before.sha256 = sha256;
    invalid(() => validateEvidence("S1", raw));
  });
}
for (const bytes of [1, 524288]) {
  test(`accepts exact archive size bound ${bytes}`, () => {
    const raw = evidence("S1");
    for (const item of Object.values(raw.observations)) item.bytes = bytes;
    assert.equal(validateEvidence("S1", raw).observations.before.bytes, bytes);
  });
}
for (const id of ["S1", "S2", "S5"]) {
  test(`${id} requires both digest and size preservation to agree with its check`, () => {
    for (const patch of [{ bytes: 3893 }, { sha256: "f".repeat(64) }]) {
      const raw = evidence(id); Object.assign(raw.observations.after, patch);
      invalid(() => validateEvidence(id, raw));
      raw.checks.archivePreserved = false;
      assert.equal(validateEvidence(id, raw).checks.archivePreserved, false);
    }
    const falseClaim = evidence(id); falseClaim.checks.archivePreserved = false;
    invalid(() => validateEvidence(id, falseClaim));
  });
}
for (const id of ["S1", "S2"]) {
  test(`${id} rejects a new/recreated archive as a successful reopen`, () => {
    const raw = evidence(id); raw.observations.reopened.sha256 = "f".repeat(64);
    invalid(() => validateEvidence(id, raw));
    raw.checks.reopenedFromStoredArchive = false;
    assert.equal(validateEvidence(id, raw).checks.reopenedFromStoredArchive, false);
  });
}
for (const dimension of [0, -1, 1.5, NaN, Infinity, 10001, "360", null]) {
  test(`rejects invalid viewport width ${String(dimension)}`, () => {
    for (const key of ["client", "scroll"]) {
      const raw = evidence("S4"); raw.observations.unlockedWidth[key] = dimension;
      invalid(() => validateEvidence("S4", raw));
    }
  });
}
test("S4 checks both viewport bounds and truthful overflow booleans", () => {
  const raw = evidence("S4");
  raw.observations.unlockedWidth = { client: 1, scroll: 10000 };
  invalid(() => validateEvidence("S4", raw));
  raw.checks.unlockedNoHorizontalOverflow = false;
  assert.equal(validateEvidence("S4", raw).checks.unlockedNoHorizontalOverflow, false);
  raw.checks.lockedNoHorizontalOverflow = false;
  invalid(() => validateEvidence("S4", raw));
});
for (const [field, value] of [["versionBefore", 0], ["versionBefore", 2], ["versionAfter", 1], ["versionAfter", 100],
  ["versionAfter", 99.5], ["versionAfter", NaN], ["versionAfter", "99"]]) {
  test(`S5 rejects ${field}=${String(value)} rather than accepting a success claim`, () => {
    const raw = evidence("S5"); raw.observations[field] = value;
    invalid(() => validateEvidence("S5", raw));
  });
}
test("evidence rejects nested extras/symbols/accessors without executing getters", () => {
  for (const select of [(raw) => raw, (raw) => raw.checks, (raw) => raw.observations, (raw) => raw.observations.before]) {
    const raw = evidence("S1");
    Object.defineProperty(select(raw), Symbol(PRIVATE_DETAIL), { value: PRIVATE_DETAIL });
    invalid(() => validateEvidence("S1", raw));
  }
  let getterCalls = 0;
  const raw = evidence("S1");
  Object.defineProperty(raw.observations.before, "sha256", { get() { getterCalls++; throw new Error(PRIVATE_DETAIL); }, enumerable: true });
  invalid(() => validateEvidence("S1", raw));
  assert.equal(getterCalls, 0);
});
test("unknown evidence exceptions never escape through messages, cause or error fields", () => {
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
    const raw = new Proxy(evidence("S1"), { [trap]() { throw new Error(PRIVATE_DETAIL); } });
    invalid(() => validateEvidence("S1", raw));
  }
});

test("successful suite runs all five in order and closes five distinct contexts", async () => {
  const f = fixture();
  const result = await runScenarioSuite(options(f));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(f.runs.map(({ id }) => id), IDS);
  assert.equal(new Set(f.created).size, 5);
  assert.deepEqual(f.closed, f.created);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.scenarios));
  for (const [index, row] of result.scenarios.entries()) projected(row, IDS[index], "PASS", "OK");
});
for (const [id, key] of [["S1", "quotaReported"], ["S2", "privateDomRemoved"], ["S3", "enterLocked"], ["S4", "unlockedNoHorizontalOverflow"], ["S5", "incompatibleReported"]]) {
  test(`${id} false required check never yields exit 0`, async () => {
    const f = fixture();
    f.scenarios.find((row) => row.id === id).run = async () => {
      const raw = evidence(id); raw.checks[key] = false;
      if (id === "S4") raw.observations.unlockedWidth.scroll = 361;
      return raw;
    };
    const result = await runScenarioSuite(options(f));
    assert.equal(result.exitCode, 1);
    projected(result.scenarios[IDS.indexOf(id)], id, "FAIL", "CHECK_FAILED");
    assert.equal(f.closed.length, 5);
  });
}
test("all failed scenarios still produce exit 1 rather than a successful process result", async () => {
  const f = fixture();
  for (const scenario of f.scenarios) scenario.run = async () => { throw new Error(PRIVATE_DETAIL); };
  const result = await runScenarioSuite(options(f));
  assert.equal(result.exitCode, 1);
  for (const [index, row] of result.scenarios.entries()) {
    projected(row, IDS[index], "FAIL", "SCENARIO_FAILED");
    assert.equal(row.evidence, null);
  }
  assert.equal(f.closed.length, 5);
});
for (const value of [undefined, null, {}, { status: "PASS", checks: {}, observations: {} }, PRIVATE_DETAIL, new Error(PRIVATE_DETAIL)]) {
  test(`invalid/missing scenario evidence is not a pass: ${typeof value}`, async () => {
    const f = fixture(); f.scenarios[0].run = async () => value;
    const result = await runScenarioSuite(options(f));
    assert.equal(result.exitCode, 1);
    projected(result.scenarios[0], "S1", "FAIL", "INVALID_EVIDENCE");
    assert.equal(result.scenarios[0].evidence, null);
    assert.equal(f.closed.length, 5);
  });
}
test("context creation exceptions become BLOCKED without raw exception text and later cases still run", async () => {
  const f = fixture(); const create = f.createContext;
  let calls = 0;
  f.createContext = async () => { if (calls++ === 1) throw new Error(PRIVATE_DETAIL); return create(); };
  const result = await runScenarioSuite(options(f));
  assert.equal(result.exitCode, 1);
  projected(result.scenarios[1], "S2", "BLOCKED", "CONTEXT_FAILED");
  assert.equal(f.runs.length, 4);
  assert.equal(f.closed.length, 4);
});
for (const context of [null, undefined, {}, { close: 1 }, [], "context", () => {}]) {
  test(`malformed context cannot run scenarios: ${typeof context}`, async () => {
    const f = fixture();
    const result = await runScenarioSuite({ scenarios: f.scenarios, createContext: async () => context });
    assert.equal(result.exitCode, 1);
    projected(result.scenarios[0], "S1", "BLOCKED", "CONTEXT_FAILED");
    assert.equal(f.runs.length, 0);
  });
}
test("reused context is rejected and not run/closed a second time", async () => {
  const f = fixture();
  const shared = await f.createContext();
  const result = await runScenarioSuite({ scenarios: f.scenarios, createContext: async () => shared });
  projected(result.scenarios[0], "S1", "PASS", "OK");
  for (let index = 1; index < IDS.length; index++) projected(result.scenarios[index], IDS[index], "FAIL", "CONTEXT_REUSED");
  assert.equal(result.exitCode, 1);
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.closed, [shared]);
});
test("cleanup failure overrides even valid successful evidence and never leaks details", async () => {
  const f = fixture(); let attempts = 0;
  const result = await runScenarioSuite({ scenarios: f.scenarios, createContext: async () => ({ close() { attempts++; throw new Error(PRIVATE_DETAIL); } }) });
  assert.equal(result.exitCode, 1);
  assert.equal(attempts, 5);
  assert.equal(f.runs.length, 5);
  for (const [index, row] of result.scenarios.entries()) {
    projected(row, IDS[index], "FAIL", "CLEANUP_FAILED");
    assert.equal(row.evidence, null);
  }
});
test("cleanup also runs after a scenario exception and an evidence validation exception", async () => {
  const f = fixture();
  f.scenarios[0].run = () => { throw new Error(PRIVATE_DETAIL); };
  f.scenarios[1].run = () => new Proxy({}, { ownKeys() { throw new Error(PRIVATE_DETAIL); } });
  const result = await runScenarioSuite(options(f));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(f.closed, f.created);
});
test("captures the close method before a scenario mutates its context", async () => {
  const f = fixture();
  f.scenarios[0].run = (context) => { context.close = () => { throw new Error(PRIVATE_DETAIL); }; return evidence("S1"); };
  const result = await runScenarioSuite(options(f));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(f.closed, f.created);
});
test("context close accessor failure is redacted and cannot run a scenario", async () => {
  const f = fixture();
  const result = await runScenarioSuite({ scenarios: f.scenarios, createContext: async () => ({ get close() { throw new Error(PRIVATE_DETAIL); } }) });
  assert.equal(result.exitCode, 1);
  assert.equal(f.runs.length, 0);
  for (const [index, row] of result.scenarios.entries()) projected(row, IDS[index], "BLOCKED", "CONTEXT_FAILED");
});
test("context revoked while reading close remains a fixed failure and attempts captured cleanup", async () => {
  const f = fixture(); let attempts = 0;
  const createContext = async () => {
    const target = { close() { attempts++; } };
    const pair = Proxy.revocable(target, {
      get(object, key) {
        if (key === "close") { pair.revoke(); return object.close; }
        return Reflect.get(object, key);
      },
    });
    return pair.proxy;
  };
  const result = await runScenarioSuite({ scenarios: f.scenarios, createContext });
  assert.equal(result.exitCode, 1);
  assert.equal(f.runs.length, 0);
  assert.equal(attempts, 5);
  for (const [index, row] of result.scenarios.entries()) projected(row, IDS[index], "BLOCKED", "CONTEXT_FAILED");
});
test("suite captures scenario configuration before any asynchronous caller mutation", async () => {
  const f = fixture(); const create = f.createContext;
  f.createContext = async () => {
    f.scenarios[1].run = () => { throw new Error(PRIVATE_DETAIL); };
    f.scenarios.reverse();
    return create();
  };
  const result = await runScenarioSuite(options(f));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.scenarios.map(({ id }) => id), IDS);
});
const badConfigurations = [
  ["missing scenario", (f) => ({ ...options(f), scenarios: f.scenarios.slice(0, 4) })],
  ["duplicate scenario", (f) => ({ ...options(f), scenarios: [f.scenarios[0], f.scenarios[0], ...f.scenarios.slice(2)] })],
  ["wrong order", (f) => ({ ...options(f), scenarios: f.scenarios.toReversed() })],
  ["extra scenario", (f) => ({ ...options(f), scenarios: [...f.scenarios, f.scenarios[0]] })],
  ["sparse array", (f) => ({ ...options(f), scenarios: Array(5) })],
  ["not array", (f) => ({ ...options(f), scenarios: Object.assign({}, f.scenarios) })],
  ["missing factory", (f) => ({ scenarios: f.scenarios })],
  ["bad factory", (f) => ({ ...options(f), createContext: null })],
  ["extra config", (f) => ({ ...options(f), note: PRIVATE_DETAIL })],
  ["extra scenario key", (f) => { f.scenarios[0].skip = true; return options(f); }],
  ["nonfunction run", (f) => { f.scenarios[0].run = null; return options(f); }],
  ["extra array key", (f) => { f.scenarios.note = PRIVATE_DETAIL; return options(f); }],
  ["symbol", (f) => Object.assign(options(f), { [Symbol(PRIVATE_DETAIL)]: true })],
  ["getter", (f) => Object.defineProperty(options(f), "createContext", { get() { throw new Error(PRIVATE_DETAIL); } })],
  ["throwing proxy", (f) => new Proxy(options(f), { ownKeys() { throw new Error(PRIVATE_DETAIL); } })],
];
for (const [name, make] of badConfigurations) {
  test(`invalid configuration fails before resources are created: ${name}`, async () => {
    const f = fixture();
    await assert.rejects(runScenarioSuite(make(f)), (error) => checkError(error, "CONFIG"));
    assert.equal(f.created.length, 0);
    assert.equal(f.runs.length, 0);
  });
}
