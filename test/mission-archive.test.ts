import assert from "node:assert/strict";
import { test } from "node:test";

import {
  archiveMission,
  missionArchiveConsequence,
  missionArchiveOffer,
  type MissionArchiveDeps,
  requestMissionArchive,
} from "@/lib/missions/archive";
import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";

function session(id: string, status: WorkspaceStatus, patch: Partial<Workspace> = {}): Workspace {
  return { id, status, title: id, branch: `runtime/${id}`, ownerId: "alice", kind: "session", parentMissionId: "m1", ...patch } as Workspace;
}

/** A Runner and its Ships, archived as the lifecycle would: one up is
 *  archived, one asleep woken first. */
function world(ships: Workspace[], mission = session("m1", "ready", { kind: "mission", parentMissionId: null })) {
  const archived: string[] = [];
  const order: string[] = [];
  const refuse = new Map<string, string>();
  let inFlight = 0;
  let mostAtOnce = 0;
  const deps: MissionArchiveDeps = {
    runners: async () => ships,
    dropQueued: async () => void order.push("dropQueued"),
    archive: async (s) => {
      inFlight++;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      order.push(s.id);
      const why = refuse.get(s.id) ?? null;
      if (!why) archived.push(s.id);
      return why;
    },
  };
  return { mission, deps, archived, order, refuse, mostAtOnce: () => mostAtOnce };
}

test("its Ships are archived, at work or asleep, then the Runner, last", async () => {
  const w = world([
    session("working", "ready"),
    session("idle", "idle"),
    session("asleep", "suspended"),
    session("done", "archived"),
    session("failed", "failed"),
    session("going", "archiving"),
  ]);
  const result = await archiveMission(w.mission, w.deps);
  assert.deepEqual(result, { archived: true, ships: 3 });
  assert.deepEqual(w.archived.sort(), ["asleep", "idle", "m1", "working"]);
  // Queued messages go first, so a turn ending meanwhile can't restore a Ship.
  assert.equal(w.order[0], "dropQueued");
  assert.equal(w.order.at(-1), "m1");
});

test("a few Ships at a time", async () => {
  const w = world(Array.from({ length: 10 }, (_, i) => session(`s${i}`, "ready")));
  await archiveMission(w.mission, w.deps);
  assert.equal(w.archived.length, 11);
  assert.ok(w.mostAtOnce() <= 4);
});

test("a Ship that can't go yet keeps the Runner; the rest are archived, and named", async () => {
  const w = world([session("setup", "provisioning", { title: "New login" }), session("stuck", "ready"), session("fine", "idle")]);
  w.refuse.set("stuck", "its box didn't answer");
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  assert.equal(result.ships, 1);
  assert.deepEqual(w.archived, ["fine"]);
  if (result.archived) return;
  assert.deepEqual(result.left.map((s) => s.id).sort(), ["setup", "stuck"]);
  assert.match(result.why, /“New login” \(it's still setting up\)/);
  assert.match(result.why, /“stuck” \(its box didn't answer\)/);
});

test("a Ship that throws is left, not the whole archive", async () => {
  const w = world([session("a", "ready"), session("b", "ready")]);
  const archive = w.deps.archive;
  w.deps.archive = async (s) => (s.id === "a" ? Promise.reject(new Error("boom")) : archive(s));
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  assert.deepEqual(w.archived, ["b"]);
});

test("a Runner archived already: its Ships still go, and it isn't archived again", async () => {
  const w = world([session("a", "ready")], session("m1", "archived", { kind: "mission", parentMissionId: null }));
  assert.deepEqual(await archiveMission(w.mission, w.deps), { archived: true, ships: 1 });
  assert.deepEqual(w.archived, ["a"]);
});

test("a Runner that can't be archived says so, its Ships archived", async () => {
  const w = world([session("a", "ready")], session("m1", "restoring", { kind: "mission", parentMissionId: null }));
  const result = await archiveMission(w.mission, w.deps);
  assert.equal(result.archived, false);
  assert.deepEqual(w.archived, ["a"]);
});

test("offered while up or asleep; disabled saying why between; not once put away", () => {
  for (const s of ["ready", "idle", "suspended"] as const) assert.deepEqual(missionArchiveOffer(s), { can: true });
  for (const s of ["creating", "provisioning", "archiving", "restoring", "suspending", "resuming"] as const) {
    const offer = missionArchiveOffer(s);
    assert.equal(offer?.can, false);
  }
  for (const s of ["archived", "destroying", "destroyed", "failed"] as const) assert.equal(missionArchiveOffer(s), null);
});

test("the confirmation counts its Ships", () => {
  assert.match(missionArchiveConsequence(0), /^Their work is saved/);
  assert.match(missionArchiveConsequence(1), /^Its Ship is archived with it/);
  assert.match(missionArchiveConsequence(3), /^Its 3 Ships are archived with it/);
});

test("the browser's ask: the route's error, said", async () => {
  const calls: string[] = [];
  const ok = (async (url: string) => {
    calls.push(url);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await requestMissionArchive("m1", ok);
  assert.deepEqual(calls, ["/api/missions/m1/archive"]);
  const refused = (async () => new Response(JSON.stringify({ error: "A Ship couldn't be yet." }), { status: 409 })) as typeof fetch;
  await assert.rejects(requestMissionArchive("m1", refused), /A Ship couldn't be yet\./);
  const offline = (async () => {
    throw new TypeError("network");
  }) as typeof fetch;
  await assert.rejects(requestMissionArchive("m1", offline), /Could not reach Outrunner/);
});
