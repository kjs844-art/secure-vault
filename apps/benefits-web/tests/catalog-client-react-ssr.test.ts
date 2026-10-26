import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { createCatalogViewStore, type CatalogViewStore } from "../src/domain/catalog-client/view-store.ts";
import { useCatalogView } from "../src/hooks/useCatalogView.ts";
import { CATALOG_VIEW_SCHEMA } from "../src/domain/catalog-client/responses.ts";

function Screen({ store }: { store: CatalogViewStore }) {
  const view = useCatalogView(store, { bindingId: "synthetic-ssr", dataGeneration: 1 });
  return createElement("output", null, view.state === null ? "inactive" : JSON.stringify(view.state));
}

test("React SSR uses null snapshot, no controller activation or transport, with separate owners", () => {
  let calls = 0;
  const config = { origin: "https://synthetic.local", fetch: async () => { calls++; throw new Error("NO_SSR_FETCH"); } };
  const first = createCatalogViewStore(config), second = createCatalogViewStore(config);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    for (const store of [first, second]) {
      assert.equal(renderToString(createElement(StrictMode, null, createElement(Screen, { store }))), "<output>inactive</output>");
      assert.equal(store.getSnapshot(), null);
    }
    assert.equal(calls, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
    first.dispose(); second.dispose();
  }
});

test("SSR never serializes even a populated client store; rendering does not mutate it", async () => {
  const store = createCatalogViewStore({ origin: "https://synthetic.local", fetch: async () => new Response(JSON.stringify({
    ok: true, value: { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: "svc-ssr", serviceRevision: 1,
      state: "live", profile: { name: "Synthetic SSR marker", provider: null, planName: null, accountLabel: null,
        timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null },
      createdAt: 1, updatedAt: 1, provenance: "user-reported", accountProof: "not-established" },
  }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }) });
  const lease = store.activate({ bindingId: "synthetic-ssr", dataGeneration: 1 });
  assert.ok(lease);
  const prepared = store.prepare(lease, { action: "get", body: { serviceId: "svc-ssr" } });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") return;
  assert.equal((await store.execute(lease, prepared.command)).kind, "success");
  const before = store.getSnapshot();
  assert.equal(before?.state.entries[0]?.profile?.name, "Synthetic SSR marker");
  assert.equal(renderToString(createElement(Screen, { store })), "<output>inactive</output>");
  assert.equal(store.getSnapshot(), before);
  store.dispose();
});
