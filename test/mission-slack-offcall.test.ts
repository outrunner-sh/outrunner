/**
 * A Mission going off call (lib/missions/slack-offcall.ts): its cards closed
 * first, then the binding ended, then the Mission told; a card that can't be
 * closed never stops the rest.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { closeOpenCards, type OffCallDeps, takeMissionOffCall } from "@/lib/missions/slack-offcall";
import type { MissionAsk, MissionChannel, MissionThread, ShipAsk } from "@/lib/missions/slack-store";
import type { Workspace } from "@/lib/runtime/types";

const binding: MissionChannel = { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };
const mission = { id: "m1", kind: "mission", ownerId: "owner" } as Workspace;
const thread = (id: string, channelId = "C1"): MissionThread => ({ id, missionId: "m1", teamId: "T1", channelId, threadTs: `1731400000.00${id}`, permalink: null, startedBy: null, startedBySlack: null, lastRequestTs: null, muted: false });
const ask = (id: string, patch: Partial<MissionAsk> = {}): MissionAsk => ({ id, missionId: "m1", threadId: "1", question: `Question ${id}?`, options: ["a", "b"], messageTs: `1731400005.00${id}`, answeredAt: null, bindingRevision: "rev1", ...patch });

function world(asks: MissionAsk[], opts: { failOn?: string[]; dropFails?: boolean } = {}) {
  const calls: string[] = [];
  const threads = new Map([["1", thread("1")], ["2", thread("2", "C2")]]);
  const deps: OffCallDeps = {
    binding: async () => binding,
    openAsks: async () => asks,
    thread: async (id) => threads.get(id) ?? null,
    update: async (_b, ts, text, blocks) => {
      calls.push(`update:${ts}`);
      if (opts.failOn?.includes(ts)) throw new Error("Slack said no");
      assert.match(text, /No longer waiting: the Mission /);
      assert.equal(JSON.stringify(blocks).includes('"button"'), false);
    },
    unbind: async () => {
      calls.push("unbind");
      return true;
    },
    dropPending: async () => {
      calls.push("dropPending");
      if (opts.dropFails) throw new Error("db down");
    },
    tell: async () => {
      calls.push("tell");
    },
    audit: async () => {
      calls.push("audit");
    },
    log: (message) => calls.push(`log:${message.split(":").slice(1).join(":").trim().slice(0, 30)}`),
  };
  return { deps, calls };
}

test("closeOpenCards closes only cards it can place, goes on after a failure, and counts what it closed", async () => {
  const w = world(
    [ask("1"), ask("2", { messageTs: null }), ask("3", { threadId: "2" }), ask("4", { threadId: "missing" }), ask("5", { messageTs: "bad.ts" }), ask("6", { messageTs: "1731400005.000006" })],
    { failOn: ["bad.ts"] },
  );
  assert.equal(await closeOpenCards("m1", binding, "off_call", w.deps), 2);
  // No messageTs, another channel's thread, and an unknown thread are never edited.
  assert.deepEqual(w.calls.filter((c) => c.startsWith("update:")), ["update:1731400005.001", "update:bad.ts", "update:1731400005.000006"]);
  assert.equal(w.calls.filter((c) => c.startsWith("log:")).length, 1);
});

test("off call: cards close before the binding ends, which is before the Mission is told, whatever fails", async () => {
  const w = world([ask("1"), ask("6", { messageTs: "bad.ts" })], { failOn: ["bad.ts"] });
  assert.equal(await takeMissionOffCall(mission, "wes", "off_call", w.deps), true);
  const order = w.calls.filter((c) => !c.startsWith("log:"));
  assert.deepEqual(order, ["update:1731400005.001", "update:bad.ts", "unbind", "dropPending", "tell", "audit"]);
  // Dropping pending work failing still tells the Mission and writes the log.
  const failing = world([], { dropFails: true });
  assert.equal(await takeMissionOffCall(mission, "wes", "archived", failing.deps), true);
  assert.deepEqual(failing.calls.filter((c) => !c.startsWith("log:")), ["unbind", "dropPending", "tell", "audit"]);
  // Not on call: nothing is touched.
  const off = world([ask("1")]);
  off.deps.binding = async () => null;
  assert.equal(await takeMissionOffCall(mission, "wes", "off_call", off.deps), false);
  assert.deepEqual(off.calls, []);
});

const shipAsk = (id: string, patch: Partial<ShipAsk> = {}): ShipAsk => ({
  id,
  missionId: "m1",
  runnerId: "r1",
  threadId: "1",
  bindingRevision: "rev1",
  opKey: `ship_ask:r1:${id}`,
  callId: `c${id}`,
  launchEpoch: "e1",
  toolUseId: null,
  title: "Fix the login redirect",
  question: `Ship question ${id}?`,
  options: ["a", "b"],
  questions: [],
  messageTs: `1731400009.00${id}`,
  answeredAt: null,
  closedAt: null,
  ...patch,
});

test("going off call closes its Ships' cards of that binding too, with the same words, before the binding ends", async () => {
  for (const why of ["off_call", "archived"] as const) {
    const w = world([ask("1")]);
    const asked: string[] = [];
    const closedShip: string[] = [];
    const ships = [shipAsk("7"), shipAsk("8", { threadId: "2" }), shipAsk("9", { messageTs: null }), shipAsk("10")];
    w.deps.openShipAsks = async (missionId, revision) => {
      asked.push(`${missionId}:${revision}`);
      return ships;
    };
    // A click claimed card 10 first: closing it is refused, and it isn't edited.
    w.deps.closeShipAsk = async (id) => {
      closedShip.push(id);
      return id !== "10";
    };
    const texts: string[] = [];
    const update = w.deps.update;
    w.deps.update = async (b, ts, text, blocks) => {
      texts.push(text);
      if (ts.startsWith("1731400009")) {
        const card = JSON.stringify(blocks);
        assert.match(card, /Working on: \*Fix the login redirect\*/);
        assert.match(card, why === "archived" ? /No longer waiting: the Mission was archived/ : /No longer waiting: the Mission went off call/);
        assert.equal(card.includes('"button"'), false);
      }
      return update(b, ts, text, blocks);
    };
    assert.equal(await takeMissionOffCall(mission, "wes", why, w.deps), true);
    // Only the ending binding's revision is asked for.
    assert.deepEqual(asked, ["m1:rev1"]);
    assert.deepEqual(closedShip, ["7", "8", "9", "10"]);
    // Edited: the Mission's own card, and the one Ship card it can place (not
    // another channel's thread, not unposted, not the one a click claimed).
    assert.deepEqual(w.calls.filter((c) => !c.startsWith("log:")), ["update:1731400005.001", "update:1731400009.007", "unbind", "dropPending", "tell", "audit"]);
    assert.ok(texts[1].startsWith("Ship question 7?: No longer waiting"));
  }
});

test("off call with the Ship-card hooks unwired closes the Mission's own cards as before", async () => {
  const w = world([ask("1")]);
  assert.equal(await closeOpenCards("m1", binding, "off_call", w.deps), 1);
});
