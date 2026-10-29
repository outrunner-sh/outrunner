import assert from "node:assert/strict";
import { test } from "node:test";
import { restrictToChannel, slackAccountActive, accessCommand, canReadItem, channelReader, type ChannelReader } from "@/lib/slack/channel-access";
import { configureChannelAccess, runChannelQuestion, type SharedChannelDeps } from "@/lib/slack/shared-channel";
import type { ChannelSettings } from "@/lib/db/slack-channels";
import { agentTurn } from "@/lib/slack/agent-model";
import type { TriageActor } from "@/lib/triage/access";

const where = { teamId: "T1", channel: "C1", user: "U_NARENDRA" };
const admin: TriageActor = { userId: "admin", orgId: "org1", orgLevel: "write", levels: new Map([["web", "write"], ["api", "write"]]) };
const projects = [{ id: "web", fullName: "acme/web" }, { id: "api", fullName: "acme/api" }];
const answer = (message = "Shipped #42") => JSON.stringify({ action: "answer", message, spec: null, research: null });

function fixture() {
  let settings: ChannelSettings | null = { ...where, channelId: "C1", orgId: "org1", setBy: "admin", watch: true,
    digest: "weekly", digestHour: 9, digestTz: "UTC", lastDigestOn: null,
    sharedBy: "admin", sharedProjects: ["web"], sharedRevision: "r1" };
  let active = true;
  const audits: { reader: ChannelReader; action: string; tool?: string }[] = [];
  const saved: string[][] = [];
  const lookups: { tool: string; ids: string[]; orgId: string }[] = [];
  const deps: SharedChannelDeps = {
    settings: async (team, channel) => team === "T1" && channel === "C1" ? settings : null,
    adminActive: async (id, org) => active && id === "admin" && org === "org1",
    projects: async (org) => org === "org1" ? projects : [],
    channel: async () => ({ id: "C1", is_member: true, is_ext_shared: false, is_org_shared: false, is_shared: false, shared_team_ids: ["T1"] }),
    sender: async () => ({ id: where.user, team_id: "T1" }),
    save: async (_actor, ids) => {
      saved.push(ids);
      settings = { ...settings!, sharedProjects: ids, sharedBy: ids.length ? "admin" : null, sharedRevision: ids.length ? "r2" : null };
    },
    audit: async (reader, action, tool) => { audits.push({ reader, action, tool }); },
    lookup: async (tool, reader) => {
      lookups.push({ tool, ids: [...reader.levels.keys()], orgId: reader.orgId });
      return '{"merged":[{"title":"Shipped #42"}]}';
    },
    model: async (_org, messages, tools) => {
      assert.equal(messages.length, 2); // No replay of earlier, potentially broader, thread answers.
      assert.deepEqual(Object.keys(tools), ["recent_work", "find_items", "item_status"]);
      await tools.recent_work({ days: 7 });
      return answer();
    },
  };
  return { deps, audits, saved, lookups, get settings() { return settings; }, set settings(value) { settings = value; },
    deactivate: () => { active = false; } };
}

test("an unlinked channel sender gets only explicitly delegated read projects, never an owner identity", async () => {
  const f = fixture();
  const reader = await channelReader(where, f.deps);
  assert.ok(reader);
  assert.deepEqual([...reader.levels], [["web", "read"]]);
  assert.equal("userId" in reader, false);
  assert.equal(canReadItem(reader, { projectId: "web" }), true);
  assert.equal(canReadItem(reader, { projectId: "api" }), false);
  assert.equal(canReadItem(reader, { projectId: null }), false);
  assert.equal(await runChannelQuestion(reader, "What shipped this week?", f.deps), "Shipped #42");
  assert.deepEqual(f.lookups, [{ tool: "recent_work", ids: ["web"], orgId: "org1" }]);
  assert.deepEqual(f.audits.map((a) => [a.action, a.reader.slackUserId, a.reader.authorizedBy]),
    [["asked", "U_NARENDRA", "admin"], ["lookup", "U_NARENDRA", "admin"]]);
});

test("installation/watch/digest settings alone never authorize shared questions", async () => {
  for (const patch of [{ sharedBy: null }, { sharedRevision: null }, { sharedProjects: [] }]) {
    const f = fixture(); f.settings = { ...f.settings!, ...patch };
    assert.equal(await channelReader(where, f.deps), null);
  }
  const f = fixture(); f.settings = null;
  assert.equal(await channelReader(where, f.deps), null);
});

test("team, channel, DM, group DM, external sender and Slack Connect boundaries fail closed", async () => {
  const f = fixture();
  for (const location of [{ ...where, teamId: "T2" }, { ...where, channel: "C2" }, { ...where, channelType: "im" }, { ...where, channel: "D1" }]) {
    assert.equal(await channelReader(location, f.deps), null);
  }
  for (const patch of [{ is_ext_shared: true }, { is_org_shared: true }, { is_shared: true }, { shared_team_ids: ["T1", "T2"] },
    { is_member: false }, { is_mpim: true }, { is_im: true }, { is_shared: undefined }]) {
    const channel = await f.deps.channel();
    assert.equal(await channelReader(where, { ...f.deps, channel: async () => ({ ...channel, ...patch }) }), null);
  }
  for (const patch of [{ team_id: "T2" }, { team_id: undefined }, { deleted: true }, { is_stranger: true }, { is_bot: true }, { id: "U_OTHER" }]) {
    assert.equal(await channelReader(where, { ...f.deps, sender: async () => ({ id: where.user, team_id: "T1", ...patch }) }), null);
  }
  await assert.rejects(channelReader(where, { ...f.deps, channel: async () => { throw new Error("missing_scope"); } }), /missing_scope/);
});

test("removed/disabled/demoted admin and moved/deleted repositories invalidate existing grants", async () => {
  const f = fixture();
  f.deactivate();
  assert.equal(await channelReader(where, f.deps), null);
  const g = fixture();
  assert.equal(await channelReader(where, { ...g.deps, projects: async () => [projects[1]] }), null);
});

test("scope changes and revocation during a model turn suppress the result and further lookups", async () => {
  for (const patch of [{ sharedRevision: null }, { sharedRevision: "replacement" }, { sharedProjects: ["api"] }, { orgId: "org2" }]) {
    const f = fixture(); const reader = (await channelReader(where, f.deps))!;
    f.deps.model = async (_org, _messages, tools) => {
      await tools.item_status({ key: "OR-42" });
      f.settings = { ...f.settings!, ...patch };
      await assert.rejects(tools.find_items({}), /revoked or changed/);
      return answer("Old scope secret");
    };
    assert.equal(await runChannelQuestion(reader, "status?", f.deps), null);
    assert.equal(f.lookups.length, 1);
  }
});

test("revocation before a turn prevents model use, lookup and audit", async () => {
  const f = fixture(); const reader = (await channelReader(where, f.deps))!;
  f.settings = null;
  f.deps.model = async () => { assert.fail("must not call model"); };
  assert.equal(await runChannelQuestion(reader, "status?", f.deps), null);
  assert.deepEqual(f.audits, []);
  assert.deepEqual(f.lookups, []);
});

test("shared questions cannot file work, run research, change settings or start sessions", async () => {
  for (const action of ["ask", "research", "propose"]) {
    const f = fixture(); const reader = (await channelReader(where, f.deps))!;
    f.deps.model = async (_org, _messages, tools) => {
      assert.equal(tools.channel_settings, undefined);
      assert.equal(tools.start_session, undefined);
      return JSON.stringify({ action, message: "Run it", research: { repo: "acme/web", question: "Read code" },
        spec: { title: "Change code", repo: "acme/web", problem: "Bug", acceptance_criteria: ["Fixed"], out_of_scope: [], prompt: "Fix" } });
    };
    assert.match((await runChannelQuestion(reader, "Start a session", f.deps))!, /supports status and delivery questions/);
    assert.deepEqual(f.saved, []);
    assert.deepEqual(f.lookups, []);
  }
});

test("failed audit prevents shared data access", async () => {
  const f = fixture(); const reader = (await channelReader(where, f.deps))!;
  f.deps.audit = async () => { throw new Error("audit unavailable"); };
  f.deps.model = async () => { assert.fail("must not call model"); };
  await assert.rejects(runChannelQuestion(reader, "status?", f.deps), /audit unavailable/);
  assert.deepEqual(f.lookups, []);
});

test("only an exact explicit command grants a fixed named repository list", async () => {
  assert.equal(accessCommand("What shipped? Also maybe share access", "BOT"), null);
  assert.deepEqual(accessCommand("<@BOT> share channel access for acme/web, ACME/API", "BOT"), { action: "share", repos: ["acme/web", "acme/api"] });
  assert.deepEqual(accessCommand("share channel access for *", "BOT"), { action: "help" });
  const f = fixture();
  assert.match((await configureChannelAccess("<@BOT> share channel access for acme/web", "BOT", where, admin, f.deps))!, /Everyone in this channel/);
  assert.deepEqual(f.saved, [["web"]]);

});

test("ordinary linked users with org write cannot grant; unlinked users cannot grant or revoke", async () => {
  for (const actor of [null, { ...admin, userId: "member" }]) {
    for (const command of ["share channel access for acme/web", "revoke channel access"]) {
      const f = fixture();
      assert.match((await configureChannelAccess(command, "BOT", where, actor, f.deps))!, /Only a connected Outrunner org admin/);
      assert.deepEqual(f.saved, []);
    }
  }
});

test("setup rejects cross-org bindings, unknown/inaccessible repos, DMs and shared channels", async () => {
  for (const repos of ["other/secret", "acme/web, other/secret"]) {
    const f = fixture();
    assert.match((await configureChannelAccess(`share channel access for ${repos}`, "BOT", where, admin, f.deps))!, /No access was changed/);
    assert.deepEqual(f.saved, []);
  }
  const f = fixture(); f.settings = { ...f.settings!, orgId: "org2" };
  assert.match((await configureChannelAccess("share channel access for acme/web", "BOT", where, admin, f.deps))!, /different Outrunner org/);
  assert.deepEqual(f.saved, []);
  const g = fixture();
  assert.match((await configureChannelAccess("share channel access for acme/web", "BOT", { ...where, channelType: "im" }, admin, g.deps))!, /not DMs/);
  const channel = await g.deps.channel();
  assert.match((await configureChannelAccess("share channel access for acme/web", "BOT", where, admin,
    { ...g.deps, channel: async () => ({ ...channel, is_ext_shared: true }) }))!, /Slack Connect/);
  assert.deepEqual(g.saved, []);
});

test("explicit revoke invalidates existing readers, including when the channel has become shared", async () => {
  const f = fixture(); const reader = (await channelReader(where, f.deps))!;
  f.deps.channel = async () => { throw new Error("channel metadata unavailable"); };
  assert.match((await configureChannelAccess("<@BOT> revoke channel access", "BOT", where, admin, f.deps))!, /access is off/);
  assert.deepEqual(f.saved, [[]]);
  assert.equal(await channelReader(where, f.deps), null);
  assert.equal(await runChannelQuestion(reader, "What shipped?", f.deps), null);
});

test("linked reader permissions stay limited and preserve Unsorted visibility", () => {
  const linked: TriageActor = { ...admin, userId: "member", orgLevel: null, levels: new Map([["api", "read"]]) };
  assert.equal(canReadItem(linked, { projectId: "web" }), false);
  assert.equal(canReadItem(linked, { projectId: "api" }), true);
  assert.equal(canReadItem(linked, { projectId: null }), true);
});

test("banned or soft-deleted Outrunner accounts cannot authorize shared access", () => {
  const base = { id: "admin", app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "2026-01-01" };
  assert.equal(slackAccountActive({ ...base, deleted_at: "2026-01-02" }), false);
  assert.equal(slackAccountActive({ ...base, banned_until: "2099-01-01" }), false);
});

test("a shared channel scope intersects linked permissions and never widens them", async () => {
  const f = fixture(); const grant = (await channelReader(where, f.deps))!;
  const limited: TriageActor = { ...admin, userId: "member", orgLevel: null, levels: new Map([["api", "read"]]) };
  assert.deepEqual([...restrictToChannel(limited, grant).levels], []);
  assert.deepEqual([...restrictToChannel(admin, grant).levels], [["web", "read"]]);
  assert.equal(canReadItem(restrictToChannel(admin, grant), { projectId: null }), false);
  assert.equal(restrictToChannel(limited, null), limited);
  assert.deepEqual([...restrictToChannel({ ...admin, orgId: "another-org" }, grant).levels], []);
});

test("the actual model transport exposes only the supplied read tools and refuses forged mutation calls", async (t) => {
  let round = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    assert.deepEqual(request.tools.map((tool: { function: { name: string } }) => tool.function.name), ["recent_work", "reply"]);
    if (round++ === 0) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [
      { id: "forged", type: "function", function: { name: "channel_settings", arguments: '{"watch":true}' } },
      { id: "read", type: "function", function: { name: "recent_work", arguments: '{"days":7}' } },
    ] } }] }));
    assert.match(request.messages.find((message: { tool_call_id?: string }) => message.tool_call_id === "forged").content, /No tool channel_settings/);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Shipped #42" } }] }));
  });
  let reads = 0;
  const raw = await agentTurn("test-only-key", [{ role: "user", content: "What shipped?" }], { recent_work: async () => { reads++; return "[]"; } });
  assert.equal(JSON.parse(raw).message, "Shipped #42");
  assert.equal(reads, 1);
});
