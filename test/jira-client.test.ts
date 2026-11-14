import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { TrackerRefusedError, TrackerRevokedError, TrackerUnauthorizedError, TrackerUnavailableError } from "@/lib/trackers/errors";
import {
  jiraRefreshWebhook,
  fromAdf,
  jiraComment,
  JIRA_INSTALL_SCOPES,
  jiraAuthorizeUrl,
  type JiraConfig,
  jiraIsSiteAdmin,
  jiraIssueStanding,
  jiraMentions,
  jiraProjectCatalog,
  jiraProjects,
  jiraRegisterWebhook,
  jiraStateType,
  jiraTransition,
  jiraWebhookJql,
  refreshJiraToken,
  signJiraState,
  toAdf,
  verifyJiraState,
  jiraTokenSite,
  verifyJiraWebhookToken,
} from "@/lib/trackers/jira";
import { receiveJiraWebhook } from "@/lib/trackers/jira-webhook";

const SECRET = "fake-client-secret";
const NOW = 1_800_000_000_000;
const CONFIG: JiraConfig = { clientId: "fake-id", clientSecret: SECRET, redirectUri: "https://app.test/api/integrations/jira/callback", webhookUrl: "https://app.test/api/integrations/jira/webhook" };

function jwt(claims: Record<string, unknown>, { alg = "HS256", secret = SECRET }: { alg?: string; secret?: string } = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${encode({ alg, typ: "JWT" })}.${encode(claims)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

const answering = (body: unknown, status = 200) => (async () => new Response(body === null ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

test("a webhook's token is checked: its secret, its algorithm, and its expiry", () => {
  const live = { exp: NOW / 1000 + 60, iss: "cloud-1" };
  assert.deepEqual(verifyJiraWebhookToken(`Bearer ${jwt(live)}`, SECRET, NOW), live);
  assert.equal(verifyJiraWebhookToken(`Bearer ${jwt({})}`, SECRET, NOW), null, "real ones always carry one");
  assert.equal(verifyJiraWebhookToken(`Bearer ${jwt({ exp: NOW / 1000 - 1 })}`, SECRET, NOW), null, "expired");
  assert.equal(verifyJiraWebhookToken(`Bearer ${jwt({ exp: "soon" })}`, SECRET, NOW), null, "a strange expiry");
  assert.equal(verifyJiraWebhookToken(`Bearer ${jwt(live, { secret: "other" })}`, SECRET, NOW), null, "another's secret");
  assert.equal(verifyJiraWebhookToken(`Bearer ${jwt(live, { alg: "none" })}`, SECRET, NOW), null, "no token chooses how it's checked");
  assert.equal(verifyJiraWebhookToken(null, SECRET, NOW), null);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.equal(verifyJiraWebhookToken(`Bearer ${b64(null)}.${b64({ exp: NOW / 1000 + 60 })}.x`, SECRET, NOW), null, "a null header isn't a failure to answer");
  const signed = (claims: unknown) => {
    const head = `${b64({ alg: "HS256" })}.${b64(claims)}`;
    return `Bearer ${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
  };
  assert.deepEqual(verifyJiraWebhookToken(signed({ exp: NOW / 1000 + 60 }), SECRET, NOW), { exp: NOW / 1000 + 60 });
  assert.equal(verifyJiraWebhookToken(signed(null), SECRET, NOW), null, "nor null claims, even signed");
  assert.equal(verifyJiraWebhookToken(signed([NOW]), SECRET, NOW), null, "nor claims that aren't an object");
  assert.equal(verifyJiraWebhookToken("Bearer a.b", SECRET, NOW), null);
  assert.equal(verifyJiraWebhookToken(`Bearer ${jwt(live)}`, "", NOW), null, "no secret set");
});

test("a token's site is its context's cloud id, else its cloudId, else its issuer", () => {
  assert.deepEqual(jiraTokenSite({ context: { cloudId: "c-ctx" }, cloudId: "c-top", iss: "c-iss" }), {
    site: "c-ctx",
    from: "context.cloudId",
    keys: ["cloudId", "context", "iss"],
  });
  assert.deepEqual(jiraTokenSite({ cloudId: "c-top", iss: "c-iss" }), { site: "c-top", from: "cloudId", keys: ["cloudId", "iss"] });
  assert.deepEqual(jiraTokenSite({ iss: "c-iss", exp: 1 }), { site: "c-iss", from: "iss", keys: ["exp", "iss"] }, "says it was the issuer");
  assert.equal(jiraTokenSite({ context: null, cloudId: "", iss: 7 }), null);
  assert.equal(jiraTokenSite({ exp: 1 }), null);
});

test("nothing unsigned is parsed, a token naming no site is refused, and a failure asks Jira to try again", async () => {
  const body = new TextEncoder().encode(JSON.stringify({ webhookEvent: "jira:issue_created" }));
  const good = `Bearer ${jwt({ exp: Date.now() / 1000 + 60, context: { cloudId: "cloud-1" } })}`;
  const never = async () => assert.fail("not handled");
  assert.equal((await receiveJiraWebhook({ body, authorization: good, identifier: "x", secret: null }, never)).status, 404);
  assert.equal((await receiveJiraWebhook({ body, authorization: "Bearer nope", identifier: "x", secret: SECRET }, never)).status, 401);
  const siteless = `Bearer ${jwt({ exp: Date.now() / 1000 + 60, sub: "someone" })}`;
  assert.equal((await receiveJiraWebhook({ body, authorization: siteless, identifier: "x", secret: SECRET }, never)).status, 401);
  assert.equal((await receiveJiraWebhook({ body: new TextEncoder().encode("{"), authorization: good, identifier: "x", secret: SECRET }, never)).status, 400);
  const handled = await receiveJiraWebhook({ body, authorization: good, identifier: "x", secret: SECRET }, async (event) => {
    assert.equal(event.identifier, "x");
    assert.deepEqual(event.site, { site: "cloud-1", from: "context.cloudId", keys: ["context", "exp"] });
    return { handled: true };
  });
  assert.equal(handled.status, 200);
  const failed = await receiveJiraWebhook({ body, authorization: good, identifier: "x", secret: SECRET }, async () => {
    throw new Error("boom");
  });
  assert.equal(failed.status, 500);
});

test("the OAuth state is signed, and an install's must name an org", () => {
  const state = signJiraState({ kind: "install", ownerId: "u", orgId: "o", nonce: "n" }, SECRET, NOW);
  assert.deepEqual(verifyJiraState(state, SECRET, NOW), { kind: "install", ownerId: "u", orgId: "o", nonce: "n" });
  assert.equal(verifyJiraState(state, "other", NOW), null);
  assert.equal(verifyJiraState(state, SECRET, NOW + 11 * 60 * 1000), null, "expired");
  const orgless = signJiraState({ kind: "install", ownerId: "u", orgId: null, nonce: "n" }, SECRET, NOW);
  assert.equal(verifyJiraState(orgless, SECRET, NOW), null);
});

test("an install asks for what it writes with and offline access; a link only who you are", () => {
  const install = new URL(jiraAuthorizeUrl(CONFIG, "install", "s"));
  assert.equal(install.searchParams.get("audience"), "api.atlassian.com");
  assert.equal(install.searchParams.get("scope"), JIRA_INSTALL_SCOPES.join(" "));
  assert.match(install.searchParams.get("scope") ?? "", /offline_access/);
  const link = new URL(jiraAuthorizeUrl(CONFIG, "link", "s"));
  assert.doesNotMatch(link.searchParams.get("scope") ?? "", /write|offline|webhook/);
});

test("a reclaim's state needs its org and site, and asks only who they are and what they may do", () => {
  const state = signJiraState({ kind: "reclaim", ownerId: "u", orgId: "o", nonce: "n", siteId: "cloud-1" }, SECRET, NOW);
  assert.deepEqual(verifyJiraState(state, SECRET, NOW), { kind: "reclaim", ownerId: "u", orgId: "o", nonce: "n", siteId: "cloud-1" });
  assert.equal(verifyJiraState(signJiraState({ kind: "reclaim", ownerId: "u", orgId: "o", nonce: "n" }, SECRET, NOW), SECRET, NOW), null, "no site");
  assert.equal(verifyJiraState(signJiraState({ kind: "reclaim", ownerId: "u", orgId: null, nonce: "n", siteId: "c" }, SECRET, NOW), SECRET, NOW), null, "no org");
  const scopes = new URL(jiraAuthorizeUrl(CONFIG, "reclaim", "s")).searchParams.get("scope") ?? "";
  assert.equal(scopes, "read:me read:jira-work");
  assert.doesNotMatch(scopes, /write|offline|webhook/);
});

test("only Jira's own yes counts as a site admin", async () => {
  assert.equal(await jiraIsSiteAdmin("t", "c", answering({ permissions: { ADMINISTER: { havePermission: true } } })), true);
  assert.equal(await jiraIsSiteAdmin("t", "c", answering({ permissions: { ADMINISTER: { havePermission: false } } })), false);
  assert.equal(await jiraIsSiteAdmin("t", "c", answering({ permissions: {} })), false);
  assert.equal(await jiraIsSiteAdmin("t", "c", answering({ permissions: { ADMINISTER: { havePermission: "true" } } })), false);
  assert.equal(await jiraIsSiteAdmin("t", "c", answering({}, 404)), false);
});

test("Atlassian's answer to a dead refresh token is a 403 saying invalid_grant: that's revoked", async () => {
  await assert.rejects(refreshJiraToken(CONFIG, "r", answering({ error: "invalid_grant" }, 403)), TrackerRevokedError);
  await assert.rejects(refreshJiraToken(CONFIG, "r", answering({ error: "server_error" }, 500)), TrackerUnavailableError);
  const tokens = await refreshJiraToken(CONFIG, "r", answering({ access_token: "a", refresh_token: "b", expires_in: 3600 }), NOW);
  assert.equal(tokens.accessToken, "a");
  assert.equal(tokens.refreshToken, "b");
  assert.equal(tokens.expiresAt.getTime(), NOW + 3600 * 1000);
});

test("REST: a 401 is for the token logic, a 404 is nothing, and the rest is worth retrying", async () => {
  await assert.rejects(jiraIssueStanding("t", "c", "1", answering({}, 401)), TrackerUnauthorizedError);
  assert.equal(await jiraIssueStanding("t", "c", "1", answering({}, 404)), null);
  await assert.rejects(jiraIssueStanding("t", "c", "1", answering({}, 503)), TrackerUnavailableError);
});

test("an issue's standing: only a person counts as its creator", async () => {
  const fields = {
    summary: "S",
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] },
    project: { id: "10000" },
    status: { id: "5", statusCategory: { key: "done" } },
    creator: { accountId: "ana", displayName: "Ana", accountType: "atlassian" },
    issuelinks: [
      { type: { name: "Relates" }, outwardIssue: { id: "7" } },
      { type: { name: "Duplicate" }, outwardIssue: { id: "8" } },
    ],
  };
  const standing = await jiraIssueStanding("t", "c", "1", answering({ key: "ENG-1", fields }));
  assert.deepEqual(standing, { teamId: "10000", key: "ENG-1", title: "S", description: "Body", open: false, stateType: "completed", creatorId: "ana", creatorName: "Ana", duplicateOf: "8", assigneeId: null });
  const bot = await jiraIssueStanding("t", "c", "1", answering({ fields: { ...fields, creator: { accountId: "auto", displayName: "Automation for Jira", accountType: "app" } } }));
  assert.equal(bot?.creatorId, null);
  assert.equal(bot?.creatorName, null);
});

test("a project's catalog: statuses once each, in the words the rest of the code reads", async () => {
  const answers: Record<string, unknown> = {
    "/project/10000/statuses": [
      { id: "10001", name: "Bug", statuses: [{ id: "1", name: "To Do", statusCategory: { key: "new" } }, { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } }] },
      { id: "10002", name: "Task", statuses: [{ id: "1", name: "To Do", statusCategory: { key: "new" } }, { id: "5", name: "Done", statusCategory: { key: "done" } }] },
    ],
    "/label": { values: ["bug"] },
    "/priority": [{ id: "1", name: "Highest" }],
    "/user/assignable/search": [{ accountId: "ana", displayName: "Ana" }],
  };
  const fetcher = (async (url: string) => {
    const path = Object.keys(answers).find((p) => url.includes(p));
    return new Response(JSON.stringify(path ? answers[path] : null));
  }) as unknown as typeof fetch;
  const catalog = await jiraProjectCatalog("t", "c", "10000", fetcher);
  assert.deepEqual(catalog?.states.map((s) => [s.id, s.type]), [["1", "unstarted"], ["3", "started"], ["5", "completed"]]);
  assert.deepEqual(catalog?.issueTypes, [{ id: "10001", name: "Bug" }, { id: "10002", name: "Task" }]);
  assert.deepEqual(catalog?.labels, [{ id: "bug", name: "bug" }]);
  assert.deepEqual(catalog?.members, [{ id: "ana", name: "Ana" }]);
  assert.equal(jiraStateType("done"), "completed");
});

test("the webhook's query is only project ids, and a refusal says why", async () => {
  assert.equal(jiraWebhookJql(["10000", "10001", "1 or x"]), "project in (10000, 10001)");
  assert.equal(await jiraRegisterWebhook("t", "c", "https://app.test/w", ["10000"], answering({ webhookRegistrationResult: [{ createdWebhookId: 42 }] })), 42);
  await assert.rejects(jiraRegisterWebhook("t", "c", "https://app.test/w", ["10000"], answering({ webhookRegistrationResult: [{ errors: ["The clause x is unsupported"] }] })), /unsupported/);
});

test("a transition only goes where the workflow offers", async () => {
  const posted: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ transitions: [{ id: "11", to: { id: "3" } }] }));
  }) as unknown as typeof fetch;
  assert.equal(await jiraTransition("t", "c", "1", "9", fetcher), false);
  assert.deepEqual(posted, []);
  assert.equal(await jiraTransition("t", "c", "1", "3", fetcher), true);
  assert.deepEqual(posted, [{ transition: { id: "11" } }]);
});

const adf = (markdown: string) => (toAdf(markdown) as { content: unknown[] }).content;

test("text goes out as a document, with its links as links, and a sentence's end isn't one", () => {
  assert.deepEqual(toAdf("Hi\n\nSee [the session](https://a.test/1) or https://b.test/2."), {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hi" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See " },
          { type: "text", text: "the session", marks: [{ type: "link", attrs: { href: "https://a.test/1" } }] },
          { type: "text", text: " or " },
          { type: "text", text: "https://b.test/2", marks: [{ type: "link", attrs: { href: "https://b.test/2" } }] },
          { type: "text", text: "." },
        ],
      },
    ],
  });
});

test("a session's markdown reads as it should in Jira", () => {
  assert.deepEqual(adf("## Fixed it"), [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Fixed it" }] }]);
  assert.deepEqual(adf("```ts\nconst a = 1;\n\nconst b = 2;\n```\nAfter"), [
    { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;\n\nconst b = 2;" }] },
    { type: "paragraph", content: [{ type: "text", text: "After" }] },
  ]);
  assert.deepEqual(adf("- one\n- **two**\n\n1. first\n2) second"), [
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two", marks: [{ type: "strong" }] }] }] },
      ],
    },
    {
      type: "orderedList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
      ],
    },
  ]);
  assert.deepEqual(adf("a **b** *c* `d` __e__ _f_"), [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "a " },
        { type: "text", text: "b", marks: [{ type: "strong" }] },
        { type: "text", text: " " },
        { type: "text", text: "c", marks: [{ type: "em" }] },
        { type: "text", text: " " },
        { type: "text", text: "d", marks: [{ type: "code" }] },
        { type: "text", text: " " },
        { type: "text", text: "e", marks: [{ type: "strong" }] },
        { type: "text", text: " " },
        { type: "text", text: "f", marks: [{ type: "em" }] },
      ],
    },
  ]);
  assert.deepEqual(adf("> quoted\n---"), [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] }, { type: "rule" }]);
});

test("an ordered list broken by a blank line goes on counting", () => {
  const lists = adf("1. a\n\n2. b\n3. c") as { type: string; attrs?: { order?: number }; content: unknown[] }[];
  assert.deepEqual(lists.map((list) => [list.type, list.attrs?.order, list.content.length]), [["orderedList", undefined, 1], ["orderedList", 2, 2]]);
  const bullets = adf("- a\n\n- b") as { attrs?: unknown }[];
  assert.equal(bullets[1]?.attrs, undefined);
});

test("what isn't markdown stays as written, and nothing makes an invalid document", () => {
  assert.deepEqual(adf("2 * 3 * 4"), [{ type: "paragraph", content: [{ type: "text", text: "2 * 3 * 4" }] }]);
  assert.deepEqual((adf("snake_case_name")[0] as { content: unknown[] }).content, [{ type: "text", text: "snake_case_name" }]);
  assert.deepEqual(adf(""), [{ type: "paragraph", content: [] }], "a document needs something");
  assert.deepEqual(adf("```\nno end"), [{ type: "codeBlock", content: [{ type: "text", text: "no end" }] }]);
  assert.deepEqual(adf("```\n```"), [{ type: "codeBlock", content: [] }], "Jira refuses an empty text node");
  const walk = (node: unknown): void => {
    const value = node as { type?: string; text?: string; content?: unknown[] };
    if (value.type === "text") assert.ok(value.text, "no empty text");
    value.content?.forEach(walk);
  };
  for (const text of ["## ", "- ", "> ", "****", "``", "[x]()", "\n\n"]) walk(toAdf(text));
});

test("every page of a big site's projects comes back", async () => {
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(new URL(url).searchParams.get("startAt") ?? "");
    const start = Number(new URL(url).searchParams.get("startAt"));
    const values = Array.from({ length: start < 200 ? 100 : 5 }, (_, i) => ({ id: String(start + i), key: `K${start + i}`, name: "N", extra: true }));
    return new Response(JSON.stringify({ values, isLast: start >= 200 }));
  }) as unknown as typeof fetch;
  const projects = await jiraProjects("t", "c", fetcher);
  assert.equal(projects.length, 205);
  assert.deepEqual(asked, ["0", "100", "200"]);
  assert.deepEqual(projects[0], { id: "0", key: "K0", name: "N" });
  const endless = (async () => new Response(JSON.stringify({ values: [{ id: "1", key: "K", name: "N" }] }))) as unknown as typeof fetch;
  assert.equal((await jiraProjects("t", "c", endless)).length, 100, "bounded");
});

test("every comment goes out internal: on a service project, a plain one reaches the customer", async () => {
  let sent: { properties?: unknown } = {};
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "1" }));
  }) as unknown as typeof fetch;
  await jiraComment("t", "c", "1", "The repos are acme/web", fetcher);
  assert.deepEqual(sent.properties, [{ key: "sd.public.comment", value: { internal: true } }]);
});

test("a body comes in as a document or a wiki-markup string, and either mention counts", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "mention", attrs: { id: "app", text: "@Outrunner" } }, { type: "text", text: " look at this" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    ],
  };
  assert.equal(fromAdf(doc), "@Outrunner look at this\none");
  assert.equal(jiraMentions(doc, "app"), true);
  assert.equal(jiraMentions(doc, "other"), false);
  assert.equal(fromAdf("[~accountid:app] look"), "@someone look");
  assert.equal(jiraMentions("[~accountid:app] look", "app"), true);
  assert.equal(jiraMentions("[~accountid:app2] look", "app"), false);
  assert.equal(fromAdf(null), "");
  assert.equal(jiraMentions(null, "app"), false);
});

test("what Jira won't ever take is told from what's worth retrying", async () => {
  for (const status of [400, 403]) await assert.rejects(jiraIssueStanding("t", "c", "1", answering({}, status)), TrackerRefusedError);
  for (const status of [429, 500, 503]) await assert.rejects(jiraIssueStanding("t", "c", "1", answering({}, status)), TrackerUnavailableError);
});

test("a webhook's refresh checks it's still there: Jira answers with a date for one that isn't", async () => {
  const at = "2026-12-09T06:58:38.000Z";
  const answering2 = (values: { id: number }[], isLast = true) =>
    (async (url: string) => new Response(JSON.stringify(String(url).includes("/refresh") ? { expirationDate: at } : { values, isLast }))) as unknown as typeof fetch;
  assert.equal((await jiraRefreshWebhook("t", "c", 7, answering2([{ id: 7 }])))?.toISOString(), at);
  assert.equal(await jiraRefreshWebhook("t", "c", 7, answering2([{ id: 8 }])), null, "removed");
  assert.equal(await jiraRefreshWebhook("t", "c", 7, answering2([])), null, "none left");

  // Every page, before calling it gone.
  const seen: string[] = [];
  const paged = (pages: { values: { id: number }[]; isLast: boolean }[]) =>
    (async (url: string) => {
      if (String(url).includes("/refresh")) return new Response(JSON.stringify({ expirationDate: at }));
      seen.push(new URL(url).searchParams.get("startAt") as string);
      return new Response(JSON.stringify(pages[seen.length - 1]));
    }) as unknown as typeof fetch;
  assert.equal((await jiraRefreshWebhook("t", "c", 7, paged([{ values: [{ id: 1 }, { id: 2 }], isLast: false }, { values: [{ id: 7 }], isLast: true }])))?.toISOString(), at, "on the second page");
  assert.deepEqual(seen, ["0", "2"]);
  seen.length = 0;
  assert.equal(await jiraRefreshWebhook("t", "c", 7, paged([{ values: [{ id: 1 }], isLast: false }, { values: [{ id: 2 }], isLast: true }])), null, "on no page");
  assert.deepEqual(seen, ["0", "1"]);

  // A read that fails isn't missing: it leaves things as they are.
  const failing = (status: number, body: unknown = {}) =>
    (async (url: string) => (String(url).includes("/refresh") ? new Response(JSON.stringify({ expirationDate: at })) : new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
  await assert.rejects(jiraRefreshWebhook("t", "c", 7, failing(500)), TrackerUnavailableError);
  await assert.rejects(jiraRefreshWebhook("t", "c", 7, failing(401)), TrackerUnauthorizedError);
  assert.equal((await jiraRefreshWebhook("t", "c", 7, failing(404)))?.toISOString(), at, "no list at all isn't proof either");
  assert.equal((await jiraRefreshWebhook("t", "c", 7, failing(200, { oddly: true })))?.toISOString(), at);
});
