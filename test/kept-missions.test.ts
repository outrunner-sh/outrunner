import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearMissions,
  DETAILS_HELD,
  KEPT_CHARS,
  KEPT_MISSIONS,
  KeptMissions,
  missionsAnswered,
  missionsGeneration,
  missionsSnapshot,
  NO_MISSIONS,
  publishMissions,
  rememberMissions,
  rememberRunnerDetail,
  runnerDetail,
} from "@/lib/missions/kept-missions";
import type { MissionView, RunnerView } from "@/lib/missions/view";

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

const standing = { standing: "needs_you", reason: "question", moved: false, pinned: false, unread: true, replyPreview: null, at: "t" } as const;

function runner(id: string, overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    id,
    name: `Ship ${id}`,
    summary: "A first line",
    state: "working",
    branch: `outrunner/${id}`,
    pulls: [
      {
        repo: "me/p1",
        number: 7,
        url: "https://github.com/me/p1/pull/7",
        title: "A change",
        state: "open",
        verdict: "ready",
        reason: null,
        additions: 3,
        deletions: 1,
        checks: [{ name: "ci", status: "completed", conclusion: "success", url: null }],
        reviewState: "approved",
        mergeableState: "clean",
        endedAt: null,
      },
    ],
    group: "ready_to_merge",
    attention: null,
    standing,
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function mission(id: string, overrides: Partial<MissionView> = {}): MissionView {
  return {
    id,
    title: `Runner ${id}`,
    icon: "rocket",
    status: "ready",
    readyCount: 1,
    liveRunners: 1,
    environment: { id: "e1", name: "Project" },
    sessionStatus: "ready",
    standing,
    runners: [runner(`${id}-r1`)],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function cache(storage: FakeStorage) {
  return new KeptMissions(() => storage);
}

test("the Runners the server sent outlive the page, without where they stand", () => {
  const storage = new FakeStorage();
  cache(storage).save([mission("m1")]);

  // A reload: a new page, the same storage.
  const back = cache(storage).load()!;
  assert.equal(back.length, 1);
  assert.equal(back[0].title, "Runner m1");
  assert.equal(back[0].icon, "rocket");
  assert.equal(back[0].environment?.name, "Project");
  // The pane's Ships show at once too, pull request and all.
  assert.equal(back[0].runners[0].name, "Ship m1-r1");
  assert.equal(back[0].runners[0].pulls[0].number, 7);
  assert.equal(back[0].runners[0].pulls[0].checks[0].conclusion, "success");
  // Where they stand is not kept: the poll reads it again within seconds.
  assert.equal(back[0].standing, null);
  assert.equal(back[0].runners[0].standing, null);
});

test("past the cap the Runners the sidebar doesn't reach go", () => {
  const storage = new FakeStorage();
  const many = Array.from({ length: KEPT_MISSIONS + 2 }, (_, i) => mission(`m${i}`));
  cache(storage).save(many);
  const back = cache(storage).load()!;
  assert.equal(back.length, KEPT_MISSIONS);
  assert.equal(back[0].id, "m0");
});

test("one kept by an older build, or damaged, opens from the server, and is dropped", () => {
  const storage = new FakeStorage();
  storage.setItem("outrunner:missions", JSON.stringify({ v: 0, missions: [] }));
  assert.equal(cache(storage).load(), null);
  storage.setItem("outrunner:missions", "{not json");
  assert.equal(cache(storage).load(), null);
  // A Runner missing what every reader needs: one with no id.
  storage.setItem("outrunner:missions", JSON.stringify({ v: 1, missions: [{ title: "x" }] }));
  assert.equal(cache(storage).load(), null);
  assert.equal(storage.getItem("outrunner:missions"), null);
  // A Runner keeping where it stands: nothing writes that, so this build
  // doesn't trust the rest of it either.
  storage.setItem("outrunner:missions", JSON.stringify({ v: 1, missions: [{ ...mission("m1"), standing: null, runners: [{ ...runner("r1"), standing: { standing: "working" } }] }] }));
  assert.equal(cache(storage).load(), null);
  assert.equal(storage.getItem("outrunner:missions"), null);
});

test("a list too long to keep isn't kept, and no older list stands in for it", () => {
  const storage = new FakeStorage();
  cache(storage).save([mission("m1")]);
  assert.ok(cache(storage).load());
  cache(storage).save([mission("m2", { title: "x".repeat(KEPT_CHARS) })]);
  assert.equal(cache(storage).load(), null);
  assert.equal(storage.getItem("outrunner:missions"), null);
});

test("out of room nothing is kept, and no older list stands in for it", () => {
  const storage = new FakeStorage(10);
  assert.equal(cache(storage).save([mission("m1")]), null);
  assert.equal(storage.getItem("outrunner:missions"), null);
  assert.equal(cache(storage).load(), null);
});

test("a Runner archived or deleted is forgotten, the others stay", () => {
  const storage = new FakeStorage();
  const kept = cache(storage);
  kept.save([mission("m1"), mission("m2")]);
  kept.forget("m1");
  assert.deepEqual(kept.load()!.map((m) => m.id), ["m2"]);
  // The last one going leaves an empty list kept, which is the truth: this
  // account has no Runners.
  kept.forget("m2");
  assert.deepEqual(kept.load(), []);
  // Nothing was ever kept: forgetting is a no-op, not a write.
  assert.equal(new KeptMissions(() => new FakeStorage()).forget("m3"), null);
});

test("signing out, or switching orgs, forgets them all", () => {
  const storage = new FakeStorage();
  const kept = cache(storage);
  kept.save([mission("m1")]);
  kept.clear();
  assert.equal(storage.getItem("outrunner:missions"), null);
  assert.equal(kept.load(), null);
});

test("blocked storage keeps nothing and breaks nothing", () => {
  const kept = new KeptMissions(() => null);
  assert.equal(kept.save([mission("m1")]), null);
  assert.equal(kept.load(), null);
  kept.forget("m1");
  kept.clear();
});

test("a Ship opened again paints what it last said, until a new answer lands", () => {
  // Nothing is known of it yet: the pane says it is loading.
  assert.equal(runnerDetail("r-unknown"), null);

  rememberRunnerDetail("r1", { brief: "What it is doing", latestResponse: "Done with the first part.", live: true, status: "working" });
  assert.equal(runnerDetail("r1")?.latestResponse, "Done with the first part.");

  // The next answer replaces it, and only the last few are held.
  rememberRunnerDetail("r1", { brief: null, latestResponse: "And the second.", live: true, status: "working" });
  assert.equal(runnerDetail("r1")?.latestResponse, "And the second.");
  for (let i = 0; i < DETAILS_HELD; i++) {
    rememberRunnerDetail(`r${i + 10}`, { brief: null, latestResponse: null, live: false, status: "idle" });
  }
  assert.equal(runnerDetail("r1"), null);

  // Left alone: none of this belongs to the org (or the user) that left.
  clearMissions();
  assert.equal(runnerDetail("r10"), null);
});

test("before the server answers, the Runners shown are only what was kept", () => {
  clearMissions();
  assert.equal(missionsAnswered(), false);
  publishMissions({ loaded: true, missions: [mission("m1")], error: null });
  assert.equal(missionsAnswered(), true);
  // A look that failed is not an answer: what the store holds stays what was
  // kept, and a Runner missing from it is waited for rather than called gone.
  clearMissions();
  publishMissions({ loaded: false, missions: [], error: "offline" });
  assert.equal(missionsAnswered(), false);
  clearMissions(); // as a page with nothing read yet starts
});

test("the page starts from the server's answer, never from the store while rendering", () => {
  // Nothing has been read here: what a server render — and so hydration — sees
  // is the empty snapshot, whatever this browser has kept (lib/client/store.ts).
  assert.equal(missionsSnapshot(), NO_MISSIONS);
  assert.deepEqual(NO_MISSIONS, { loaded: false, missions: [], error: null });
});

test("an answer is published and kept, and forgetting it clears both", () => {
  const storage = new FakeStorage();
  (globalThis as Record<string, unknown>).window = { localStorage: storage };

  publishMissions({ loaded: true, missions: [mission("m1")], error: null });
  rememberMissions([mission("m1")]);
  assert.equal(missionsSnapshot().missions.length, 1);
  assert.ok(storage.getItem("outrunner:missions"));

  // The org (or the user) leaves: what is shown goes with what is kept, and a
  // look already in flight can't publish the org left behind into the new one.
  const before = missionsGeneration();
  clearMissions();
  assert.ok(missionsGeneration() > before);
  assert.equal(missionsSnapshot(), NO_MISSIONS);
  assert.equal(storage.getItem("outrunner:missions"), null);
});
