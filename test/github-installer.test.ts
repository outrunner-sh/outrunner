import assert from "node:assert/strict";
import test from "node:test";

import { readInstallState, signInstallState, type GitHubAppConfig } from "@/lib/github/app";
import { authorizeUrl, githubUserFromCode } from "@/lib/github/installer";

const config = { clientId: "Iv1.app", slug: "outrunner", privateKey: "", webhookSecret: "s3cret" } as GitHubAppConfig;

test("the state on the way to asking GitHub carries the installation", () => {
  const state = signInstallState("s3cret", { orgId: "o", userId: "u", next: "/onboarding", installationId: 42 }, 1_000);
  assert.deepEqual(readInstallState("s3cret", state, 1_000), { orgId: "o", userId: "u", next: "/onboarding", installationId: 42 });
});

test("the authorize link names the App, where to come back, and the state", () => {
  const url = new URL(authorizeUrl("Iv1.app", "https://app.example/api/github/app/verify", "st"));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "Iv1.app");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example/api/github/app/verify");
  assert.equal(url.searchParams.get("state"), "st");
});

function fakeGitHub(answers: { token?: string; userId?: unknown; userOk?: boolean }) {
  const calls: string[] = [];
  const doFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/login/oauth/access_token")) {
      return Response.json(answers.token ? { access_token: answers.token } : { error: "bad_verification_code" });
    }
    if (url.endsWith("/user")) return Response.json({ id: answers.userId }, { status: answers.userOk === false ? 401 : 200 });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, doFetch };
}

test("a code is traded for the GitHub user's id, and its token revoked straight after", async () => {
  const { calls, doFetch } = fakeGitHub({ token: "ghu_x", userId: 84772210 });
  assert.equal(await githubUserFromCode(config, "secret", "code", "https://app/verify", doFetch), 84772210);
  assert.ok(calls.some((c) => c === "DELETE https://api.github.com/applications/Iv1.app/token"));
});

test("a code GitHub won't take, or a user it won't name, is no one", async () => {
  assert.equal(await githubUserFromCode(config, "secret", "code", "r", fakeGitHub({}).doFetch), null);
  const unnamed = fakeGitHub({ token: "ghu_x", userOk: false });
  assert.equal(await githubUserFromCode(config, "secret", "code", "r", unnamed.doFetch), null);
  assert.ok(unnamed.calls.some((c) => c.startsWith("DELETE")));
});
