import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpBoundaryFailure, RequestLifetime } from "../src/server/http/request-lifetime.ts";

// Deterministic clock classification only. Real timers/aborts are exercised by
// catalog-http.test.ts; these tests do not establish database rollback behavior.
for (const scenario of [
  { name: "wall-only session tightening preserves original monotonic timeout", wall: 1010, mono: 60,
    notAfter: 1080, endWall: 1040, endMono: 100, code: "API_TIMEOUT" },
  { name: "monotonic-only session tightening preserves original wall timeout", wall: 1060, mono: 10,
    notAfter: 1120, endWall: 1100, endMono: 20, code: "API_TIMEOUT" },
  { name: "a tighter monotonic session limit keeps the session reason", wall: 1060, mono: 10,
    notAfter: 1120, endWall: 1080, endMono: 70, code: "API_SESSION_CHANGED" },
  { name: "a tighter wall session limit keeps the session reason", wall: 1010, mono: 60,
    notAfter: 1080, endWall: 1080, endMono: 80, code: "API_SESSION_CHANGED" },
]) {
  test(scenario.name, (t) => {
    let wall = 1000;
    let mono = 0;
    t.mock.method(performance, "now", () => mono);
    const life = new RequestLifetime(() => wall, new AbortController().signal, 100);
    try {
      wall = scenario.wall;
      mono = scenario.mono;
      life.tighten(scenario.notAfter, "API_SESSION_CHANGED");
      assert.equal(life.notAfter, Math.min(1100, scenario.notAfter));
      wall = scenario.endWall;
      mono = scenario.endMono;
      assert.throws(() => life.now(), (error: unknown) => {
        assert.ok(error instanceof HttpBoundaryFailure);
        assert.equal(error.code, scenario.code);
        return true;
      });
      assert.equal(life.signal.aborted, true);
    } finally { life.finish(); }
  });
}
