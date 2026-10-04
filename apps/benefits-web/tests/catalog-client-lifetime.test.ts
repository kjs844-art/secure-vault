import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import {
  CATALOG_VIEW_SCHEMA, createCatalogClient, createCatalogDeleteRequest, createCatalogGetRequest,
  MAX_CATALOG_RESPONSE_BODY_BYTES, type CatalogClientConfig,
} from "../src/domain/catalog-client/index.ts";

// Injected synthetic Fetch responses only; no live route, provider or user data.
const headers = { "content-type": "application/json", "cache-control": "private, no-store" };
const missing = JSON.stringify({ ok: false, code: "API_NOT_FOUND" });
const request = createCatalogGetRequest("synthetic-service");

function afterAbort(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function successResponse() {
  return new Response(JSON.stringify({ ok: true, value: {
    schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: "synthetic-service", serviceRevision: 1,
    state: "live", profile: { name: "합성 서비스", provider: null, planName: null, accountLabel: null,
      timezone: "Asia/Seoul", subscriptionStatus: "unknown", trialEndsAt: null, notes: null },
    createdAt: 1, updatedAt: 2, provenance: "user-reported", accountProof: "not-established",
  } }), { status: 200, headers });
}

test("a transport result after the deadline is discarded", { timeout: 2000 }, async () => {
  const call = createCatalogClient({ origin: "https://synthetic.local", timeoutMs: 20,
    fetch: async (_request, signal) => {
      await afterAbort(signal);
      return new Response(missing, { status: 404, headers });
    },
  });
  assert.deepEqual(await call(request), { kind: "timeout" });
});

test("response body completion after the deadline is discarded", { timeout: 2000 }, async () => {
  let cancelled = false;
  const call = createCatalogClient({ origin: "https://synthetic.local", timeoutMs: 20,
    fetch: async (_request, signal) => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        await afterAbort(signal);
        if (!cancelled) {
          controller.enqueue(new TextEncoder().encode(missing));
          controller.close();
        }
      },
      cancel() { cancelled = true; },
    }), { status: 404, headers }),
  });
  assert.deepEqual(await call(request), { kind: "timeout" });
});

test("malformed UTF-8 is a fixed invalid-body result", async () => {
  const call = createCatalogClient({ origin: "https://synthetic.local",
    fetch: async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200, headers }),
  });
  assert.deepEqual(await call(request), { kind: "invalid", reason: "BODY" });
});

test("crossing the byte ceiling cancels before consuming the trailing body", async () => {
  let trailingRead = false;
  let cancelled = false;
  let step = 0;
  const call = createCatalogClient({ origin: "https://synthetic.local",
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step++ === 0) controller.enqueue(new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES + 1));
        else {
          trailingRead = true;
          controller.enqueue(new Uint8Array([0]));
          controller.close();
        }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: 200, headers }),
  });
  assert.deepEqual(await call(request), { kind: "invalid", reason: "BODY" });
  assert.equal(trailingRead, false);
  assert.equal(cancelled, true);
});

test("a transport that ignores abort cannot hold the call open and its late body is cancelled",
  { timeout: 2000 }, async () => {
    let resolve!: (response: Response) => void;
    let calls = 0;
    let transportSignal!: AbortSignal;
    const call = createCatalogClient({ origin: "https://synthetic.local", timeoutMs: 20,
      fetch: (_request, signal) => {
        calls += 1;
        transportSignal = signal;
        return new Promise<Response>((done) => { resolve = done; });
      },
    });
    const result = await call(request);
    assert.deepEqual(result, { kind: "timeout" });
    assert.equal(transportSignal.aborted, true);
    assert.equal(calls, 1);
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { status: 404, headers });
    resolve(response);
    await setImmediate();
    assert.equal(cancelled, true);
    assert.equal(response.body!.locked, false);
    assert.deepEqual(result, { kind: "timeout" });
  });

test("a late transport rejection is handled without changing the timeout", { timeout: 2000 }, async () => {
  let reject!: (reason: unknown) => void;
  const call = createCatalogClient({ origin: "https://synthetic.local", timeoutMs: 20,
    fetch: () => new Promise<Response>((_resolve, fail) => { reject = fail; }),
  });
  const result = await call(request);
  assert.deepEqual(result, { kind: "timeout" });
  reject(new Error("synthetic-adapter-detail"));
  await setImmediate();
  assert.deepEqual(result, { kind: "timeout" });
});

test("a stalled body is cancelled and unlocked even when cancel acknowledgement never settles",
  { timeout: 2000 }, async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { cancelled = true; return new Promise<void>(() => undefined); },
    }, { highWaterMark: 0 }), { status: 404, headers });
    const call = createCatalogClient({ origin: "https://synthetic.local", timeoutMs: 20,
      fetch: async () => response,
    });
    assert.deepEqual(await call(request), { kind: "timeout" });
    await setImmediate();
    assert.equal(cancelled, true);
    assert.equal(response.body!.locked, false);
  });

test("the exact byte limit is accepted across chunks, with split UTF-8 decoding", async () => {
  const data = new TextEncoder().encode(await successResponse().text());
  const bytes = new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES);
  bytes.fill(32);
  bytes.set(data);
  // Split in the middle of the first Korean UTF-8 character, not at a code point.
  const split = data.findIndex((byte) => byte >= 128) + 1;
  assert.ok(split > 1);
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split, data.length));
      controller.enqueue(bytes.subarray(data.length));
      controller.close();
    },
  }), { status: 200, headers });
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async () => response });
  const result = await call(request);
  assert.equal(result.kind, "success");
  assert.ok(result.kind === "success" && result.success.kind === "view");
  assert.equal(result.success.view.profile!.name, "합성 서비스");
  assert.equal(response.body!.locked, false);
});

test("the cumulative byte limit stops before a third chunk", async () => {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(pulls === 1 ? MAX_CATALOG_RESPONSE_BODY_BYTES - 1 : 2));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 200, headers });
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async () => response });
  assert.deepEqual(await call(request), { kind: "invalid", reason: "BODY" });
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

test("many small body chunks do not accumulate abort listeners", async () => {
  const bytes = new TextEncoder().encode(await successResponse().text());
  let transportSignal!: AbortSignal;
  let baseline = 0;
  let maxListeners = 0;
  let offset = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      maxListeners = Math.max(maxListeners, getEventListeners(transportSignal, "abort").length);
      if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset));
      else controller.close();
    },
  }, { highWaterMark: 0 }), { status: 200, headers });
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async (_request, signal) => {
    transportSignal = signal;
    // A native Request can install its own forwarding listener before transport.
    baseline = getEventListeners(signal, "abort").length;
    return response;
  } });
  assert.equal((await call(request)).kind, "success");
  assert.equal(offset, bytes.length);
  assert.ok(maxListeners <= baseline + 1);
  assert.equal(getEventListeners(transportSignal, "abort").length, baseline);
  assert.equal(response.body!.locked, false);
});

test("body read failures expose only a fixed result and release the reader", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("synthetic-adapter-detail")); },
  }), { status: 200, headers });
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async () => response });
  assert.deepEqual(await call(request), { kind: "invalid", reason: "BODY" });
  assert.equal(response.body!.locked, false);
});

test("invalid response headers cancel the unused body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "content-type": "text/html", "cache-control": "no-store" } });
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async () => response });
  assert.deepEqual(await call(request), { kind: "invalid", reason: "HEADERS" });
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

test("an already-aborted caller never invokes the transport or echoes its reason", async () => {
  const caller = new AbortController();
  caller.abort(new Error("synthetic-private-caller-reason"));
  let calls = 0;
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async () => {
    calls += 1;
    return successResponse();
  } });
  assert.deepEqual(await call(request, caller.signal), { kind: "aborted" });
  assert.equal(calls, 0);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("caller cancellation during body reading discards and unlocks the response", { timeout: 2000 }, async () => {
  const caller = new AbortController();
  let cancelled = false;
  let transportSignal!: AbortSignal;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() { caller.abort(new Error("synthetic-private-caller-reason")); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 200, headers });
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async (_request, signal) => {
    transportSignal = signal;
    return response;
  } });
  assert.deepEqual(await call(request, caller.signal), { kind: "aborted" });
  assert.equal(transportSignal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("delayed timer dispatch cannot publish a response after the monotonic deadline", async () => {
  const call = createCatalogClient({ origin: "https://synthetic.local", timeoutMs: 10, fetch: async () => {
    const end = performance.now() + 30;
    while (performance.now() < end) { /* Controlled synthetic event-loop delay. */ }
    return successResponse();
  } });
  assert.deepEqual(await call(request), { kind: "timeout" });
});

test("caller listeners are removed on success, invalid input, transport failure, abort and timeout",
  { timeout: 2000 }, async () => {
    for (const outcome of ["success", "invalid", "failure", "abort", "timeout"] as const) {
      const caller = new AbortController();
      const fetch: CatalogClientConfig["fetch"] = async () => {
        if (outcome === "failure") throw new Error("synthetic-adapter-detail");
        if (outcome === "abort") caller.abort();
        if (outcome === "timeout") return new Promise<Response>(() => undefined);
        return outcome === "invalid"
          ? new Response(new Uint8Array([0xc3, 0x28]), { status: 200, headers }) : successResponse();
      };
      const call = createCatalogClient({ origin: "https://synthetic.local", fetch,
        timeoutMs: outcome === "timeout" ? 20 : 1000 });
      const result = await call(request, caller.signal);
      assert.equal(result.kind, outcome === "invalid" ? "invalid"
        : outcome === "failure" || outcome === "abort" ? "aborted" : outcome);
      if (outcome === "invalid") assert.deepEqual(result, { kind: "invalid", reason: "BODY" });
      assert.equal(getEventListeners(caller.signal, "abort").length, 0, outcome);
    }
  });

test("a completed call clears its timer and detaches from future caller aborts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  let transportSignal!: AbortSignal;
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async (_request, signal) => {
    transportSignal = signal;
    return successResponse();
  } });
  assert.equal((await call(request, caller.signal)).kind, "success");
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  t.mock.timers.tick(10000);
  caller.abort();
  assert.equal(transportSignal.aborted, false);
});

test("a manual mutation retry keeps the original command and operation id", async () => {
  const original = createCatalogDeleteRequest("synthetic-service", 1, "synthetic-operation");
  const bodies: unknown[] = [];
  const call = createCatalogClient({ origin: "https://synthetic.local", fetch: async (outbound) => {
    bodies.push(await outbound.json());
    if (bodies.length === 1) throw new DOMException("synthetic-abort", "AbortError");
    return new Response(missing, { status: 404, headers });
  } });
  assert.deepEqual(await call(original), { kind: "aborted" });
  assert.equal(bodies.length, 1);
  assert.deepEqual(await call(original), { kind: "error", code: "API_NOT_FOUND", retriableAfterMs: null });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies, [original.body, original.body]);
});
