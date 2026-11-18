import assert from "node:assert/strict";
import { test } from "node:test";

import { isShellPrefetch, signInRedirect, type SignedIn } from "@/lib/auth/sign-in-redirect";

const page = (pathname: string, signedIn: SignedIn = false, search = "", method = "GET") =>
  signInRedirect({ method, pathname, search, signedIn });

test("a signed-out page load goes to sign-in, coming back to the path and query it asked for", () => {
  assert.equal(page("/workspaces/abc"), "/signin?next=%2Fworkspaces%2Fabc");
  assert.equal(
    page("/workspaces/abc", false, "?prompt=hi%20there"),
    `/signin?next=${encodeURIComponent("/workspaces/abc?prompt=hi%20there")}`,
  );
  assert.equal(page("/new", false, "?project=p1"), `/signin?next=${encodeURIComponent("/new?project=p1")}`);
  assert.equal(page("/settings/billing"), "/signin?next=%2Fsettings%2Fbilling");
  assert.equal(page("/onboarding"), "/signin?next=%2Fonboarding");
  assert.equal(page("/local/abc", false, "", "HEAD"), "/signin?next=%2Flocal%2Fabc");
});

test("home goes to plain sign-in, which already returns home", () => {
  assert.equal(page("/"), "/signin");
});

test("signed in, or not known to be signed out, is let through", () => {
  assert.equal(page("/workspaces/abc", true), null);
  assert.equal(page("/workspaces/abc", "unknown"), null);
});

test("API routes answer for themselves, with a 401 rather than a redirect", () => {
  assert.equal(page("/api/workspaces/abc/session"), null);
  assert.equal(page("/api"), null);
  assert.equal(page("/api/health"), null);
  assert.equal(page("/api/stripe/webhook"), null);
});

test("sign-in and the routes that handle it themselves stay open", () => {
  assert.equal(page("/signin"), null);
  assert.equal(page("/auth/callback", false, "?code=x"), null);
  assert.equal(page("/upgrade", false, "?plan=pro"), null);
});

test("a public prefix only matches whole path segments", () => {
  assert.equal(page("/signinfoo"), "/signin?next=%2Fsigninfoo");
  assert.equal(page("/apifoo"), "/signin?next=%2Fapifoo");
  assert.equal(page("/authors"), "/signin?next=%2Fauthors");
});

test("only page loads redirect: a post (a server action at sign-out) is let through", () => {
  assert.equal(page("/settings/account", false, "", "POST"), null);
});

test("`next` can never point off the site", () => {
  // A path the URL parser left starting with "//" must not become a
  // protocol-relative `next`.
  assert.equal(page("//evil.com"), "/signin");
  assert.equal(page("/\\evil.com"), "/signin");
});

test("the router prefetching a page's shell is told apart from a page load", () => {
  assert.equal(isShellPrefetch(new Headers({ "next-router-prefetch": "1" })), true);
  assert.equal(isShellPrefetch(new Headers({ "Next-Router-Segment-Prefetch": "/_tree" })), true);
  assert.equal(isShellPrefetch(new Headers({ rsc: "1" })), false);
  assert.equal(isShellPrefetch(new Headers()), false);
});

test("the API's skill opens signed out, for an agent to install", () => {
  assert.equal(page("/skills/outrunner-api/SKILL.md"), null);
  // A path that only starts the same isn't one.
  assert.equal(page("/skillset"), "/signin?next=%2Fskillset");
});
