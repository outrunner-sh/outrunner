import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLearning,
  deleteLearning,
  LearningError,
  listLearnings,
  sessionLearnings,
  updateLearning,
  type LearningDeps,
  type LearningStore,
} from "@/lib/learnings/actions";
import { type Learning, type LearningActor, learningRights, MAX_LEARNINGS, MAX_PENDING_SUGGESTIONS, parseLearningText } from "@/lib/learnings/rules";
import { MAX_AGENT_CONTEXT_BYTES, renderAgentContext, utf8Bytes } from "@/lib/runtime/agent-context";
import { boxRequestSignature, boxRequestValid, gitCredentialSignature } from "@/lib/runtime/git-credential";
import { callSessionTool } from "@/lib/session-tools/tools";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000a2";
const admin: LearningActor = { userId: "u-admin", orgId: ORG, role: "admin" };
const member: LearningActor = { userId: "u-member", orgId: ORG, role: "member" };
const outsider: LearningActor = { userId: "u-out", orgId: OTHER_ORG, role: "admin" };

/** A store in memory, and the audit log's entries. */
function deps(): LearningDeps & { rows: Learning[]; audited: string[] } {
  const rows: Learning[] = [];
  const audited: string[] = [];
  let n = 0;
  const store: LearningStore = {
    list: async (where, status) => rows.filter((l) => ("orgId" in where ? l.orgId === where.orgId : l.userId === where.userId) && (!status || l.status === status)),
    count: async (where, { status, createdBy }) => rows.filter((l) =>
      ("orgId" in where ? l.orgId === where.orgId : l.userId === where.userId) &&
      l.status === status && (createdBy === undefined || l.createdBy === createdBy)
    ).length,
    get: async (id) => rows.find((l) => l.id === id) ?? null,
    insert: async (row) => {
      const now = new Date(Date.UTC(2026, 10, 3, 0, 0, n)).toISOString();
      const learning: Learning = { id: `l-${++n}`, scope: row.orgId ? "org" : "personal", ...row, createdAt: now, updatedAt: now };
      rows.push(learning);
      return learning;
    },
    update: async (id, patch) => {
      const learning = rows.find((l) => l.id === id);
      if (!learning) return null;
      Object.assign(learning, patch);
      return learning;
    },
    remove: async (id) => {
      const i = rows.findIndex((l) => l.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
  };
  return { store, rows, audited, audit: async (action, learning) => void audited.push(`${action} ${learning.title}`) };
}

test("a learning's text is trimmed and held to its bounds", () => {
  assert.deepEqual(parseLearningText({ title: " Commits ", body: "Use them.\n\n\n\nAlways." }), { title: "Commits", body: "Use them.\n\nAlways." });
  assert.match(parseLearningText({ title: "", body: "x" }) as string, /title/);
  assert.match(parseLearningText({ title: "a\nb", body: "x" }) as string, /one line/);
  assert.match(parseLearningText({ title: "t", body: "x".repeat(2001) }) as string, /2000/);
  assert.deepEqual(parseLearningText({ body: "only this" }, { partial: true }), { body: "only this" });
});

test("an org's learnings are its admins' to write and its members' to read; a person's are theirs alone", async () => {
  const d = deps();
  const team = await createLearning(admin, d, { scope: "org", title: "Commits", body: "Use Conventional Commits." });
  assert.equal(team.status, "active");
  const mine = await createLearning(member, d, { scope: "personal", title: "Brief", body: "Be brief." });
  assert.equal(mine.status, "active");

  assert.deepEqual(learningRights(member, team), { read: true, write: false });
  assert.deepEqual(learningRights(admin, mine), { read: false, write: false });
  assert.deepEqual(learningRights(outsider, team), { read: false, write: false });
  assert.deepEqual(
    (await listLearnings(member, d)).map((l) => l.title),
    ["Commits", "Brief"],
  );
  assert.deepEqual(
    (await listLearnings(admin, d)).map((l) => l.title),
    ["Commits"],
  );

  await assert.rejects(updateLearning(member, d, team.id, { body: "Never mind." }), (e) => e instanceof LearningError && e.status === 403);
  await assert.rejects(deleteLearning(admin, d, mine.id), (e) => e instanceof LearningError && e.status === 404);
  await assert.rejects(deleteLearning(outsider, d, team.id), (e) => e instanceof LearningError && e.status === 404);
  assert.deepEqual(d.audited, ["learning.created Commits"]);
});

test("a member's learning for the org is a suggestion an admin accepts or dismisses", async () => {
  const d = deps();
  const suggested = await createLearning(member, d, { scope: "org", title: "Tests", body: "Run pnpm check before a PR." });
  assert.equal(suggested.status, "suggested");
  // Its suggester sees it; another member doesn't until it's accepted.
  const other: LearningActor = { userId: "u-other", orgId: ORG, role: "member" };
  assert.equal(learningRights(member, suggested).read, true);
  assert.equal(learningRights(other, suggested).read, false);
  assert.equal((await sessionLearnings(d.store, "u-other", ORG)).org.length, 0);

  const accepted = await updateLearning(admin, d, suggested.id, { status: "active" });
  assert.equal(accepted.status, "active");
  assert.equal((await sessionLearnings(d.store, "u-other", ORG)).org.length, 1);
  await assert.rejects(updateLearning(admin, d, suggested.id, { status: "suggested" }), /can't go back/);

  const dismissed = await createLearning(member, d, { scope: "org", title: "Nope", body: "Never test." });
  await deleteLearning(admin, d, dismissed.id);
  assert.deepEqual(d.audited, ["learning.suggested Tests", "learning.accepted Tests", "learning.suggested Nope", "learning.deleted Nope"]);
});

test("a scope holds at most so many learnings", async () => {
  const d = deps();
  for (let i = 0; i < MAX_LEARNINGS; i++) await createLearning(member, d, { scope: "personal", title: `L${i}`, body: "x" });
  await assert.rejects(createLearning(member, d, { scope: "personal", title: "one more", body: "x" }), (e) => e instanceof LearningError && e.status === 409);
  // A suggestion still waits, but can't be accepted past the bound.
  const waiting = await createLearning(member, d, { scope: "personal", title: "waiting", body: "x", suggested: true });
  await assert.rejects(updateLearning(member, d, waiting.id, { status: "active" }), (e) => e instanceof LearningError && e.status === 409);
  // The org's are counted apart.
  await createLearning(admin, d, { scope: "org", title: "Team", body: "x" });
});

test("a session loads its org's and its user's active learnings, as a block", async () => {
  const d = deps();
  await createLearning(admin, d, { scope: "org", title: "Commits", body: "Use Conventional Commits." });
  await createLearning(member, d, { scope: "personal", title: "Brief", body: "Be brief." });
  await createLearning(member, d, { scope: "personal", title: "Pending", body: "x", suggested: true });
  const learnings = await sessionLearnings(d.store, "u-member", ORG);
  const block = renderAgentContext({ orgName: "Acme", learnings });
  assert.match(block, /^# Outrunner learnings/);
  assert.match(block, /## Acme's learnings[\s\S]*### Commits\n\nUse Conventional Commits\./);
  assert.match(block, /## The user's learnings[\s\S]*### Brief\n\nBe brief\./);
  assert.doesNotMatch(block, /Pending/);
  assert.equal(renderAgentContext({ orgName: null, learnings: { org: [], personal: [] } }), "");

});

test("past the bound, whole learnings are left out, measured in bytes, and the user's own keep room", () => {
  const at = "2026-11-03T00:00:00.000Z";
  const learning = (title: string, body: string, scope: "org" | "personal"): Learning => ({
    id: title, scope, orgId: scope === "org" ? ORG : null, userId: scope === "personal" ? "u" : null, title, body,
    status: "active", createdBy: "u", suggestedIn: null, createdAt: at, updatedAt: at,
  });
  // Three bytes a character: 100 of them is far past the bound in bytes, not in characters.
  const org = Array.from({ length: 100 }, (_, i) => learning(`Org ${i}`, "規則".repeat(999), "org"));
  const personal = Array.from({ length: 10 }, (_, i) => learning(`Mine ${i}`, `Rule ${i}: end of rule.`, "personal"));
  const block = renderAgentContext({ orgName: "Acme", learnings: { org, personal } });
  assert.ok(utf8Bytes(block) <= MAX_AGENT_CONTEXT_BYTES, `${utf8Bytes(block)} bytes`);
  assert.match(block, /left out/);
  // Every org learning shown is whole, and every one of the user's is there.
  const bodies = [...block.matchAll(/### Org \d+\n\n([規則]+)/g)].map((m) => m[1]);
  assert.ok(bodies.length > 0 && bodies.length < 100);
  for (const body of bodies) assert.equal(body, "規則".repeat(999));
  for (let i = 0; i < 10; i++) assert.match(block, new RegExp(`Rule ${i}: end of rule\\.`));
});

test("suggestions are held to a few waiting per person, apart from the learnings' own bound", async () => {
  const d = deps();
  for (let i = 0; i < MAX_PENDING_SUGGESTIONS; i++) await createLearning(member, d, { scope: "org", title: `S${i}`, body: "x" });
  await assert.rejects(createLearning(member, d, { scope: "org", title: "one more", body: "x" }), /already waiting/);
  // Another member, and an admin's own, aren't held by them.
  await createLearning({ userId: "u-other", orgId: ORG, role: "member" }, d, { scope: "org", title: "theirs", body: "x" });
  await createLearning(admin, d, { scope: "org", title: "Real", body: "x" });
});

test("caps count the full scope even when the displayed list is incomplete", async () => {
  const d = deps();
  for (let person = 0; person < 60; person++) {
    const actor = { ...member, userId: `teammate-${person}` };
    for (let i = 0; i < MAX_PENDING_SUGGESTIONS; i++) {
      await createLearning(actor, d, { scope: "org", title: `S${i}`, body: "x" });
    }
  }
  for (let i = 0; i < MAX_PENDING_SUGGESTIONS; i++) {
    await createLearning(member, d, { scope: "org", title: `Mine${i}`, body: "x" });
  }
  for (let i = 0; i < MAX_LEARNINGS; i++) {
    await createLearning(admin, d, { scope: "org", title: `Active${i}`, body: "x" });
  }
  const own = await listLearnings(member, d, { scope: "org", status: "suggested" });
  assert.equal(own.length, MAX_PENDING_SUGGESTIONS);
  assert.equal(own.at(-1)?.title, "Mine9");
  assert.equal((await listLearnings(admin, d, { scope: "org" })).length, 710);

  // Counts must remain exact independently of the list the caller has loaded.
  const list = d.store.list;
  d.store.list = async (...args) => (await list(...args)).slice(0, 500);
  await assert.rejects(createLearning(member, d, { scope: "org", title: "extra", body: "x" }), /already waiting/);
  await assert.rejects(createLearning(admin, d, { scope: "org", title: "extra", body: "x" }), /100 learnings/);
  await assert.rejects(updateLearning(admin, d, own[0].id, { status: "active" }), /100 learnings/);
});

test("a personal org has no learnings of its own", async () => {
  const d = { ...deps(), personalOrg: async () => true };
  await assert.rejects(createLearning(admin, d, { scope: "org", title: "T", body: "x" }), (e) => e instanceof LearningError && e.status === 400);
  await createLearning(admin, d, { scope: "personal", title: "T", body: "x" });
});

test("an agent's suggestion is filed for its user to accept, in its session's org", async () => {
  const d = deps();
  const toolDeps = {
    actor: async (userId: string, orgId: string) => (orgId === ORG && userId === "u-member" ? member : null),
    learnings: d,
    base: "https://app.outrunner.sh",
  };
  const scope = { userId: "u-member", orgId: ORG, workspaceId: "ws-1" };
  const answer = await callSessionTool(scope, "suggest_learning", { title: "Commits", body: "Use Conventional Commits." }, toolDeps);
  assert.equal(answer.status, 201);
  assert.match(answer.text ?? "", /isn't saved[\s\S]*https:\/\/app\.outrunner\.sh\/settings\/learnings/);
  assert.equal(d.rows[0].status, "suggested");
  assert.equal(d.rows[0].userId, "u-member");
  assert.equal(d.rows[0].suggestedIn, "ws-1");

  const org = await callSessionTool(scope, "suggest_learning", { scope: "org", title: "T", body: "x" }, toolDeps);
  assert.match(org.text ?? "", /org's admins/);
  assert.equal(d.rows[1].orgId, ORG);
  assert.equal(d.rows[1].status, "suggested");

  assert.equal((await callSessionTool(scope, "suggest_learning", { title: "" }, toolDeps)).status, 400);
  // In a personal org, --org is the user's own.
  const personalOrgDeps = { ...toolDeps, learnings: { ...d, personalOrg: async () => true } };
  await callSessionTool(scope, "suggest_learning", { scope: "org", title: "Mine", body: "x" }, personalOrgDeps);
  assert.equal(d.rows.at(-1)?.scope, "personal");
  assert.equal((await callSessionTool(scope, "erase_everything", {}, toolDeps)).status, 404);
  assert.equal((await callSessionTool({ ...scope, userId: "u-gone" }, "suggest_learning", { title: "T", body: "x" }, toolDeps)).status, 403);
});

test("a box's request is signed for its purpose, as its agent signs it", () => {
  // The same value runtime-agent/internal/gitcred's TestSignForIsTheControlPlanes holds.
  assert.equal(
    boxRequestSignature("session-tools", "secret", "sbx", "1700000000", "{}"),
    "sha256=6db278af454dc928998566c548682c1a4361681913f9c351d2946ffdb39fe8cc",
  );
  const now = 1700000000;
  const signature = gitCredentialSignature("secret", "sbx", String(now), "{}");
  const request = { sandboxId: "sbx", timestamp: String(now), signature, body: "{}" };
  assert.equal(boxRequestValid("git-credential", "secret", request, now), true);
  assert.equal(boxRequestValid("session-tools", "secret", request, now), false);
});


test("keyset learning pages retain later rows when an earlier row is deleted", async () => {
  const { learningPages, learningPageFilter } = await import("@/lib/learnings/pages");
  const rows = Array.from({ length: 710 }, (_, i) => ({
    id: String(i).padStart(4, "0"), created_at: "2026-11-03T00:00:00Z",
  }));
  let calls = 0;
  const got = await learningPages(async (cursor, limit) => {
    calls++;
    if (cursor) {
      rows.shift();
      assert.equal(learningPageFilter(cursor),
        "created_at.gt.2026-11-03T00:00:00Z,and(created_at.eq.2026-11-03T00:00:00Z,id.gt.0499)");
    }
    return rows.filter((r) => !cursor || r.created_at > cursor.created_at ||
      (r.created_at === cursor.created_at && r.id > cursor.id)).slice(0, limit);
  });
  assert.equal(calls, 2);
  assert.equal(got.length, 710);
  assert.equal(got[500].id, "0500");
  assert.equal(got[709].id, "0709");
});
