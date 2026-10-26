import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCatalogCreateRequest, createCatalogGetRequest, createCatalogUpdateRequest,
  type CatalogServiceProfileInput,
} from "../src/domain/catalog-client/requests.ts";
import { CATALOG_VIEW_SCHEMA } from "../src/domain/catalog-client/responses.ts";
import { createCatalogViewController } from "../src/domain/catalog-client/view-controller.ts";

// Synthetic builder/controller contracts, not textarea/DOM evidence. Consumers
// must map exactly empty UI input to null before calling the builder; these tests
// deliberately do not reproduce that mapping. Rendering/escaping is tested by
// the component owner. No real HTTP, authentication, persistence or dedupe proof.
function profile() {
  return {
    name: "합성 메모 서비스", provider: "Synthetic provider", planName: "Synthetic trial",
    accountLabel: "Synthetic account", timezone: "Asia/Seoul", subscriptionStatus: "trial",
    trialEndsAt: "2028-02-29T12:34:56.123456789+09:00", notes: "원래 합성 메모",
  };
}

const inputError = { name: "Error", message: "CATALOG_INPUT_INVALID" };
const builders = [
  { name: "create", build: (input: CatalogServiceProfileInput) =>
    createCatalogCreateRequest("synthetic-notes-operation", input) },
  { name: "update", build: (input: CatalogServiceProfileInput) =>
    createCatalogUpdateRequest("synthetic-notes-service", 4, "synthetic-notes-operation", input) },
] as const;

for (const { name, build } of builders) {
  test(`${name} notes require null for absence and reject empty, padded and non-string input`, () => {
    assert.equal(build({ ...profile(), notes: null }).body.profile.notes, null);
    for (const notes of ["", " ", "\n", "\t", "\u00a0", " 메모", "메모 ", "\n메모", "메모\n",
      "\u3000메모", "메모\u00a0", undefined, false, 0, {}, []]) {
      assert.throws(() => build({ ...profile(), notes }), inputError);
    }
  });

  test(`${name} notes preserve internal LF, spaces, Unicode and markup as exact text values`, () => {
    for (const notes of ["첫째  줄\n\n둘째   줄", "메모\u00a0두 칸  끝", "합성 🚀 메모\n끝",
      '<b data-synthetic="true">문자 & 값</b>']) {
      assert.equal(build({ ...profile(), notes }).body.profile.notes, notes);
    }
  });

  test(`${name} notes enforce the 2048 UTF-16-unit boundary without splitting emoji`, () => {
    for (const notes of ["가".repeat(2048), "🚀".repeat(1024), `${"🚀".repeat(1023)}가나`]) {
      assert.equal(notes.length, 2048);
      assert.equal(build({ ...profile(), notes }).body.profile.notes, notes);
    }
    for (const notes of ["가".repeat(2049), `${"🚀".repeat(1024)}가`, "🚀".repeat(1025)]) {
      assert.ok(notes.length > 2048);
      assert.throws(() => build({ ...profile(), notes }), inputError);
    }
  });

  test(`${name} notes reject embedded CR, tabs, bidi controls and unpaired surrogates`, () => {
    const forbidden = ["\r", "\r\n", "\t", "\u0000", "\u000b", "\u001f", "\u007f", "\u0085",
      "\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
      "\u2066", "\u2067", "\u2068", "\u2069", "\ud800", "\udfff", "\udfff\ud800"];
    for (const control of forbidden) {
      assert.throws(() => build({ ...profile(), notes: `합성${control}메모` }), inputError);
    }
  });
}

test("notes-only update preserves all seven supplied non-notes fields and the original CAS target", () => {
  const original = profile();
  const otherFields = ["name", "provider", "planName", "accountLabel", "timezone", "subscriptionStatus", "trialEndsAt"] as const;
  for (const notes of ["수정한  합성 메모\n둘째 줄", null]) {
    const request = createCatalogUpdateRequest("synthetic-notes-service", 4, "synthetic-notes-operation",
      { ...original, notes });
    for (const key of otherFields) assert.equal(request.body.profile[key], original[key], key);
    assert.deepEqual(request.body, {
      serviceId: "synthetic-notes-service", expectedRevision: 4, operationId: "synthetic-notes-operation",
      decision: "update", profile: { ...original, notes },
    });
    assert.equal(original.notes, "원래 합성 메모");
  }
});

test("uncertain notes update replays the frozen original command after a newer profile is read", async () => {
  const original = { ...profile(), notes: "전송할  합성 메모\n원본 유지 🚀" };
  const request = createCatalogUpdateRequest("synthetic-notes-service", 4, "synthetic-notes-operation", original);
  const expectedBody = JSON.stringify(request.body);
  const latest = {
    name: "더 최근 합성 서비스", provider: "New synthetic provider", planName: "New synthetic plan",
    accountLabel: "New synthetic account", timezone: "UTC", subscriptionStatus: "active",
    trialEndsAt: null, notes: "다른 작업에서 바꾼 메모",
  };
  const currentRow = {
    schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: "synthetic-notes-service",
    serviceRevision: 9, state: "live", profile: latest, createdAt: 1, updatedAt: 9,
    provenance: "user-reported", accountProof: "not-established",
  };
  const paths: string[] = [];
  const updateBodies: string[] = [];
  function response(envelope: unknown, status = 200) {
    return new Response(JSON.stringify(envelope), {
      status, headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  const controller = createCatalogViewController({
    origin: "https://synthetic.local",
    fetch: async (incoming) => {
      const path = new URL(incoming.url).pathname;
      paths.push(path);
      assert.equal(incoming.method, "POST");
      if (path === "/api/catalog/get") return response({ ok: true, value: currentRow });
      assert.equal(path, "/api/catalog/update");
      updateBodies.push(await incoming.text());
      if (updateBodies.length === 1) return response({ ok: false, code: "API_UNAVAILABLE" }, 503);
      return response({ ok: true, value: {
        operationId: "synthetic-notes-operation", replayed: true, service: currentRow,
      } });
    },
  });
  try {
    assert.equal(controller.reset(1).kind, "active");
    const prepared = controller.prepare(request);
    assert.equal(prepared.kind, "prepared");
    if (prepared.kind !== "prepared") throw new Error("SYNTHETIC_NOTES_PREPARE_FAILED");
    // Later mutable form state must not replace any field in this command.
    original.notes = "아직 전송하지 않은 다른 메모";
    original.name = "아직 전송하지 않은 서비스명";
    assert.deepEqual(await controller.execute(prepared.command), {
      kind: "error", code: "API_UNAVAILABLE", retriableAfterMs: null,
    });
    assert.deepEqual(paths, ["/api/catalog/update"]);
    assert.deepEqual(updateBodies, [expectedBody]);

    const read = controller.prepare(createCatalogGetRequest("synthetic-notes-service"));
    assert.equal(read.kind, "prepared");
    if (read.kind !== "prepared") throw new Error("SYNTHETIC_NOTES_READ_PREPARE_FAILED");
    assert.equal((await controller.execute(read.command)).kind, "success");
    controller.release(read.command);
    assert.deepEqual(controller.snapshot()!.entries[0]!.profile, latest);

    const replay = await controller.execute(prepared.command);
    assert.equal(replay.kind, "success");
    if (replay.kind !== "success" || replay.success.kind !== "receipt") {
      throw new Error("SYNTHETIC_NOTES_REPLAY_FAILED");
    }
    assert.equal(replay.success.receipt.replayed, true);
    assert.deepEqual(paths, ["/api/catalog/update", "/api/catalog/get", "/api/catalog/update"]);
    assert.deepEqual(updateBodies, [expectedBody, expectedBody]);
    // A replay receipt reports current server state, not the historic notes.
    assert.deepEqual(replay.success.receipt.service.profile, latest);
    assert.deepEqual(controller.snapshot()!.entries[0]!.profile, latest);
    controller.release(prepared.command);
  } finally {
    controller.dispose();
  }
});
