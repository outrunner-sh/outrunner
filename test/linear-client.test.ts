import assert from "node:assert/strict";
import { test } from "node:test";

import {
  exchangeLinearCode,
  linearAddSessionUrl,
  linearAgentActivity,
  linearAttachLink,
  linearComment,
  linearRepositorySuggestions,
  linearSetIssueState,
  LINEAR_INSTALL_SCOPES,
  linearAuthorizeUrl,
  linearDuplicateOf,
  linearIssueCreator,
  linearIssueStanding,
  LinearRevokedError,
  linearTeamCatalog,
  LinearUnauthorizedError,
  LinearUnavailableError,
  linearViewer,
  refreshLinearToken,
  revokeLinearToken,
} from "@/lib/trackers/linear";
import { TrackerRefusedError } from "@/lib/trackers/errors";
import { isClosedStateType } from "@/lib/trackers/rules";

const CONFIG = { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/api/integrations/linear/callback" };
const NOW = 1_000_000;

type Sent = { url: string; init: RequestInit };

function fakeFetch(answer: unknown, status = 200) {
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

test("an install authorizes as the app's own user, able to be delegated and to write back", () => {
  const url = new URL(linearAuthorizeUrl(CONFIG, "install", "the-state"));
  assert.equal(url.origin + url.pathname, "https://linear.app/oauth/authorize");
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("scope"), "read,write,app:assignable,app:mentionable");
  assert.equal(url.searchParams.get("state"), "the-state");
  assert.equal(url.searchParams.get("redirect_uri"), CONFIG.redirectUri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.deepEqual([...LINEAR_INSTALL_SCOPES], ["read", "write", "app:assignable", "app:mentionable"]);
});

test("a person's link authorizes as themselves, only to read", () => {
  const url = new URL(linearAuthorizeUrl(CONFIG, "link", "s"));
  assert.equal(url.searchParams.get("actor"), "user");
  assert.equal(url.searchParams.get("scope"), "read");
});

test("a code is traded for tokens, with their lifetimes", async () => {
  const { fetcher, sent } = fakeFetch({ access_token: "a", refresh_token: "r", expires_in: 86_399 });
  const tokens = await exchangeLinearCode(CONFIG, "the-code", fetcher, NOW);
  assert.equal(tokens.accessToken, "a");
  assert.equal(tokens.refreshToken, "r");
  assert.equal(tokens.expiresAt.getTime(), NOW + 86_399_000);
  assert.equal(tokens.refreshExpiresAt?.getTime(), NOW + 30 * 24 * 60 * 60 * 1000);
  assert.equal(sent[0].url, "https://api.linear.app/oauth/token");
  const body = sent[0].init.body as URLSearchParams;
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "the-code");
  assert.equal(body.get("client_secret"), "secret");
});

test("a refresh sends the refresh token", async () => {
  const { fetcher, sent } = fakeFetch({ access_token: "a2", refresh_token: "r2", expires_in: 100 });
  const tokens = await refreshLinearToken(CONFIG, "r1", fetcher, NOW);
  assert.equal(tokens.refreshToken, "r2");
  const body = sent[0].init.body as URLSearchParams;
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "r1");
});

test("invalid_grant is for good; anything else is worth retrying", async () => {
  await assert.rejects(refreshLinearToken(CONFIG, "r", fakeFetch({ error: "invalid_grant" }, 400).fetcher), LinearRevokedError);
  await assert.rejects(refreshLinearToken(CONFIG, "r", fakeFetch({ error: "server_error" }, 500).fetcher), LinearUnavailableError);
  const down = (async () => {
    throw new Error("network");
  }) as unknown as typeof fetch;
  await assert.rejects(refreshLinearToken(CONFIG, "r", down), LinearUnavailableError);
});

test("a revoke sends only the token, as Linear asks", async () => {
  const { fetcher, sent } = fakeFetch({});
  await revokeLinearToken("t", fetcher);
  assert.equal(sent[0].url, "https://api.linear.app/oauth/revoke");
  assert.equal((sent[0].init.body as URLSearchParams).get("token"), "t");
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, undefined);
});

test("a revoke Linear refuses is logged: the token may have survived", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warned.push(message);
  try {
    await revokeLinearToken("t", fakeFetch({}, 400).fetcher);
    await revokeLinearToken("t", fakeFetch({}, 401).fetcher);
    await revokeLinearToken("t", fakeFetch({}, 200).fetcher);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warned, ["Linear: revoking a token answered 400", "Linear: revoking a token answered 401"]);
});

test("a failed revoke doesn't fail what it was part of", async () => {
  const down = (async () => {
    throw new Error("network");
  }) as unknown as typeof fetch;
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    await revokeLinearToken("t", down);
  } finally {
    console.warn = warn;
  }
});

test("a 401 isn't a revocation (the token may have just rotated), and its API being down isn't either", async () => {
  await assert.rejects(linearViewer("t", fakeFetch({}, 401).fetcher), LinearUnauthorizedError);
  await assert.rejects(linearViewer("t", fakeFetch({}, 500).fetcher), LinearUnavailableError);
  await assert.rejects(linearViewer("t", fakeFetch({ errors: [{}] }).fetcher), LinearUnavailableError);
});

test("a viewer says who the token is, and sends the token as a bearer", async () => {
  const viewer = { id: "u", name: "Ana", organization: { id: "o", name: "Acme", urlKey: "acme" } };
  const { fetcher, sent } = fakeFetch({ data: { viewer } });
  assert.deepEqual(await linearViewer("tok", fetcher), viewer);
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("an issue's standing is its team, and open unless closed or in the trash", async () => {
  const standing = (issue: unknown) => linearIssueStanding("t", "i", fakeFetch({ data: { issue } }).fetcher);
  const team = { id: "team" };
  assert.deepEqual(await standing({ trashed: false, team, state: { type: "started" } }), { teamId: "team", open: true, stateType: "started", delegateId: null });
  assert.deepEqual(await standing({ trashed: false, team, state: { type: "completed" } }), { teamId: "team", open: false, stateType: "completed", delegateId: null });
  assert.deepEqual(await standing({ trashed: false, team, state: { type: "canceled" } }), { teamId: "team", open: false, stateType: "canceled", delegateId: null });
  assert.deepEqual(await standing({ trashed: false, team, state: { type: "duplicate" } }), { teamId: "team", open: false, stateType: "duplicate", delegateId: null });
  assert.deepEqual(await standing({ trashed: true, team, state: { type: "started" } }), { teamId: "team", open: false, stateType: "started", delegateId: null });
  assert.equal((await standing({ trashed: false, team, state: { type: "started" }, delegate: { id: "app" } }))?.delegateId, "app");
  assert.equal(await standing(null), null);
});

test("an issue's creator is by display name; an integration's issue has none", async () => {
  const creator = (c: unknown) => linearIssueCreator("t", "i", fakeFetch({ data: { issue: { creator: c } } }).fetcher);
  assert.deepEqual(await creator({ id: "u", name: "Ana Full", displayName: "ana" }), { id: "u", name: "ana" });
  assert.deepEqual(await creator({ id: "u", name: "Ana Full", displayName: "" }), { id: "u", name: "Ana Full" });
  assert.equal(await creator(null), null);
});

test("a duplicate names its original, from its relations", async () => {
  const relations = (nodes: unknown[]) => fakeFetch({ data: { issue: { relations: { nodes } } } }).fetcher;
  assert.equal(await linearDuplicateOf("t", "i", relations([{ type: "related", relatedIssue: { id: "x" } }, { type: "duplicate", relatedIssue: { id: "y" } }])), "y");
  assert.equal(await linearDuplicateOf("t", "i", relations([{ type: "related", relatedIssue: { id: "x" } }])), null);
  assert.equal(await linearDuplicateOf("t", "i", fakeFetch({ data: { issue: null } }).fetcher), null);
});

test("a team's catalog has its labels and the workspace's, and people by display name", async () => {
  const { fetcher } = fakeFetch({
    data: {
      team: {
        states: { nodes: [{ id: "s", name: "Todo", type: "unstarted" }] },
        labels: { nodes: [{ id: "l1", name: "Team label" }] },
        members: { nodes: [{ id: "m", name: "Ana Full", displayName: "ana" }, { id: "n", name: "Ben", displayName: "" }] },
      },
      issueLabels: { nodes: [{ id: "l2", name: "Bug" }] },
    },
  });
  const catalog = await linearTeamCatalog("t", "team", fetcher);
  assert.deepEqual(catalog?.labels.map((l) => l.id), ["l1", "l2"]);
  assert.deepEqual(catalog?.members.map((m) => m.name), ["ana", "Ben"]);
  assert.equal(await linearTeamCatalog("t", "gone", fakeFetch({ data: { team: null, issueLabels: { nodes: [] } } }).fetcher), null);
});

test("an issue Linear no longer has is null, not a failure that spends its retries", async () => {
  // As Linear answered on a real workspace, Nov 8 2026: a 200, with these errors.
  for (const status of [200, 400]) {
    const gone = () =>
      fakeFetch({ errors: [{ message: "Entity not found: Issue", extensions: { type: "invalid input", code: "INPUT_ERROR", statusCode: 400 } }], data: null }, status).fetcher;
    assert.equal(await linearIssueStanding("t", "i", gone()), null);
    assert.equal(await linearIssueCreator("t", "i", gone()), null);
    assert.equal(await linearDuplicateOf("t", "i", gone()), null);
    assert.equal(await linearTeamCatalog("t", "team", gone()), null);
  }
});

test("any other GraphQL error is still worth retrying", async () => {
  const failing = () => fakeFetch({ errors: [{ message: "Internal server error" }] }).fetcher;
  await assert.rejects(linearIssueStanding("t", "i", failing()), LinearUnavailableError);
  await assert.rejects(linearIssueCreator("t", "i", failing()), LinearUnavailableError);
  await assert.rejects(linearDuplicateOf("t", "i", failing()), LinearUnavailableError);
  await assert.rejects(linearTeamCatalog("t", "team", failing()), LinearUnavailableError);
});

test("a token whose own user is gone counts as refused: Linear can say so right after a revoke", async () => {
  // As it answered on a real workspace, Nov 8 2026, immediately after a revoke; a
  // later call in the same run got a 401, and the refresh 0.6s after was refused.
  const gone = fakeFetch({ errors: [{ message: "Entity not found: User", extensions: { code: "INPUT_ERROR", statusCode: 400 } }] }, 400).fetcher;
  await assert.rejects(linearViewer("t", gone), LinearUnauthorizedError);
  await assert.rejects(linearViewer("t", fakeFetch({ errors: [{ message: "Internal server error" }] }).fetcher), LinearUnavailableError);
});

test("a 401 still comes first", async () => {
  await assert.rejects(linearIssueStanding("t", "i", fakeFetch({ errors: [{ message: "Entity not found: Issue" }] }, 401).fetcher), LinearUnauthorizedError);
});

test("an agent activity sends its content and signal as Linear's schema has them", async () => {
  const { fetcher, sent } = fakeFetch({ data: { agentActivityCreate: { success: true } } });
  await linearAgentActivity("t", "session", { type: "elicitation", body: "Which?" }, { signal: "select", signalMetadata: { options: [{ label: "a/b", value: "a/b" }] } }, fetcher);
  const { variables, query } = JSON.parse(sent[0].init.body as string);
  assert.match(query, /agentActivityCreate/);
  assert.deepEqual(variables.input, {
    agentSessionId: "session",
    content: { type: "elicitation", body: "Which?" },
    signal: "select",
    signalMetadata: { options: [{ label: "a/b", value: "a/b" }] },
  });
});

test("the other writes name what they change", async () => {
  const run = async (write: (f: typeof fetch) => Promise<unknown>) => {
    const { fetcher, sent } = fakeFetch({ data: { ok: { success: true } } });
    await write(fetcher);
    return JSON.parse(sent[0].init.body as string).variables;
  };
  assert.deepEqual(await run((f) => linearAddSessionUrl("t", "s", { label: "PR", url: "u" }, f)), { id: "s", input: { addedExternalUrls: [{ label: "PR", url: "u" }] } });
  assert.deepEqual(await run((f) => linearComment("t", "i", "hi", f)), { input: { issueId: "i", body: "hi" } });
  assert.deepEqual(await run((f) => linearSetIssueState("t", "i", "st", f)), { id: "i", input: { stateId: "st" } });
  assert.deepEqual(await run((f) => linearAttachLink("t", "i", "u", "PR #1", f)), { issueId: "i", url: "u", title: "PR #1" });
});

test("repository suggestions ask about github.com's repositories, and a missing issue has none", async () => {
  const { fetcher, sent } = fakeFetch({ data: { issueRepositorySuggestions: { suggestions: [{ repositoryFullName: "a/b", confidence: 0.9 }] } } });
  assert.deepEqual(await linearRepositorySuggestions("t", "i", "s", ["a/b"], fetcher), [{ repositoryFullName: "a/b", confidence: 0.9 }]);
  assert.deepEqual(JSON.parse(sent[0].init.body as string).variables.candidates, [{ hostname: "github.com", repositoryFullName: "a/b" }]);
  assert.deepEqual(await linearRepositorySuggestions("t", "i", "s", ["a/b"], fakeFetch({ errors: [{ message: "Entity not found: Issue" }] }).fetcher), []);
});

test("completed, canceled and duplicate are closed, and nothing else", () => {
  assert.equal(isClosedStateType("completed"), true);
  assert.equal(isClosedStateType("canceled"), true);
  assert.equal(isClosedStateType("duplicate"), true);
  for (const type of ["triage", "backlog", "unstarted", "started", undefined]) assert.equal(isClosedStateType(type), false);
});

test("what Linear won't ever take is told from what's worth retrying", async () => {
  // As it really answers: a 200, with the status in the error.
  const refused = { errors: [{ message: "Invalid activity type", extensions: { type: "invalid input", code: "INPUT_ERROR", statusCode: 400, userError: true } }] };
  await assert.rejects(linearViewer("t", fakeFetch(refused).fetcher), TrackerRefusedError);
  const limited = { errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED", statusCode: 400 } }] };
  await assert.rejects(linearViewer("t", fakeFetch(limited, 400).fetcher), LinearUnavailableError);
  const broken = { errors: [{ message: "Internal", extensions: { statusCode: 500 } }] };
  await assert.rejects(linearViewer("t", fakeFetch(broken, 500).fetcher), LinearUnavailableError);
});
