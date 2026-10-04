import { describe, expect, it } from "vitest";
import {
  buildDiscoveryInbox,
  emptyDiscoveryInboxView,
  reduceDiscoveryInbox,
} from "./discoveryInboxModel";
import { SYNTHETIC_DISCOVERY_INBOX_ITEMS } from "./syntheticDiscoveryInboxFixture";

describe("buildDiscoveryInbox", () => {
  it("returns an empty view for missing input", () => {
    expect(buildDiscoveryInbox(null).items).toEqual([]);
    expect(buildDiscoveryInbox(undefined).visible).toEqual([]);
    expect(Object.isFrozen(emptyDiscoveryInboxView())).toBe(true);
  });

  it("groups the closed fixture into open and confidence buckets", () => {
    const view = buildDiscoveryInbox(SYNTHETIC_DISCOVERY_INBOX_ITEMS);
    expect(view.filter).toBe("open");
    expect(view.items).toHaveLength(4);
    expect(view.visible).toHaveLength(4);
    expect(view.counts).toEqual({
      open: 4,
      confirmed: 1,
      inferred: 1,
      needs_review: 2,
      dismissed: 0,
    });
  });

  it("skips malformed or duplicate rows", () => {
    const view = buildDiscoveryInbox([
      SYNTHETIC_DISCOVERY_INBOX_ITEMS[0]!,
      SYNTHETIC_DISCOVERY_INBOX_ITEMS[0]!,
      {
        id: "",
        serviceName: "broken",
        accountHint: "x",
        confidence: "confirmed",
        sourceKind: "manual",
        sourceLabel: "x",
        observedOn: "2026-01-01",
        note: "x",
      },
    ]);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]!.id).toBe("demo-workshop-confirmed");
  });

  it("keeps only display fields when a source row carries extra private fields", () => {
    const source = {
      ...SYNTHETIC_DISCOVERY_INBOX_ITEMS[0]!,
      rawMailBody: "SYNTHETIC_PRIVATE_BODY",
      exportedCredential: "SYNTHETIC_PRIVATE_CREDENTIAL",
    };
    const view = buildDiscoveryInbox([source]);
    expect(view.items[0]).toEqual(SYNTHETIC_DISCOVERY_INBOX_ITEMS[0]);
    expect(JSON.stringify(view)).not.toContain("SYNTHETIC_PRIVATE_");
  });
});

describe("reduceDiscoveryInbox", () => {
  const start = buildDiscoveryInbox(SYNTHETIC_DISCOVERY_INBOX_ITEMS);

  it("does not promote a dismissed row back into open until restored", () => {
    const dismissed = reduceDiscoveryInbox(start, {
      type: "set-confidence",
      id: "demo-shop-false",
      confidence: "dismissed",
    });
    expect(dismissed.counts.dismissed).toBe(1);
    expect(dismissed.counts.open).toBe(3);
    expect(dismissed.visible.map((item) => item.id)).not.toContain("demo-shop-false");

    const onlyDismissed = reduceDiscoveryInbox(dismissed, { type: "filter", filter: "dismissed" });
    expect(onlyDismissed.visible).toHaveLength(1);
    expect(onlyDismissed.visible[0]!.id).toBe("demo-shop-false");

    const restored = reduceDiscoveryInbox(onlyDismissed, {
      type: "set-confidence",
      id: "demo-shop-false",
      confidence: "confirmed",
    });
    expect(restored.filter).toBe("dismissed");
    expect(restored.visible).toEqual([]);
    expect(restored.counts.confirmed).toBe(2);
  });

  it("ignores unknown ids and illegal confidence values", () => {
    expect(reduceDiscoveryInbox(start, {
      type: "set-confidence",
      id: "missing",
      confidence: "confirmed",
    })).toBe(start);
    expect(reduceDiscoveryInbox(start, {
      type: "set-confidence",
      id: "demo-lab-inferred",
      confidence: "not-a-state" as never,
    })).toBe(start);
  });

  it("reset returns to the open filter without dropping corrections", () => {
    const dismissed = reduceDiscoveryInbox(start, {
      type: "set-confidence",
      id: "demo-notes-review",
      confidence: "dismissed",
    });
    const filtered = reduceDiscoveryInbox(dismissed, { type: "filter", filter: "needs_review" });
    const reset = reduceDiscoveryInbox(filtered, { type: "reset" });
    expect(reset.filter).toBe("open");
    expect(reset.counts.dismissed).toBe(1);
    expect(reset.visible).toHaveLength(3);
  });
});
