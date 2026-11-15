/**
 * A Mission going off call (lib/missions/slack-offcall.ts): its cards closed
 * first, then the binding ended, then the Mission told; a card that can't be
 * closed never stops the rest.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { closeOpenCards, type OffCallDeps, takeMissionOffCall } from "@/lib/missions/slack-offcall";
import type { MissionAsk, MissionChannel, MissionThread } from "@/lib/missions/slack-store";
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
  // Unwired (as on this branch: takeOffCall passes none), nothing is dropped
  // and the rest goes on; pending requests are refused by revision instead.
  const unwired = world([ask("1")]);
  delete unwired.deps.dropPending;
  assert.equal(await takeMissionOffCall(mission, "wes", "off_call", unwired.deps), true);
  assert.deepEqual(unwired.calls, ["update:1731400005.001", "unbind", "tell", "audit"]);
  // Not on call: nothing is touched.
  const off = world([ask("1")]);
  off.deps.binding = async () => null;
  assert.equal(await takeMissionOffCall(mission, "wes", "off_call", off.deps), false);
  assert.deepEqual(off.calls, []);
});

test("off call edits only the ending binding's cards: an earlier binding's open asks are skipped before any thread read", async () => {
  const w = world([ask("1"), ask("2", { bindingRevision: "rev0" }), ask("3", { bindingRevision: null }), ask("4", { bindingRevision: "rev-old" })]);
  const reads: string[] = [];
  const read = w.deps.thread;
  w.deps.thread = async (id) => {
    reads.push(id);
    return read(id);
  };
  assert.equal(await takeMissionOffCall(mission, "wes", "off_call", w.deps), true);
  // rev1's card and one from before revisions were kept; rev0's and rev-old's untouched.
  assert.deepEqual(w.calls.filter((c) => c.startsWith("update:")), ["update:1731400005.001", "update:1731400005.003"]);
  assert.equal(reads.length, 2, "a skipped card costs no thread read");
});
