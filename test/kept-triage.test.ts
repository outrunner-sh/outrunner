import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearKeptTriage,
  KEPT_CHARS,
  KEPT_DETAILS,
  KEPT_ITEMS,
  KEPT_LEVELS,
  KeptTriageCache,
  NO_TRIAGE,
  rememberTriage,
  rememberTriageDetail,
  triageSnapshot,
  type KeptDetail,
  type KeptTriage,
} from "@/lib/triage/kept-triage";
import type { TriageItem, WorkItemNote } from "@/lib/triage/work-items";

/** localStorage, with a quota in characters when given one. */
class FakeStorage {
  readonly items = new Map<string, string>();
  private readonly quota: number;
  constructor(quota = Infinity) {
    this.quota = quota;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    let used = value.length;
    for (const [k, v] of this.items) if (k !== key) used += v.length;
    if (used > this.quota) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

function item(id: string, overrides: Partial<TriageItem> = {}): TriageItem {
  return {
    id,
    number: 42,
    projectId: "p1",
    title: `Item ${id}`,
    body: "What it is.",
    status: "triage",
    source: "app",
    sourceUrl: null,
    sourceRef: null,
    sourceAuthor: null,
    duplicateOf: null,
    workspaceId: null,
    prompt: null,
    triagedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    can: { triage: true, contribute: true },
    ...overrides,
  };
}

function note(id: string, itemId: string): WorkItemNote {
  return {
    id,
    itemId,
    body: "A note",
    source: "app",
    sourceUrl: null,
    author: null,
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

function detail(id: string): KeptDetail {
  return { item: item(id), notes: [note(`${id}-n1`, id)] };
}

function entry(overrides: Partial<KeptTriage> = {}): KeptTriage {
  return {
    items: [item("i1"), item("i2")],
    levels: { p1: "write" },
    orgLevel: "read",
    details: [detail("i1")],
    ...overrides,
  };
}

function cache(storage: FakeStorage) {
  return new KeptTriageCache(() => storage);
}

test("the list and the item opened outlive the page", () => {
  const storage = new FakeStorage();
  cache(storage).save(entry());

  // A reload: a new page, the same storage.
  const back = cache(storage).load()!;
  assert.deepEqual(back.items.map((i) => i.id), ["i1", "i2"]);
  assert.equal(back.items[0].title, "Item i1");
  assert.equal(back.items[0].can.triage, true);
  // Where items may be moved, for the pickers.
  assert.deepEqual(back.levels, { p1: "write" });
  assert.equal(back.orgLevel, "read");
  // The item opened, with its activity.
  assert.equal(back.details[0].item.id, "i1");
  assert.deepEqual(back.details[0].notes.map((n) => n.body), ["A note"]);
});

test("past the caps the tail goes: items, levels and opened items", () => {
  const storage = new FakeStorage();
  const many = Array.from({ length: KEPT_ITEMS + 2 }, (_, i) => item(`i${i}`));
  const levels = Object.fromEntries(Array.from({ length: KEPT_LEVELS + 2 }, (_, i) => [`p${i}`, "read" as const]));
  const details = Array.from({ length: KEPT_DETAILS + 2 }, (_, i) => detail(`d${i}`));
  cache(storage).save(entry({ items: many, levels, details }));

  const back = cache(storage).load()!;
  assert.equal(back.items.length, KEPT_ITEMS);
  assert.equal(back.items[0].id, "i0");
  assert.equal(Object.keys(back.levels).length, KEPT_LEVELS);
  assert.equal(back.details.length, KEPT_DETAILS);
  assert.equal(back.details[0].item.id, "d0");
});

test("one kept by an older build, or damaged, opens from the server, and is dropped", () => {
  const storage = new FakeStorage();
  storage.setItem("outrunner:triage", JSON.stringify({ v: 0, items: [] }));
  assert.equal(cache(storage).load(), null);
  storage.setItem("outrunner:triage", "{not json");
  assert.equal(cache(storage).load(), null);
  // An item missing what every reader needs: one with no id, and one with no
  // permissions to show it by.
  storage.setItem("outrunner:triage", JSON.stringify({ v: 1, items: [{ title: "x" }], levels: {}, orgLevel: null, details: [] }));
  assert.equal(cache(storage).load(), null);
  storage.setItem(
    "outrunner:triage",
    JSON.stringify({ v: 1, items: [{ ...item("i1"), can: undefined }], levels: {}, orgLevel: null, details: [] }),
  );
  assert.equal(cache(storage).load(), null);
  // A level this build doesn't know is damaged too.
  storage.setItem(
    "outrunner:triage",
    JSON.stringify({ v: 1, items: [item("i1")], levels: { p1: "admin" }, orgLevel: null, details: [] }),
  );
  assert.equal(cache(storage).load(), null);
  assert.equal(storage.getItem("outrunner:triage"), null);
});

test("a list too long to keep isn't kept, and no older list stands in for it", () => {
  const storage = new FakeStorage();
  cache(storage).save(entry());
  assert.ok(cache(storage).load());
  cache(storage).save(entry({ items: [item("i1", { body: "x".repeat(KEPT_CHARS) })] }));
  assert.equal(cache(storage).load(), null);
  assert.equal(storage.getItem("outrunner:triage"), null);
});

test("out of room nothing is kept, and no older list stands in for it", () => {
  const storage = new FakeStorage(10);
  assert.equal(cache(storage).save(entry()), null);
  assert.equal(storage.getItem("outrunner:triage"), null);
  assert.equal(cache(storage).load(), null);
});

test("signing out, or switching orgs, forgets everything", () => {
  const storage = new FakeStorage();
  const kept = cache(storage);
  kept.save(entry());
  kept.clear();
  assert.equal(storage.getItem("outrunner:triage"), null);
  assert.equal(kept.load(), null);
});

test("blocked storage keeps nothing and breaks nothing", () => {
  const kept = new KeptTriageCache(() => null);
  assert.equal(kept.save(entry()), null);
  assert.equal(kept.load(), null);
  kept.clear();
});

test("the page starts from the server's answer, never from the store while rendering", () => {
  // Nothing has been read here: what a server render — and so hydration — sees
  // is the empty snapshot, whatever this browser has kept (lib/client/store.ts).
  assert.deepEqual(NO_TRIAGE, { items: null, levels: {}, orgLevel: null });
  assert.equal(triageSnapshot(), NO_TRIAGE);
});

test("an answer is published and kept, and forgetting it clears both", () => {
  const storage = new FakeStorage();
  (globalThis as Record<string, unknown>).window = { localStorage: storage };

  const list = { items: [item("i1")], levels: { p1: "write" as const }, orgLevel: null };
  rememberTriage(list);
  rememberTriageDetail(detail("i1"));
  assert.equal(storage.getItem("outrunner:triage"), JSON.stringify({ v: 1, ...list, details: [detail("i1")] }));

  clearKeptTriage();
  assert.equal(storage.getItem("outrunner:triage"), null);
});
