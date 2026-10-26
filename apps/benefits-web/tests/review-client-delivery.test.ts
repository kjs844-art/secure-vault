import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { createReviewClient, createReviewGetRequest, createReviewPreviewRequest,
  type ReviewViewContext } from "../src/domain/review-client/index.ts";
import { createReviewPreviewDemoData } from "../src/lib/review-preview-demo-data.ts";

// Fetch-object regressions at the caller-delivery boundary. These deliberately
// exercise a context-reader side effect and owned cleanup notification; they do
// not make arbitrary trusted callbacks a sandbox. The injected now() here is a
// pure observation, never a callback that changes scope at its last invocation.
// This is not real auth, a mounted endpoint, a native browser or a durable DB.
const ORIGIN = "https://synthetic.invalid", NOW = 1790000000000;
const A = Object.freeze({ viewScope: "synthetic-delivery-a", dataGeneration: 1 });
const B = Object.freeze({ viewScope: "synthetic-delivery-b", dataGeneration: 1 });
const headers = { "content-type": "application/json", "cache-control": "private, no-store" };
function response(value: unknown) { return new Response(JSON.stringify({ ok: true, value }), { headers }); }
function sample() {
  const preview = createReviewPreviewDemoData("corrected-zero", NOW, 1);
  const command = createReviewPreviewRequest("synthetic-candidate", 1, preview.content.serviceId,
    preview.content.serviceRevision, preview.content.values);
  return { preview, command };
}

for (const offset of [-1, 0]) test(`last context read advances preview clock: expiry offset ${offset}`, async () => {
  const { preview, command } = sample();
  let baselineReads = 0;
  const baseline = createReviewClient({ origin: ORIGIN, now: () => NOW,
    readViewContext: () => { baselineReads++; return A; }, fetch: async () => response(preview) });
  assert.equal((await baseline(command)).kind, "success");
  assert.ok(baselineReads > 4, "observe the actual successful final read, not a guessed ordinal");

  let reads = 0, time = NOW, moved = false, transports = 0;
  const events: Array<{ port: "context" | "clock"; time: number }> = [];
  const client = createReviewClient({ origin: ORIGIN,
    readViewContext: () => {
      if (++reads === baselineReads) { time = preview.expiresAt + offset; moved = true; }
      events.push({ port: "context", time }); return A;
    },
    now: () => { events.push({ port: "clock", time }); return time; },
    fetch: async () => { transports++; return response(preview); },
  });
  const result = await client(command);
  assert.equal(reads, baselineReads); assert.equal(moved, true); assert.equal(transports, 1);
  assert.equal(events.filter((event) => event.port === "context").at(-1)!.time, preview.expiresAt + offset);
  if (offset < 0) assert.equal(result.kind, "success");
  else assert.deepEqual(result, { kind: "invalid", reason: "ENVELOPE" });
  // Even the valid expiry-minus-one case must sample time after the last reader.
  assert.equal(events.at(-1)!.port, "clock");
  assert.equal(events.at(-1)!.time, preview.expiresAt + offset);
});

test("owned transport abort cleanup changing scope suppresses the already decoded saved observation", async () => {
  let context: ReviewViewContext = A, abortEvents = 0, transports = 0;
  const tombstone = { schema: "keyatlas.reviewed-benefit-view.v1", dataGeneration: 1,
    benefitId: "synthetic-benefit", benefitRevision: 2, outcome: "deleted", content: null };
  const client = createReviewClient({ origin: ORIGIN, now: () => NOW, readViewContext: () => context,
    fetch: async (_request, signal) => {
      transports++;
      signal.addEventListener("abort", () => { abortEvents++; context = B; }, { once: true });
      return response(tombstone);
    },
  });
  const result = await client(createReviewGetRequest(tombstone.benefitId));
  assert.equal(abortEvents, 1); assert.equal(transports, 1); assert.equal(context, B);
  assert.deepEqual(result, { kind: "stale" });
});

test("caller abort during owned cleanup suppresses delivery and removes the caller listener", async () => {
  const caller = new AbortController();
  let abortEvents = 0, transports = 0;
  const tombstone = { schema: "keyatlas.reviewed-benefit-view.v1", dataGeneration: 1,
    benefitId: "synthetic-benefit", benefitRevision: 2, outcome: "deleted", content: null };
  const client = createReviewClient({ origin: ORIGIN, now: () => NOW, readViewContext: () => A,
    fetch: async (_request, signal) => {
      transports++;
      signal.addEventListener("abort", () => { abortEvents++; caller.abort("synthetic-cancel-during-cleanup"); }, { once: true });
      return response(tombstone);
    },
  });
  const result = await client(createReviewGetRequest(tombstone.benefitId), caller.signal);
  assert.equal(abortEvents, 1); assert.equal(transports, 1); assert.equal(caller.signal.aborted, true);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.deepEqual(result, { kind: "aborted" });
});

for (const offset of [-1, 0]) test(`owned cleanup advances preview clock before delivery: expiry offset ${offset}`, async () => {
  const { preview, command } = sample();
  let time = NOW, abortEvents = 0, transports = 0;
  const events: string[] = [];
  const client = createReviewClient({ origin: ORIGIN,
    readViewContext: () => { events.push("context"); return A; },
    now: () => { events.push("clock"); return time; },
    fetch: async (_request, signal) => {
      transports++;
      signal.addEventListener("abort", () => {
        abortEvents++; events.push("cleanup-abort"); time = preview.expiresAt + offset;
      }, { once: true });
      return response(preview);
    },
  });
  const result = await client(command);
  assert.equal(abortEvents, 1); assert.equal(transports, 1); assert.equal(time, preview.expiresAt + offset);
  if (offset < 0) assert.equal(result.kind, "success");
  else assert.deepEqual(result, { kind: "invalid", reason: "ENVELOPE" });
  const cleanup = events.indexOf("cleanup-abort");
  assert.ok(cleanup >= 0 && events.slice(cleanup + 1).includes("context"), "recheck scope after synchronous cleanup");
  assert.equal(events.at(-1), "clock", "the last user port observes wall time after cleanup and scope");
});
