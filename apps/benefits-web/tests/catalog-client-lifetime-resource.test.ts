import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { CATALOG_VIEW_SCHEMA, createCatalogClient, createCatalogGetRequest } from "../src/domain/catalog-client/client.ts";

// Synthetic in-memory streams only. This measures the client's INTERNAL
// transport signal, separately from the supplied caller cancellation signal.
const context = Object.freeze({ viewScope: "synthetic-lifetime-resource", dataGeneration: 1 });
const headers = { "content-type": "application/json", "cache-control": "no-store" };
const chunkCount = 4096;
const errorAfterChunks = 2048;

function syntheticBody(): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ ok: true, value: {
    schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: "synthetic-service", serviceRevision: 1,
    state: "live", profile: { name: "합성 서비스", provider: null, planName: null, accountLabel: null,
      timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null },
    createdAt: 1, updatedAt: 1, provenance: "user-reported", accountProof: "not-established",
  } }));
  assert.ok(json.byteLength < errorAfterChunks);
  const body = new Uint8Array(chunkCount).fill(32);
  body.set(json);
  return body;
}

for (const outcome of ["success", "body-error"] as const) {
  test(`internal lifetime listeners stay bounded across one-byte chunks: ${outcome}`, { timeout: 5000 }, async () => {
    const bytes = syntheticBody();
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let baseline = 0;
    let peak = 0;
    let samples = 0;
    let offset = 0;
    let injectedErrors = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        assert.ok(transportSignal, "transport must capture its signal before body reads");
        const listeners = getEventListeners(transportSignal, "abort").length;
        peak = Math.max(peak, listeners);
        samples++;
        if (outcome === "body-error" && offset === errorAfterChunks) {
          injectedErrors++;
          controller.error(new Error("synthetic-private-stream-detail"));
          return;
        }
        if (offset === bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, ++offset));
      },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers });
    const client = createCatalogClient({
      origin: "https://synthetic.invalid",
      readViewContext: () => context,
      fetch: async (_request, signal) => {
        transportSignal = signal;
        assert.notEqual(signal, caller.signal);
        // A native Request can already have a forwarding listener here. Its
        // weak reference may be collected during the client's periodic yields.
        baseline = getEventListeners(signal, "abort").length;
        return response;
      },
    });

    const result = await client(createCatalogGetRequest("synthetic-service"), caller.signal);
    if (outcome === "success") {
      assert.ok(result.kind === "success" && result.success.kind === "view");
      assert.equal(result.success.view.profile?.name, "합성 서비스");
      assert.equal(offset, chunkCount);
      assert.equal(samples, chunkCount + 1);
      assert.equal(injectedErrors, 0);
    } else {
      assert.deepEqual(result, { kind: "invalid", reason: "BODY" });
      assert.equal(offset, errorAfterChunks);
      assert.equal(samples, errorAfterChunks + 1);
      assert.equal(injectedErrors, 1);
    }
    assert.ok(peak <= baseline + 1, `internal listener peak ${peak} exceeded baseline ${baseline} plus one wait`);
    assert.ok(transportSignal);
    assert.ok(getEventListeners(transportSignal, "abort").length <= baseline,
      "settled reads must not retain additional internal abort listeners");
    assert.equal(getEventListeners(caller.signal, "abort").length, 0,
      "caller listener cleanup is separate from the internal per-read listener bound");
    assert.equal(body.locked, false);
    assert.equal(transportSignal.aborted, false);
  });
}
