/** Who GitHub says may connect an installation to an org (audit finding 1). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { githubOwnership, linkIdentity } from "@/lib/github/installation-owner";

const org = { id: 42, accountLogin: "acme", accountType: "Organization" as const, accountId: 900 };
const user = { id: 43, accountLogin: "ada", accountType: "User" as const, accountId: 7 };

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
function github(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    asked.push(path);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer inst-token");
    const answer = answers[path] ?? { status: 404 };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
  return { doFetch, asked };
}
const token = async () => "inst-token";

test("a user account's installation: only that account owns it, with no call to GitHub", async () => {
  const { doFetch, asked } = github({});
  assert.equal(await githubOwnership(user, 7, token, doFetch), "account_owner");
  assert.equal(await githubOwnership(user, 8, token, doFetch), null);
  assert.equal(await githubOwnership({ ...user, accountId: null }, 7, token, doFetch), null, "an unknown account id owns nothing");
  assert.deepEqual(asked, []);
});

test("an organization's installation: an active owner, by id, as GitHub says now", async () => {
  const { doFetch, asked } = github({
    "/user/99": { status: 200, body: { id: 99, login: "grace" } },
    "/orgs/acme/memberships/grace": { status: 200, body: { state: "active", role: "admin", user: { id: 99 } } },
  });
  assert.equal(await githubOwnership(org, 99, token, doFetch), "org_owner");
  assert.deepEqual(asked, ["/user/99", "/orgs/acme/memberships/grace"]);
});

test("members, pending owners, renamed logins and refusals are not owners", async () => {
  const cases: Array<[string, Record<string, Answer>]> = [
    ["a plain member", { "/user/99": { status: 200, body: { id: 99, login: "grace" } }, "/orgs/acme/memberships/grace": { status: 200, body: { state: "active", role: "member" } } }],
    ["a pending owner", { "/user/99": { status: 200, body: { id: 99, login: "grace" } }, "/orgs/acme/memberships/grace": { status: 200, body: { state: "pending", role: "admin" } } }],
    ["the login now someone else's", { "/user/99": { status: 200, body: { id: 99, login: "grace" } }, "/orgs/acme/memberships/grace": { status: 200, body: { state: "active", role: "admin", user: { id: 5 } } } }],
    ["GitHub naming another user", { "/user/99": { status: 200, body: { id: 5, login: "grace" } } }],
    ["no Members permission (403)", { "/user/99": { status: 200, body: { id: 99, login: "grace" } }, "/orgs/acme/memberships/grace": { status: 403 } }],
    ["not a member (404)", { "/user/99": { status: 200, body: { id: 99, login: "grace" } } }],
    ["no such user", {}],
  ];
  for (const [name, answers] of cases) {
    assert.equal(await githubOwnership(org, 99, token, github(answers).doFetch), null, name);
  }
});

test("GitHub failing is an error, not a no", async () => {
  await assert.rejects(githubOwnership(org, 99, token, github({ "/user/99": { status: 502 } }).doFetch));
});

test("a rate limit is an error, not a no, primary or secondary", async () => {
  const user = { "/user/99": { status: 200, body: { id: 99, login: "grace" } } };
  for (const headers of [{ "x-ratelimit-remaining": "0" }, { "retry-after": "60" }] as Record<string, string>[]) {
    await assert.rejects(githubOwnership(org, 99, token, github({ "/user/99": { status: 403, headers } }).doFetch), /rate-limited/);
    await assert.rejects(
      githubOwnership(org, 99, token, github({ ...user, "/orgs/acme/memberships/grace": { status: 403, headers } }).doFetch),
      /rate-limited/,
    );
  }
  // A plain 403 (no Members permission) is still a no.
  const plain = github({ ...user, "/orgs/acme/memberships/grace": { status: 403, headers: { "x-ratelimit-remaining": "4999" } } });
  assert.equal(await githubOwnership(org, 99, token, plain.doFetch), null);
});

test("the identity a link is made with: the installer first, then a verified owner", async () => {
  const asked: number[] = [];
  const owns = (owner: number | null) => async (id: number) => {
    asked.push(id);
    return id === owner ? ("org_owner" as const) : null;
  };
  assert.deepEqual(await linkIdentity([5, 7], 7, owns(5)), { githubId: 7, verifiedOwner: null }, "the installer, unasked");
  assert.deepEqual(asked, []);
  assert.deepEqual(await linkIdentity([null, 5, 6], 7, owns(6)), { githubId: 6, verifiedOwner: "org_owner" });
  assert.deepEqual(await linkIdentity([5, 5], null, owns(null)), { githubId: 5, verifiedOwner: null }, "the database refuses it");
  assert.deepEqual(await linkIdentity([null, undefined], 7, owns(null)), { githubId: null, verifiedOwner: null });
  assert.deepEqual(await linkIdentity([-1, 1.5], 7, owns(null)), { githubId: null, verifiedOwner: null }, "nothing that isn't an id");
});
