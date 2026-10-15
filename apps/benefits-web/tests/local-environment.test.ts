import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error The Node launcher is intentionally plain ESM, outside browser source.
import { localEnvironment } from "../scripts/local-environment.mjs";

test("local launcher does not forward provider settings or Node injection options", () => {
  const env = localEnvironment({
    SystemRoot: "C:\\Windows", PATH: "synthetic-path", NODE_OPTIONS: "synthetic",
    VITE_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic",
    KEYATLAS_BENEFITS_MODE: "live", NITRO_HOST: "0.0.0.0", ARBITRARY: "synthetic",
  }, 4317);
  assert.deepEqual(Object.keys(env).sort(), [
    "HOST", "KEYATLAS_BENEFITS_MODE", "NITRO_HOST", "NITRO_PORT", "NODE_ENV",
    "PATH", "PORT", "SystemRoot",
  ].sort());
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.KEYATLAS_BENEFITS_MODE, "synthetic");
});

test("launcher rejects invalid listen ports", () => {
  for (const port of [0, 80, 1023, 65536, 4317.5, NaN, "4317"]) {
    assert.throws(() => localEnvironment({}, port), /Invalid local port/);
  }
});
