import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, test } from "node:test";

import {
  appJwt,
  appPrivateKey,
  createInstallationToken,
  getInstallation,
  type GitHubAppConfig,
  installUrl,
  isGitHubSignature,
  listInstallationRepositories,
  userControlsInstallation,
} from "@/lib/github/app";
import { handleAppEvent } from "@/lib/github/app-events";
import { completeSetup, installCookieValue, readInstallCookie, type SetupDeps } from "@/lib/github/app-setup";
import {
  type Installation,
  installationId,
  installationSettingsUrl,
  normalizeInstallation,
} from "@/lib/github/installation";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const config: GitHubAppConfig = { appId: "4242", slug: "outrunner-staging", privateKey, webhookSecret: "s3cret" };

const ORG = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
const USER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NONCE = "abcdefghijklmnopqrstuvwx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("the private key is read as GitHub downloads it, flattened with \\n, or as base64", () => {
  assert.ok(appPrivateKey(pem));
  assert.ok(appPrivateKey(pem.replace(/\n/g, "\\n")));
  assert.ok(appPrivateKey(Buffer.from(pem).toString("base64")));
  assert.equal(appPrivateKey("not a key"), null);
});

test("the app JWT is RS256, issued a minute back and good for nine minutes, and verifies", () => {
  const jwt = appJwt("4242", privateKey, 1_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(payload), { iat: 999_940, exp: 1_000_540, iss: "4242" });
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
});

test("a webhook signature is checked against the raw body", () => {
  const body = '{"action":"deleted"}';
  const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(isGitHubSignature("s3cret", body, good), true);
  assert.equal(isGitHubSignature("s3cret", `${body} `, good), false);
  assert.equal(isGitHubSignature("other", body, good), false);
  assert.equal(isGitHubSignature("s3cret", body, null), false);
  assert.equal(isGitHubSignature("s3cret", body, "sha1=abc"), false);
  assert.equal(isGitHubSignature("s3cret", body, "sha256=zz"), false);
});

test("install and settings links", () => {
  assert.equal(
    installUrl("outrunner-staging", NONCE),
    `https://github.com/apps/outrunner-staging/installations/new?state=${NONCE}`,
  );
  assert.equal(
    installationSettingsUrl({ installationId: 7, accountLogin: "neevai-labs", accountType: "Organization" }),
    "https://github.com/organizations/neevai-labs/settings/installations/7",
  );
  assert.equal(
    installationSettingsUrl({ installationId: 7, accountLogin: "someone", accountType: "User" }),
    "https://github.com/settings/installations/7",
  );
});

test("an installation id is a positive integer", () => {
  assert.equal(installationId("123"), 123);
  assert.equal(installationId(123), 123);
  for (const bad of ["0", "-1", "1.5", "12a", "", null, undefined, "99999999999999999"]) {
    assert.equal(installationId(bad), null, String(bad));
  }
});

test("an installation from GitHub keeps its account, selection and suspension", () => {
  assert.deepEqual(
    normalizeInstallation({
      id: 9,
      account: { login: "neevai-labs", type: "Organization" },
      repository_selection: "selected",
      suspended_at: null,
    }),
    { installationId: 9, accountLogin: "neevai-labs", accountType: "Organization", repositorySelection: "selected", suspendedAt: null },
  );
  assert.equal(normalizeInstallation({ id: 9, account: { login: "x", type: "Enterprise" } }), null);
  assert.equal(normalizeInstallation({ id: "nine", account: { login: "x", type: "User" } }), null);
});

test("getInstallation reads as the app; a 404 is no installation", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    if (String(input).endsWith("/404")) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(
      Response.json({ id: 5, account: { login: "me", type: "User" }, repository_selection: "all", suspended_at: null }),
    );
  }) as typeof fetch;
  assert.deepEqual(await getInstallation(config, 5), {
    installationId: 5,
    accountLogin: "me",
    accountType: "User",
    repositorySelection: "all",
    suspendedAt: null,
  });
  assert.equal(await getInstallation(config, 404), null);
  assert.equal(seen[0].url, "https://api.github.com/app/installations/5");
  assert.match(seen[0].auth ?? "", /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

test("an installation token is narrowed to the repositories and permissions asked", async () => {
  let sent: { url: string; method?: string; body: unknown } | undefined;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent = { url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) };
    return Promise.resolve(Response.json({ token: "ghs_x", expires_at: "2026-10-28T12:00:00Z" }, { status: 201 }));
  }) as typeof fetch;
  const token = await createInstallationToken(config, 5, {
    repositories: ["outrunner"],
    permissions: { pull_requests: "write", contents: "read" },
  });
  assert.deepEqual(token, { token: "ghs_x", expiresAt: "2026-10-28T12:00:00Z" });
  assert.deepEqual(sent, {
    url: "https://api.github.com/app/installations/5/access_tokens",
    method: "POST",
    body: { repositories: ["outrunner"], permissions: { pull_requests: "write", contents: "read" } },
  });
});

test("the install cookie holds the org and the nonce", () => {
  assert.deepEqual(readInstallCookie(installCookieValue(ORG, NONCE)), { orgId: ORG, nonce: NONCE });
  assert.equal(readInstallCookie(undefined), null);
  assert.equal(readInstallCookie(`not-a-uuid.${NONCE}`), null);
  assert.equal(readInstallCookie(`${ORG}.short`), null);
  assert.equal(readInstallCookie(NONCE), null);
});

const installation: Installation = {
  installationId: 77,
  accountLogin: "neevai-labs",
  accountType: "Organization",
  repositorySelection: "selected",
  suspendedAt: null,
};

function setupDeps(over: Partial<SetupDeps> = {}) {
  const linked: unknown[] = [];
  const deps: SetupDeps = {
    memberRole: async () => "admin",
    getInstallation: async () => installation,
    controlsInstallation: async () => true,
    linkInstallation: async (input) => {
      linked.push(input);
    },
    ...over,
  };
  return { deps, linked };
}

function params(query: Record<string, string>) {
  return new URLSearchParams(query);
}

test("setup links the installation to the org the install started from", async () => {
  const { deps, linked } = setupDeps();
  const path = await completeSetup(
    {
      userId: USER,
      params: params({ installation_id: "77", setup_action: "install", state: NONCE }),
      cookie: installCookieValue(ORG, NONCE),
    },
    deps,
  );
  assert.equal(path, "/automations?linked=77");
  assert.deepEqual(linked, [{ orgId: ORG, installation, linkedBy: USER }]);
});

test("setup links nothing without the matching cookie, for a member, or for an unknown installation", async () => {
  const cases: [string, Parameters<typeof completeSetup>[0], Partial<SetupDeps>][] = [
    ["start_here", { userId: USER, params: params({ installation_id: "77", state: NONCE }), cookie: undefined }, {}],
    [
      "start_here",
      { userId: USER, params: params({ installation_id: "77", state: "x".repeat(24) }), cookie: installCookieValue(ORG, NONCE) },
      {},
    ],
    ["start_here", { userId: USER, params: params({ state: NONCE }), cookie: installCookieValue(ORG, NONCE) }, {}],
    [
      "not_admin",
      { userId: USER, params: params({ installation_id: "77", state: NONCE }), cookie: installCookieValue(ORG, NONCE) },
      { memberRole: async () => "member" },
    ],
    [
      "not_found",
      { userId: USER, params: params({ installation_id: "77", state: NONCE }), cookie: installCookieValue(ORG, NONCE) },
      { getInstallation: async () => null },
    ],
    [
      "github",
      { userId: USER, params: params({ installation_id: "77", state: NONCE }), cookie: installCookieValue(ORG, NONCE) },
      {
        getInstallation: async () => {
          throw new Error("down");
        },
      },
    ],
    [
      "not_yours",
      { userId: USER, params: params({ installation_id: "77", state: NONCE }), cookie: installCookieValue(ORG, NONCE) },
      { controlsInstallation: async () => false },
    ],
    [
      "failed",
      { userId: USER, params: params({ installation_id: "77", state: NONCE }), cookie: installCookieValue(ORG, NONCE) },
      {
        linkInstallation: async () => {
          throw new Error("relation does not exist");
        },
      },
    ],
    [
      "failed",
      { userId: USER, params: params({ installation_id: "77", state: NONCE }), cookie: installCookieValue(ORG, NONCE) },
      {
        memberRole: async () => {
          throw new Error("down");
        },
      },
    ],
    ["requested", { userId: USER, params: params({ setup_action: "request", state: NONCE }), cookie: undefined }, {}],
  ];
  for (const [problem, input, over] of cases) {
    const { deps, linked } = setupDeps(over);
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(await completeSetup(input, deps), `/automations?problem=${problem}`);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(linked, [], problem);
  }
});

test("coming back from changing repositories on GitHub is no problem", async () => {
  const { deps, linked } = setupDeps();
  const path = await completeSetup(
    { userId: USER, params: params({ installation_id: "77", setup_action: "update" }), cookie: undefined },
    deps,
  );
  assert.equal(path, "/automations");
  assert.deepEqual(linked, []);
});

test("app events keep linked installations true to GitHub", async () => {
  const calls: unknown[] = [];
  const deps = {
    forgetInstallation: async (id: number) => {
      calls.push(["forget", id]);
    },
    updateInstallation: async (id: number, change: object) => {
      calls.push(["update", id, change]);
    },
  };
  assert.equal(await handleAppEvent("ping", {}, deps), "pong");
  assert.equal(await handleAppEvent("installation", { action: "deleted", installation: { id: 7 } }, deps), "forgotten");
  assert.equal(
    await handleAppEvent("installation", { action: "suspend", installation: { id: 7, suspended_at: "2026-10-27T10:00:00Z" } }, deps),
    "updated",
  );
  assert.equal(await handleAppEvent("installation", { action: "unsuspend", installation: { id: 7 } }, deps), "updated");
  assert.equal(await handleAppEvent("installation", { action: "created", installation: { id: 7 } }, deps), "ignored");
  assert.equal(
    await handleAppEvent("installation_repositories", { action: "added", repository_selection: "all", installation: { id: 7 } }, deps),
    "updated",
  );
  assert.equal(await handleAppEvent("pull_request", { action: "opened", installation: { id: 7 } }, deps), "ignored");
  assert.equal(await handleAppEvent("installation", { action: "deleted" }, deps), "ignored");
  assert.deepEqual(calls, [
    ["forget", 7],
    ["update", 7, { suspendedAt: "2026-10-27T10:00:00Z" }],
    ["update", 7, { suspendedAt: null }],
    ["update", 7, { repositorySelection: "all" }],
  ]);
});

test("an installation on a user account is theirs only", async () => {
  const mine = { ...installation, accountType: "User" as const, accountLogin: "ImmadSahin" };
  assert.equal(await userControlsInstallation(config, mine, { login: "immadsahin", token: null }), true);
  assert.equal(await userControlsInstallation(config, mine, { login: "someone-else", token: "t" }), false);
});

test("an installation on an organization takes one of its owners", async () => {
  const stub = (role: string | null, admin: Record<string, boolean> = {}, repos = ["neevai-labs/a", "neevai-labs/b"]) => {
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) {
        return Promise.resolve(Response.json({ token: "ghs_x", expires_at: "2026-10-28T12:00:00Z" }, { status: 201 }));
      }
      if (url.includes("/orgs/neevai-labs/memberships/")) {
        return Promise.resolve(role ? Response.json({ state: "active", role }) : new Response("{}", { status: 404 }));
      }
      if (url.includes("/installation/repositories")) {
        return Promise.resolve(Response.json({ repositories: repos.map((full_name) => ({ full_name })) }));
      }
      const name = url.split("/repos/")[1];
      if (!(name in admin)) return Promise.resolve(new Response("{}", { status: 404 }));
      return Promise.resolve(Response.json({ permissions: { admin: admin[name] } }));
    }) as typeof fetch;
  };
  const all = { ...installation, repositorySelection: "all" as const };
  const user = { login: "x", token: "t" };

  stub("admin");
  assert.equal(await userControlsInstallation(config, all, user), true);
  // A member who is admin of a repository (one they made, say) has no claim on an install on all of them.
  stub("member", { "neevai-labs/a": true, "neevai-labs/b": true });
  assert.equal(await userControlsInstallation(config, all, user), false);
  // On selected repositories: admin of every one of them.
  stub("member", { "neevai-labs/a": true, "neevai-labs/b": true });
  assert.equal(await userControlsInstallation(config, installation, user), true);
  stub(null, { "neevai-labs/a": true, "neevai-labs/b": false });
  assert.equal(await userControlsInstallation(config, installation, user), false);
  stub(null, {}, Array.from({ length: 31 }, (_, i) => `neevai-labs/r${i}`));
  assert.equal(await userControlsInstallation(config, installation, user), false);
  stub(null, { "neevai-labs/a": true, "neevai-labs/b": true });
  assert.equal(await userControlsInstallation(config, installation, { login: "x", token: null }), false);
});

test("an installation's repository list says when it stopped short", async () => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/access_tokens")) {
      return Promise.resolve(Response.json({ token: "ghs_x", expires_at: "2026-10-28T12:00:00Z" }, { status: 201 }));
    }
    const page = Number(new URL(url).searchParams.get("page"));
    const repositories = Array.from({ length: 100 }, (_, i) => ({ full_name: `Acme/R${page}-${i}` }));
    return Promise.resolve(Response.json({ repositories }));
  }) as typeof fetch;
  const listed = await listInstallationRepositories(config, 5);
  assert.equal(listed.complete, false);
  assert.equal(listed.names.size, 1000);
  assert.ok(listed.names.has("acme/r1-0"));
});
