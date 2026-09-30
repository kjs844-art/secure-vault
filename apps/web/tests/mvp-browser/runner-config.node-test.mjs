import assert from "node:assert/strict";
import test from "node:test";
import { main, parseCli } from "./local-vault-qa.mjs";

test("CLI requires explicit synthetic acknowledgement and exact options", () => {
  assert.deepEqual(parseCli(["--synthetic-only"]), { baseUrl: "http://127.0.0.1:4173/?view=local-vault" });
  assert.deepEqual(parseCli(["--base-url=http://127.0.0.1:4317/?view=local-vault", "--synthetic-only"]),
    { baseUrl: "http://127.0.0.1:4317/?view=local-vault" });
  for (const args of [[], ["--synthetic-only", "--synthetic-only"], ["--profile=personal"],
    ["--synthetic-only", "--profile=personal"], ["--synthetic-only", "--base-url=https://example.invalid/"],
    ["--synthetic-only", "--base-url=http://127.0.0.1:4173/?view=local-vault#extra"],
    ["--synthetic-only", "--restore"], ["--synthetic-only", "--cdp=9222"],
    ["--synthetic-only", "--base-url=http://127.0.0.1:4173/?view=local-vault", "--extra"], null]) {
    assert.throws(() => parseCli(args), { message: "CONFIG" });
  }
});

test("bad arguments return BLOCKED and cannot create a passing run", async () => {
  assert.deepEqual(await main(["--synthetic-only", "--profile=personal"]),
    { status: "BLOCKED", code: "CONFIG", exitCode: 2, reportPath: null });
});
