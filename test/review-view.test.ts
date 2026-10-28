import assert from "node:assert/strict";
import { test } from "node:test";

import { lastEventIdFrom, reviewEventsUrl, reviewView, type ReviewViewDeps } from "@/lib/automations/review-view";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";

const archived: AgentEvent[] = [{ t: "state", workspaceId: "w1", state: "running" } as AgentEvent];

function deps(over: Partial<ReviewViewDeps> & { live?: boolean; archive?: boolean } = {}) {
  const actedAs: string[] = [];
  const asked: unknown[] = [];
  let inside = false;
  const d: ReviewViewDeps = {
    connectorRunSession: async (orgId, runId) =>
      orgId === "o1" && runId === "r1" ? { workspaceId: "w1", connectorId: "c1" } : null,
    asConnector: async (connectorId, work) => {
      actedAs.push(connectorId);
      inside = true;
      try {
        return await work();
      } finally {
        inside = false;
      }
    },
    boxUp: async () => {
      assert.ok(inside, "read as the connector");
      return Boolean(over.live);
    },
    liveEventsUrl: async (workspaceId, lastEventId) => {
      assert.ok(inside, "read as the connector");
      asked.push([workspaceId, lastEventId]);
      return over.live ? `https://box/events?token=t${lastEventId ? `&lastEventId=${lastEventId}` : ""}` : null;
    },
    latestArchive: async (workspaceId, connectorId) => {
      assert.ok(inside, "read as the connector");
      assert.deepEqual([workspaceId, connectorId], ["w1", "c1"]);
      return over.archive ? { events: archived, archivedAt: "2026-10-28T12:00:00Z" } : null;
    },
    ...over,
  };
  return { d, actedAs, asked };
}

test("a review session is read live while its box is up, as the connector, and never says how", async () => {
  const { d, actedAs } = deps({ live: true, archive: true });
  // The view says it's live; its URL (and token) stays on the server, and
  // isn't even made for it.
  const { d: viewOnly, asked } = deps({ live: true, liveEventsUrl: async () => assert.fail("made a URL") });
  assert.deepEqual(await reviewView("o1", "r1", viewOnly), { mode: "live" });
  assert.deepEqual(asked, []);
  assert.deepEqual(await reviewView("o1", "r1", d), { mode: "live" });
  assert.deepEqual(actedAs, ["c1"]);
});

test("else as its latest snapshot kept it, or not at all", async () => {
  assert.deepEqual(await reviewView("o1", "r1", deps({ archive: true }).d), {
    mode: "archived",
    events: archived,
    archivedAt: "2026-10-28T12:00:00Z",
  });
  assert.deepEqual(await reviewView("o1", "r1", deps().d), { mode: "none" });
});

test("only the org's connector's run sessions, and nothing read for any other", async () => {
  const { d, actedAs } = deps({ live: true });
  assert.equal(await reviewView("o2", "r1", d), null);
  assert.equal(await reviewView("o1", "r2", d), null);
  assert.equal(await reviewEventsUrl("o2", "r1", null, d), null);
  assert.deepEqual(actedAs, []);
});

test("the stream resumes from a byte offset, and nothing else is passed to the box", async () => {
  const { d, asked } = deps({ live: true });
  assert.equal(await reviewEventsUrl("o1", "r1", "1234", d), "https://box/events?token=t&lastEventId=1234");
  assert.equal(await reviewEventsUrl("o1", "r1", "1&token=x", d), "https://box/events?token=t");
  assert.deepEqual(asked, [
    ["w1", "1234"],
    ["w1", null],
  ]);
  assert.equal(lastEventIdFrom(null), null);
  assert.equal(lastEventIdFrom("-1"), null);
  // A state event's id: no point to resume from.
  assert.equal(lastEventIdFrom("0"), null);
  assert.equal(lastEventIdFrom("9".repeat(16)), null);
  // Down: nothing to pass on.
  assert.equal(await reviewEventsUrl("o1", "r1", null, deps().d), null);
});
