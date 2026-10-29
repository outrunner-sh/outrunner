import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Drafts,
  INTERRUPTED_UPLOAD,
  KEPT_CHARS,
  KEPT_DAYS,
  KEPT_DRAFTS,
  KEPT_TOTAL_CHARS,
  PAGE_ONLY,
  type PendingAttachment,
} from "@/lib/client/drafts";
import { restoreDraft } from "@/lib/runtime/attachments";

/** localStorage, with a quota in characters when given one. */
class FakeStorage {
  readonly items = new Map<string, string>();
  private readonly quota: number;
  constructor(quota = Infinity) {
    this.quota = quota;
  }
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
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

/** A page's drafts over `storage`: writes wait for `run()`, as a timer would
 *  fire, and what was let go of is in `discarded`. */
function page(storage: FakeStorage | null, now = () => 1_000_000) {
  const timers = new Map<number, () => void>();
  let next = 0;
  const discarded: string[] = [];
  const drafts = new Drafts({
    storage: () => storage,
    discard: (ids) => discarded.push(...ids),
    schedule: (save) => {
      timers.set(++next, save);
      return next;
    },
    cancel: (handle) => timers.delete(handle as number),
    now,
  });
  const run = () => {
    for (const [id, save] of [...timers]) {
      timers.delete(id);
      save();
    }
  };
  return { drafts, run, discarded, waiting: () => timers.size };
}

const ready = (id: string, extra: Partial<PendingAttachment> = {}): PendingAttachment => ({
  key: `k-${id}`,
  id,
  filename: `${id}.png`,
  contentType: "image/png",
  sizeBytes: 10,
  previewUrl: `blob:${id}`,
  status: "ready",
  ...extra,
});

test("a draft is there at once, and kept once typing pauses", () => {
  const storage = new FakeStorage();
  const { drafts, run, waiting } = page(storage);
  assert.equal(drafts.get("ws:1"), null);
  drafts.setText("ws:1", "fix the");
  drafts.setText("ws:1", "fix the flaky test");
  assert.equal(drafts.get("ws:1")?.text, "fix the flaky test");
  assert.equal(storage.items.size, 0, "not written on every keystroke");
  assert.equal(waiting(), 1, "one write waiting, however many keystrokes");
  run();
  assert.equal(drafts.get("ws:1")?.text, "fix the flaky test");
  assert.equal(storage.items.size, 1);

  // A reload: another page, the same storage.
  const after = page(storage).drafts;
  assert.deepEqual(after.get("ws:1"), { text: "fix the flaky test", attachments: [] });
  assert.equal(after.get("ws:2"), null, "each place has its own");
});

test("the page going writes what is still waiting", () => {
  const storage = new FakeStorage();
  const { drafts, waiting } = page(storage);
  drafts.setText("new", "half a prompt");
  drafts.flush();
  assert.equal(waiting(), 0);
  assert.equal(page(storage).drafts.get("new")?.text, "half a prompt");
});

test("an emptied draft leaves storage, but stays emptied for the page", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  drafts.setText("new:triage:7", "the item's prompt, edited");
  run();
  drafts.setText("new:triage:7", "");
  run();
  assert.equal(storage.items.size, 0);
  // Not null: a prefill mustn't come back over a box cleared on purpose.
  assert.deepEqual(drafts.get("new:triage:7"), { text: "", attachments: [] });
  assert.equal(page(storage).drafts.get("new:triage:7"), null);
});

test("a failed send's text comes back ahead of what was typed since", () => {
  const { drafts } = page(new FakeStorage());
  drafts.setText("ws:1", "first");
  const sent = drafts.get("ws:1")!.text;
  drafts.setText("ws:1", "");
  drafts.setText("ws:1", "second");
  drafts.setText("ws:1", (current) => restoreDraft(sent, current));
  assert.equal(drafts.get("ws:1")?.text, "first\n\nsecond");
});

test("a send in flight keeps its text kept until it lands; a reload before then gives it back", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  drafts.setText("ws:1", "fix the flaky test");
  run();
  const release = drafts.hold("ws:1", "fix the flaky test");
  drafts.setText("ws:1", "");
  run();
  assert.equal(drafts.get("ws:1")?.text, "", "the box empties at once");
  assert.equal(page(storage).drafts.get("ws:1")?.text, "fix the flaky test", "a reload now brings it back");
  drafts.setText("ws:1", "and then");
  drafts.flush();
  assert.equal(page(storage).drafts.get("ws:1")?.text, "fix the flaky test\n\nand then", "ahead of what was typed since");
  // It landed.
  release();
  run();
  assert.equal(page(storage).drafts.get("ws:1")?.text, "and then");
  release();
  run();
  assert.equal(page(storage).drafts.get("ws:1")?.text, "and then", "releasing twice changes nothing");
});

test("a send that fails is kept once, not twice, as its text comes back", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  drafts.setText("new", "start a session");
  const release = drafts.hold("new", "start a session");
  drafts.setText("new", "");
  run();
  drafts.setText("new", (current) => restoreDraft("start a session", current));
  release();
  run();
  assert.equal(page(storage).drafts.get("new")?.text, "start a session");
});

test("sends overlapping on one key each keep their own text until they land", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  // Send A, the composer away and back (its "sending" gone), then send B.
  const releaseA = drafts.hold("ws:1", "A");
  drafts.setText("ws:1", "");
  const releaseB = drafts.hold("ws:1", "B");
  run();
  assert.equal(page(storage).drafts.get("ws:1")?.text, "A\n\nB", "both, oldest first");
  releaseB(); // B landed first
  run();
  assert.equal(page(storage).drafts.get("ws:1")?.text, "A", "A is still on its way");
  releaseA();
  run();
  assert.equal(page(storage).drafts.get("ws:1"), null);
});

test("the same text sent twice: the first landing doesn't let go of the second", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  const first = drafts.hold("ws:1", "again");
  const second = drafts.hold("ws:1", "again");
  drafts.setText("ws:1", "");
  first();
  run();
  assert.equal(page(storage).drafts.get("ws:1")?.text, "again");
  second();
  run();
  assert.equal(page(storage).drafts.get("ws:1"), null);
});

test("drafts together keep to a budget, thumbnails going first, the oldest drafts' first", () => {
  const storage = new FakeStorage();
  let now = 0;
  const { drafts, run } = page(storage, () => (now += 1000));
  const picture = "data:image/webp;base64," + "A".repeat(Math.floor(KEPT_TOTAL_CHARS / 4));
  for (const key of ["old", "mid", "new"]) {
    drafts.update(key, (d) => ({ ...d, text: key, attachments: [ready(key, { thumbnail: picture })] }));
    run();
  }
  const total = () => [...storage.items.values()].reduce((sum, v) => sum + v.length, 0);
  assert.ok(total() <= KEPT_TOTAL_CHARS);
  // One more over the budget: the oldest's thumbnail goes, not its draft.
  drafts.update("newest", (d) => ({ ...d, text: "newest", attachments: [ready("n", { thumbnail: picture })] }));
  run();
  assert.ok(total() <= KEPT_TOTAL_CHARS);
  const later = page(storage).drafts;
  assert.equal(later.get("old")?.text, "old", "every draft is still kept");
  assert.equal(later.get("old")?.attachments[0].previewUrl, null, "the oldest lost its picture");
  assert.equal(later.get("old")?.attachments[0].id, "old", "but not its file");
  assert.equal(later.get("newest")?.attachments[0].previewUrl, picture, "the newest kept its picture");
  assert.equal(drafts.get("old")?.attachments[0].thumbnail, picture, "this page still shows it");
});

test("a draft over its own cap drops its own pictures first, and never takes another's", () => {
  const storage = new FakeStorage();
  let now = 0;
  const { drafts, run } = page(storage, () => (now += 1000));
  const small = "data:image/webp;base64," + "B".repeat(1000);
  drafts.update("other", (d) => ({ ...d, text: "other", attachments: [ready("o", { thumbnail: small })] }));
  run();
  const picture = "data:image/webp;base64," + "A".repeat(Math.floor(KEPT_CHARS / 2));
  drafts.update("big", (d) => ({
    ...d,
    text: "t".repeat(Math.floor(KEPT_CHARS / 3)),
    attachments: [ready("x", { thumbnail: picture }), ready("y", { thumbnail: picture })],
  }));
  run();
  const later = page(storage).drafts;
  assert.equal(later.get("big")?.text.length, Math.floor(KEPT_CHARS / 3), "kept, without its pictures");
  assert.equal(later.get("big")?.attachments[0].previewUrl, null);
  assert.equal(later.get("other")?.attachments[0].previewUrl, small, "the other draft kept its picture");
  // Too long even without pictures: not kept, and still takes nothing.
  drafts.setText("huge", "h".repeat(KEPT_CHARS + 1));
  run();
  assert.equal(storage.getItem("outrunner:draft:huge"), null);
  assert.equal(page(storage).drafts.get("other")?.attachments[0].previewUrl, small);
});

test("a picture dropped for the budget stays dropped, rather than pushing another's out next", () => {
  const storage = new FakeStorage();
  let now = 0;
  const { drafts, run } = page(storage, () => (now += 1000));
  const picture = "data:image/webp;base64," + "A".repeat(Math.floor(KEPT_TOTAL_CHARS / 3));
  for (const key of ["a", "b", "c"]) {
    drafts.update(key, (d) => ({ ...d, text: key, attachments: [ready(key, { thumbnail: picture })] }));
    run();
  }
  // "c" pushed "a"'s picture out. "a" changing again doesn't take "b"'s.
  assert.equal(page(storage).drafts.get("a")?.attachments[0].previewUrl, null);
  drafts.setText("a", "a, edited");
  run();
  const later = page(storage).drafts;
  assert.equal(later.get("a")?.text, "a, edited");
  assert.equal(later.get("a")?.attachments[0].previewUrl, null);
  assert.equal(later.get("b")?.attachments[0].previewUrl, picture);
  assert.equal(later.get("c")?.attachments[0].previewUrl, picture);
});

test("a draft refused once is tried with its pictures again once it fits", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  const picture = "data:image/webp;base64," + "A".repeat(1000);
  drafts.update("ws:1", (d) => ({ ...d, text: "p".repeat(KEPT_CHARS + 1), attachments: [ready("a", { thumbnail: picture })] }));
  run();
  assert.equal(storage.getItem("outrunner:draft:ws:1"), null, "too long even without its picture");
  drafts.setText("ws:1", "trimmed back");
  run();
  assert.equal(page(storage).drafts.get("ws:1")?.attachments[0].previewUrl, picture, "kept with its picture");
});

test("other drafts keep their pictures when this one won't fit even without any", () => {
  const storage = new FakeStorage();
  let now = 0;
  const { drafts, run } = page(storage, () => (now += 1000));
  const picture = "data:image/webp;base64," + "A".repeat(Math.floor(KEPT_TOTAL_CHARS / 5));
  drafts.update("pictured", (d) => ({ ...d, text: "p", attachments: [ready("p", { thumbnail: picture })] }));
  run();
  drafts.setText("long", "l".repeat(Math.floor(KEPT_TOTAL_CHARS * 0.6)));
  run();
  // Text alone over the budget with this one: refused, and nothing else lost.
  drafts.update("new", (d) => ({ ...d, text: "n".repeat(Math.floor(KEPT_TOTAL_CHARS * 0.5)), attachments: [ready("n", { thumbnail: picture })] }));
  run();
  assert.equal(storage.getItem("outrunner:draft:new"), null);
  assert.equal(page(storage).drafts.get("pictured")?.attachments[0].previewUrl, picture);
});

test("the budget is checked without reading every draft on each save", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  for (let i = 0; i < 10; i++) {
    drafts.setText(`ws:${i}`, `draft ${i}`);
    run();
  }
  let reads = 0;
  const getItem = storage.getItem.bind(storage);
  storage.getItem = (key: string) => {
    reads += 1;
    return getItem(key);
  };
  drafts.setText("ws:3", "draft 3, edited");
  run();
  assert.equal(reads, 0);
});

test("a draft that won't fit the budget even without pictures lasts for the page", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  drafts.setText("a", "x".repeat(KEPT_TOTAL_CHARS * 0.6));
  run();
  drafts.setText("b", "y".repeat(KEPT_TOTAL_CHARS * 0.6));
  run();
  assert.ok(storage.getItem("outrunner:draft:a"), "the one kept first stays kept");
  assert.equal(storage.getItem("outrunner:draft:b"), null);
  assert.equal(drafts.get("b")?.text.length, KEPT_TOTAL_CHARS * 0.6);
});

test("files taken off the composer by a send stay kept until it lands, and come back once if it fails", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  const sent = ready("a");
  drafts.update("ws:1", (d) => ({ ...d, text: "look at this", attachments: [sent] }));
  run();
  // The send takes text and file off the composer at once.
  const release = drafts.hold("ws:1", "look at this", [sent]);
  drafts.update("ws:1", () => ({ text: "", attachments: [] }));
  drafts.update("ws:1", (d) => ({ ...d, attachments: [ready("b")] }));
  run();
  assert.deepEqual(drafts.get("ws:1")?.attachments.map((a) => a.id), ["b"], "the box shows only what came since");
  const reloaded = page(storage).drafts.get("ws:1");
  assert.equal(reloaded?.text, "look at this", "a reload mid-send gives the text back");
  assert.deepEqual(reloaded?.attachments.map((a) => a.id), ["a", "b"], "and its file, ahead of the one since");
  // It failed: the composer puts both back (restore), then lets go.
  drafts.update("ws:1", (d) => ({ text: restoreDraft("look at this", d.text), attachments: [sent, ...d.attachments] }));
  run();
  release();
  run();
  assert.deepEqual(page(storage).drafts.get("ws:1")?.attachments.map((a) => a.id), ["a", "b"], "once each");
});

test("a send that lands lets its files go from what is kept", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  const sent = ready("a");
  drafts.update("ws:1", (d) => ({ ...d, attachments: [sent] }));
  const release = drafts.hold("ws:1", "", [sent]);
  drafts.update("ws:1", () => ({ text: "", attachments: [] }));
  run();
  assert.equal(page(storage).drafts.get("ws:1")?.attachments[0].id, "a");
  release();
  run();
  assert.equal(page(storage).drafts.get("ws:1"), null);
});

test("signing out mid-send keeps the files of the message on its way", () => {
  const storage = new FakeStorage();
  const { drafts, run, discarded } = page(storage);
  const sent = ready("a");
  drafts.update("ws:1", (d) => ({ ...d, text: "look", attachments: [sent, ready("b")] }));
  drafts.hold("ws:1", "look", [sent]);
  drafts.update("ws:1", (d) => ({ text: "", attachments: d.attachments.filter((a) => a.id !== "a") }));
  run();
  drafts.clear();
  assert.deepEqual(discarded, ["b"], "the staged one goes; the one being sent stays");
  assert.equal(storage.items.size, 0);
});

test("an upload's progress is kept with it; one the page cut off comes back failed, without it", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  drafts.update("new", (d) => ({
    ...d,
    attachments: [ready("a", { progress: 1 }), { ...ready("b"), id: null, status: "uploading", progress: 0.4 }],
  }));
  run();
  assert.equal(drafts.get("new")?.attachments[1].progress, 0.4);
  const [a, b] = page(storage).drafts.get("new")!.attachments;
  assert.equal(a.progress, 1);
  assert.equal(b.status, "error");
  assert.equal(b.progress, undefined);
});

test("signing out lets go of a send's hold", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  drafts.hold("ws:1", "secret plan");
  drafts.setText("ws:1", "");
  drafts.clear();
  drafts.setText("ws:2", "x");
  run();
  assert.equal(storage.getItem("outrunner:draft:ws:1"), null);
});

test("files come back after a reload: uploaded ones by their thumbnail, one cut off mid-upload as failed", () => {
  const storage = new FakeStorage();
  const { drafts, run } = page(storage);
  drafts.update("ws:1", (d) => ({
    ...d,
    attachments: [
      ready("a", { thumbnail: "data:image/webp;base64,AAA" }),
      ready("b", { contentType: "text/plain", filename: "notes.txt", previewUrl: null }),
      { ...ready("c"), id: null, status: "uploading" },
    ],
  }));
  run();
  const [a, b, c] = page(storage).drafts.get("ws:1")!.attachments;
  assert.equal(a.previewUrl, "data:image/webp;base64,AAA", "the object URL went with the page");
  assert.equal(a.status, "ready");
  assert.equal(b.previewUrl, null);
  assert.equal(c.status, "error");
  assert.equal(c.error, INTERRUPTED_UPLOAD);
});

test("subscribers hear of their own draft's changes only", () => {
  const { drafts } = page(new FakeStorage());
  let heard = 0;
  const stop = drafts.subscribe("ws:1", () => (heard += 1));
  drafts.setText("ws:2", "elsewhere");
  drafts.setText("ws:1", "here");
  drafts.setText("ws:1", "here");
  assert.equal(heard, 1, "an unchanged text is no change");
  stop();
  drafts.setText("ws:1", "gone");
  assert.equal(heard, 1);
});

test("drafts past their age, or past the newest kept, go with their uploads", () => {
  const storage = new FakeStorage();
  const day = 24 * 60 * 60 * 1000;
  let now = 100 * day;
  const first = page(storage, () => now);
  first.drafts.update("old", (d) => ({ ...d, text: "stale", attachments: [ready("x")] }));
  first.run();
  for (let i = 0; i < KEPT_DRAFTS - 1; i++) {
    now += 1000;
    first.drafts.setText(`ws:${i}`, `draft ${i}`);
    first.run();
  }
  now += 1000;
  first.drafts.update("newest", (d) => ({ ...d, text: "newest", attachments: [ready("y")] }));
  first.run();

  now += (KEPT_DAYS - 1) * day;
  const later = page(storage, () => now);
  assert.equal(later.drafts.get("old"), null, "the oldest, past the cap, went");
  assert.deepEqual(later.discarded, ["x"]);
  assert.equal(later.drafts.get("newest")?.text, "newest");
  assert.equal(later.drafts.get("ws:0")?.text, "draft 0");

  now += 2 * day;
  const muchLater = page(storage, () => now);
  assert.equal(muchLater.drafts.get("newest"), null, "past its age");
  assert.ok(muchLater.discarded.includes("y"));
  assert.equal(storage.items.size, 0);
});

test("a draft this build can't read is dropped, not shown", () => {
  const storage = new FakeStorage();
  storage.setItem("outrunner:draft:ws:1", JSON.stringify({ v: 0, text: "older build" }));
  storage.setItem("outrunner:draft:ws:2", "{not json");
  const { drafts } = page(storage);
  assert.equal(drafts.get("ws:1"), null);
  assert.equal(drafts.get("ws:2"), null);
  assert.equal(storage.items.size, 0);
});

test("a draft that can't be kept, too long or the store full, lasts for the page and leaves no stale copy", () => {
  const storage = new FakeStorage(2000);
  const { drafts, run } = page(storage);
  drafts.setText("ws:1", "short");
  drafts.setText("ws:2", "other");
  run();
  drafts.setText("ws:1", "y".repeat(3000));
  run();
  assert.equal(drafts.get("ws:1")?.text.length, 3000, "still here on this page");
  assert.equal(storage.getItem("outrunner:draft:ws:1"), null, "the older copy went");
  assert.ok(storage.getItem("outrunner:draft:ws:2"), "no other draft was dropped for room");
  drafts.setText("ws:3", "z".repeat(KEPT_CHARS));
  run();
  assert.equal(storage.getItem("outrunner:draft:ws:3"), null);
});

test("a composer with no place of its own keeps its draft for the page only", () => {
  const storage = new FakeStorage();
  const { drafts, run, waiting } = page(storage);
  drafts.setText(`${PAGE_ONLY}composer:r1`, "typed");
  assert.equal(waiting(), 0);
  run();
  assert.equal(storage.items.size, 0);
  assert.equal(drafts.get(`${PAGE_ONLY}composer:r1`)?.text, "typed");
});

test("blocked storage keeps drafts for the page", () => {
  const blocked = {
    get length(): number {
      throw new Error("SecurityError");
    },
    key: () => {
      throw new Error("SecurityError");
    },
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  const drafts = new Drafts({ storage: () => blocked, discard: () => {}, schedule: (save) => save(), cancel: () => {} });
  drafts.setText("ws:1", "still here");
  assert.equal(drafts.get("ws:1")?.text, "still here");
  // On the server there is no storage at all.
  const server = page(null).drafts;
  server.setText("ws:1", "x");
  assert.equal(server.get("ws:1")?.text, "x");
});

test("signing out forgets every draft and lets their uploads go", () => {
  const storage = new FakeStorage();
  const { drafts, run, discarded } = page(storage);
  drafts.update("ws:1", (d) => ({ ...d, text: "mine", attachments: [ready("a")] }));
  run();
  drafts.update("new", (d) => ({ ...d, attachments: [ready("b"), { ...ready("c"), id: null, status: "uploading" }] }));
  // Kept by an earlier page, not read on this one.
  storage.setItem(
    "outrunner:draft:ws:9",
    JSON.stringify({ v: 1, at: 1_000_000, text: "", attachments: [{ ...ready("d"), previewUrl: undefined }] }),
  );
  let heard = 0;
  drafts.subscribe("ws:1", () => (heard += 1));
  drafts.clear();
  assert.deepEqual(discarded.sort(), ["a", "b", "d"]);
  assert.equal(drafts.get("ws:1"), null);
  assert.equal(drafts.get("new"), null);
  assert.equal(storage.items.size, 0);
  assert.equal(heard, 1);
  run();
  assert.equal(storage.items.size, 0, "nothing written back after");
});
