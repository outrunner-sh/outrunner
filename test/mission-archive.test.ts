import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ARCHIVE_BUDGET_MS,
  archiveMission,
  missionArchiveConsequence,
  missionArchiveOffer,
  unarchivedShipCount,
  type MissionArchiveDeps,
  requestMissionArchive,
} from "@/lib/missions/archive";
import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";
import { ARCHIVED_UNSAVED } from "@/lib/session/archive-notice";

function session(id: string, status: WorkspaceStatus, patch: Partial<Workspace> = {}): Workspace {
  return {
    id,
    status,
    title: id,
    branch: `runtime/${id}`,
    ownerId: "alice",
    provider: "daytona",
    kind: "session",
    parentMissionId: "m1",
    ...patch,
  } as Workspace;
}

const runner = (status: WorkspaceStatus = "ready") => session("m1", status, { kind: "mission", parentMissionId: null });

/** A Runner and its Ships, archived as the lifecycle would. Rows are read
 *  fresh from `rows`, which a test may change mid-archive. */
function world(ships: Workspace[], mission = runner()) {
  const rows = new Map([mission, ...ships].map((s) => [s.id, s]));
  const archived: string[] = [];
  const order: string[] = [];
  const refuse = new Map<string, string>();
  const queued = new Map<string, string[]>();
  const returned: string[] = [];
  let clock = 0;
  let inFlight = 0;
  let mostAtOnce = 0;
  const hooks = { onArchive: (_id: string) => {} };
  const deps: MissionArchiveDeps = {
    runners: async () => [...rows.values()].filter((s) => s.parentMissionId === "m1"),
    session: async (id) => rows.get(id) ?? null,
    takeQueued: async (id) => {
      order.push(`take:${id}`);
      const ids = queued.get(id) ?? [];
      queued.delete(id);
      return ids;
    },
    returnQueued: async (ids) => void returned.push(...ids),
    archive: async (s) => {
      inFlight++;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      order.push(s.id);
      hooks.onArchive(s.id);
      const why = refuse.get(s.id) ?? null;
      if (!why) {
        archived.push(s.id);
        rows.set(s.id, { ...s, status: "archived" });
      }
      return why;
    },
    now: () => clock,
  };
  return { mission, rows, deps, archived, order, refuse, queued, returned, hooks, mostAtOnce: () => mostAtOnce, tick: (ms: number) => void (clock += ms) };
}

test("its Ships are archived, at work or asleep, then the Runner, last", async () => {
  const w = world([
    session("working", "ready"),
    session("idle", "idle"),
    session("asleep", "suspended"),
    session("done", "archived"),
    session("failed", "failed"),
  ]);
  const result = await archiveMission(w.mission, w.deps);
  assert.deepEqual(result, { archived: true, ships: 4 });
  assert.deepEqual(w.archived.sort(), ["asleep", "failed", "idle", "m1", "working"]);
  assert.equal(w.order.at(-1), "m1");
});

test("a Ship's queued messages are taken as it's archived, and given back if it isn't", async () => {
  const w = world([session("a", "ready"), session("b", "ready")]);
  w.queued.set("a", ["qa"]);
  w.queued.set("b", ["qb"]);
  w.refuse.set("b", "its box didn't answer");
  await archiveMission(w.mission, w.deps);
  // Taken before its archive, so a turn ending meanwhile can't send one.
  assert.ok(w.order.indexOf("take:a") < w.order.indexOf("a"));
  assert.deepEqual(w.returned, ["qb"]);
});

test("a Ship another ask is archiving keeps the Runner, up front or by the end", async () => {
  const before = world([session("a", "ready"), session("going", "archiving")]);
  const first = await archiveMission(before.mission, before.deps);
  assert.equal(first.archived, false);
  assert.deepEqual(before.order, []);
  if (!first.archived) assert.match(first.why, /“going” \(it's being archived\)/);
  // Archived when listed; brought back and being archived by another ask
  // as this one works.
  const during = world([session("a", "ready"), session("b", "archived")]);
  during.hooks.onArchive = (id) => {
    if (id === "a") during.rows.set("b", session("b", "archiving"));
  };
  const second = await archiveMission(during.mission, during.deps);
  assert.equal(second.archived, false);
  assert.ok(!during.archived.includes("m1"));
  if (!second.archived) assert.deepEqual(second.left.map((s) => [s.id, s.why]), [["b", "it's being archived"]]);
});

test("a give-back that fails doesn't hide the archive's reason", async () => {
  const w = world([session("a", "ready")]);
  w.queued.set("a", ["qa"]);
  w.refuse.set("a", "its box didn't answer");
  w.deps.returnQueued = async () => Promise.reject(new Error("db down"));
  const quiet = console.error;
  console.error = () => {};
  const result = await archiveMission(w.mission, w.deps).finally(() => (console.error = quiet));
  assert.equal(result.archived, false);
  if (!result.archived) assert.deepEqual(result.left.map((s) => s.why), ["its box didn't answer"]);
});

test("a Ship that can't go now: nothing is touched, and it's named", async () => {
  const w = world([session("setup", "provisioning", { title: "New login" }), session("fine", "idle"), session("legacy", "ready", { provider: "modal" })]);
  w.queued.set("fine", ["q1"]);
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  if (result.archived) return;
  assert.equal(result.more, false);
  assert.deepEqual(w.archived, []);
  assert.deepEqual(w.order, []);
  assert.deepEqual(w.queued.get("fine"), ["q1"]);
  assert.match(result.why, /“New login” \(it's still setting up\)/);
  assert.match(result.why, /“legacy” \(its computer can't archive\)/);
});

test("one that fails is left and named; the rest are archived, the Runner kept", async () => {
  const w = world([session("stuck", "ready"), session("fine", "idle"), session("throws", "ready")]);
  w.refuse.set("stuck", "its box didn't answer");
  const archive = w.deps.archive;
  w.deps.archive = async (s) => (s.id === "throws" ? Promise.reject(new Error("boom")) : archive(s));
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  assert.deepEqual(w.archived, ["fine"]);
  if (result.archived) return;
  assert.deepEqual(result.left.map((s) => s.id).sort(), ["stuck", "throws"]);
  assert.match(result.why, /“stuck” \(its box didn't answer\)/);
  assert.match(result.why, /“throws” \(boom\)/);
});

test("a Ship started while the others are archived keeps the Runner", async () => {
  const w = world([session("a", "ready")]);
  w.hooks.onArchive = (id) => {
    if (id === "a") w.rows.set("new", session("new", "creating"));
  };
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  assert.ok(!w.archived.includes("m1"));
  if (!result.archived) assert.deepEqual(result.left.map((s) => s.id), ["new"]);
});

test("a Ship a message brings back while the others are archived keeps the Runner", async () => {
  const w = world([session("a", "ready"), session("b", "ready")]);
  w.hooks.onArchive = (id) => {
    if (id === "b") queueMicrotask(() => w.rows.set("a", session("a", "restoring")));
  };
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  assert.ok(!w.archived.includes("m1"));
  if (!result.archived) assert.deepEqual(result.left.map((s) => s.id), ["a"]);
});

test("each row is read as its turn comes: one asleep since it was listed is woken, not refused", async () => {
  const w = world([session("a", "ready")]);
  // Listed up; by its turn, asleep (the archive dep wakes one asleep).
  w.rows.set("a", session("a", "suspended"));
  const seen: WorkspaceStatus[] = [];
  const archive = w.deps.archive;
  w.deps.archive = async (s) => {
    seen.push(s.status);
    return archive(s);
  };
  w.rows.set("m1", runner("suspended"));
  assert.deepEqual(await archiveMission(runner("ready"), w.deps), { archived: true, ships: 1 });
  assert.deepEqual(seen, ["suspended", "suspended"]);
});

test("out of time: the rest wait for the next ask, which goes on", async () => {
  const ships = Array.from({ length: 10 }, (_, i) => session(`s${i}`, "ready"));
  const w = world(ships);
  w.hooks.onArchive = () => w.tick(ARCHIVE_BUDGET_MS / 4);
  const first = await archiveMission(w.mission, w.deps);
  assert.equal(first.archived, false);
  if (first.archived) return;
  assert.equal(first.more, true);
  assert.ok(first.ships > 0 && first.ships < 10);
  assert.equal(first.why, `${10 - first.ships} Ships still to archive. Try again to finish.`);
  assert.ok(!w.archived.includes("m1"));
  w.hooks.onArchive = () => {};
  w.tick(-w.deps.now());
  assert.deepEqual(await archiveMission(w.mission, w.deps), { archived: true, ships: 10 - first.ships });
});

test("not reached and refused together: only the refused are named as failing", async () => {
  const w = world(Array.from({ length: 6 }, (_, i) => session(`s${i}`, "ready")));
  w.refuse.set("s0", "its box didn't answer");
  w.hooks.onArchive = () => w.tick(ARCHIVE_BUDGET_MS);
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  if (result.archived) return;
  assert.equal(result.more, false);
  assert.match(result.why, /couldn't be yet: “s0” \(its box didn't answer\), and 1 Ship still to archive\./);
  assert.doesNotMatch(result.why, /not reached/);
});

test("a few Ships at a time", async () => {
  const w = world(Array.from({ length: 10 }, (_, i) => session(`s${i}`, "ready")));
  await archiveMission(w.mission, w.deps);
  assert.equal(w.archived.length, 11);
  assert.ok(w.mostAtOnce() <= 4);
});

test("a Runner archived already: its Ships still go, and it isn't archived again", async () => {
  const w = world([session("a", "ready")], runner("archived"));
  assert.deepEqual(await archiveMission(w.mission, w.deps), { archived: true, ships: 1 });
  assert.deepEqual(w.archived, ["a"]);
});

test("a Runner that can't be archived says why, its Ships archived", async () => {
  const w = world([session("a", "ready")], runner("restoring"));
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  assert.deepEqual(w.archived, ["a"]);
  if (!result.archived) assert.match(result.why, /once it's restored/);
  const refused = world([], runner("ready"));
  refused.refuse.set("m1", "Only an active workspace can be archived");
  const again = await archiveMission(refused.mission, refused.deps);
  if (!again.archived) assert.match(again.why, /Only an active workspace can be archived/);
});

test("offered while up or asleep, on a Runtime Computer; disabled saying why between; not once put away", () => {
  const offer = (status: WorkspaceStatus, provider: Workspace["provider"] = "daytona") => missionArchiveOffer({ status, provider });
  for (const s of ["ready", "idle", "suspended"] as const) assert.deepEqual(offer(s), { can: true });
  for (const s of ["creating", "provisioning", "archiving", "restoring", "suspending", "resuming"] as const) assert.equal(offer(s)?.can, false);
  for (const s of ["archived", "destroying", "destroyed", "failed"] as const) assert.equal(offer(s), null);
  assert.equal(offer("ready", "modal"), null);
});

test("the confirmation counts its Ships", () => {
  assert.match(missionArchiveConsequence(0), /^Reachable work is saved/);
  assert.match(missionArchiveConsequence(1), /^Its remaining Ship is archived with it/);
  assert.match(missionArchiveConsequence(3), /^Its 3 remaining Ships are archived with it/);
  assert.match(missionArchiveConsequence(3), /original disk is kept/);
  assert.equal(unarchivedShipCount([{ state: "idle" }, { state: "failed" }, { state: "archived" }, { state: "archived" }]), 2,
    "failed Ships count, while archived Shipping rows do not");
});

test("manual Runner archive includes failed Ships and does not forget their work", async () => {
  const w = world([session("failed-with-work", "failed"), session("dead", "ready"), session("already-archived", "archived")]);
  const saved = w.deps.archive;
  w.deps.archive = async (ship) => {
    const result = await saved(ship);
    return ship.id === "dead" ? { note: "Archived without files" } : result;
  };
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, true);
  assert.deepEqual(w.archived.sort(), ["dead", "failed-with-work", "m1"]);
  if (result.archived) assert.match(result.note ?? "", /“dead”/);
});

test("a real save failure keeps its Ship and reports successful partial progress without promising a retry fixes it", async () => {
  const w = world([session("saved", "ready"), session("save-failed", "ready")]);
  w.refuse.set("save-failed", "Its files couldn't be saved. The session was kept so its work can be recovered");
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  assert.deepEqual(w.archived, ["saved"]);
  if (!result.archived) {
    assert.match(result.why, /^1 Ship archived\./);
    assert.match(result.why, /files couldn't be saved/);
    assert.doesNotMatch(result.why, /Try again shortly/);
    assert.deepEqual(result.left.map((ship) => ship.id), ["save-failed"]);
  }
});

test("an earlier attempt's unsaved warning survives a manual retry after a genuine upload failure", async () => {
  const w = world([
    session("unreachable", "archived", { errorMessage: ARCHIVED_UNSAVED }),
    session("upload-failed", "ready"),
  ]);
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, true);
  assert.deepEqual(w.archived, ["upload-failed", "m1"]);
  if (result.archived) assert.match(result.note ?? "", /without its files.*“unreachable”/);
});

test("persisted cumulative loss notes are not duplicated across budget-limited asks", async () => {
  const answers = [
    new Response(JSON.stringify({ more: true, note: "Ship a was unsaved.", cumulativeNote: true }), { status: 409 }),
    new Response(JSON.stringify({ note: "Ships a and b were unsaved.", cumulativeNote: true })),
  ];
  assert.equal(await requestMissionArchive("m1", (async () => answers.shift()!) as typeof fetch), "Ships a and b were unsaved.");
});

test("the browser's ask: again while there's more, else the route's error, said", async () => {
  const answers = [
    new Response(JSON.stringify({ error: "2 Ships still to archive. Try again to finish.", more: true }), { status: 409 }),
    new Response("{}", { status: 200 }),
  ];
  const calls: string[] = [];
  const goesOn = (async (url: string) => {
    calls.push(url);
    return answers.shift()!;
  }) as typeof fetch;
  await requestMissionArchive("m1", goesOn);
  assert.deepEqual(calls, ["/api/missions/m1/archive", "/api/missions/m1/archive"]);
  const refused = (async () => new Response(JSON.stringify({ error: "A Ship couldn't be yet.", more: false }), { status: 409 })) as typeof fetch;
  await assert.rejects(requestMissionArchive("m1", refused), /A Ship couldn't be yet\./);
  let asks = 0;
  const forever = (async () => {
    asks++;
    return new Response(JSON.stringify({ error: "Still going.", more: true }), { status: 409 });
  }) as typeof fetch;
  await assert.rejects(requestMissionArchive("m1", forever), /Still going\./);
  assert.equal(asks, 5);
  const offline = (async () => {
    throw new TypeError("network");
  }) as typeof fetch;
  await assert.rejects(requestMissionArchive("m1", offline), /Could not reach Outrunner/);
});

test("a Ship whose box is out of reach is archived without its files, and the Runner goes, saying so", async () => {
  const w = world([session("dead", "ready", { title: "Click Blink" }), session("asleep", "suspended", { title: "Instant Routes" }), session("fine", "idle")]);
  const archive = w.deps.archive;
  w.deps.archive = async (s) => {
    const why = await archive(s);
    return why === null && s.id !== "fine" && s.id !== "m1" ? { note: "Archived without its files." } : why;
  };
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, true);
  if (!result.archived) return;
  assert.equal(result.ships, 3);
  assert.deepEqual(w.archived.sort(), ["asleep", "dead", "fine", "m1"]);
  assert.deepEqual(result.unsaved?.map((s) => s.id).sort(), ["asleep", "dead"]);
  assert.match(result.note ?? "", /^2 Ships were archived without their files, their boxes out of reach: /);
  assert.match(result.note ?? "", /“Click Blink”/);
  assert.match(result.note ?? "", /anything pushed to GitHub is kept/);
  assert.doesNotMatch(result.note ?? "", /setup/);
});

test("a Runner archived without its own files says so too", async () => {
  const w = world([]);
  const archive = w.deps.archive;
  w.deps.archive = async (s) => ((await archive(s)) === null ? { note: "Archived without its files." } : null);
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, true);
  if (result.archived) assert.match(result.note ?? "", /The Runner itself was archived without its files/);
});

test("a Ship archived without its files is still said when another keeps the Runner", async () => {
  const w = world([session("dead", "ready", { title: "Click Blink" }), session("stuck", "ready")]);
  w.refuse.set("stuck", "Your plan's cloud hours are used up");
  const archive = w.deps.archive;
  w.deps.archive = async (s) => (s.id === "dead" ? (await archive(s), { note: "Archived without its files." }) : archive(s));
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  if (result.archived) return;
  assert.match(result.why, /“stuck” \(Your plan's cloud hours are used up\)/);
  assert.match(result.why, /A Ship was archived without its files, its box out of reach: “Click Blink”/);
});

test("the browser's ask answers the note, kept across asks that ran out of time", async () => {
  const answers = [
    new Response(JSON.stringify({ error: "2 Ships still to archive.", more: true, note: "A Ship was archived without its files: “a”." }), { status: 409 }),
    new Response(JSON.stringify({ ok: true, note: "A Ship was archived without its files: “b”." }), { status: 200 }),
  ];
  const asks = (async () => answers.shift()!) as typeof fetch;
  assert.equal(await requestMissionArchive("m1", asks), "A Ship was archived without its files: “a”. A Ship was archived without its files: “b”.");
  assert.equal(await requestMissionArchive("m1", (async () => new Response("{}", { status: 200 })) as typeof fetch), null);
});
