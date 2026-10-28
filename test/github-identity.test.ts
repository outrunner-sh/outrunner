import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import type { OrgInstallation } from "@/lib/db/github-installations";
import { GitHubAppError, type InstallationToken, type TokenPermissions } from "@/lib/github/app";
import { MissingGithubTokenError } from "@/lib/github/client";
import { GitIdentityError, narrowPermissions, resolveGitCredential, type IdentityDeps } from "@/lib/github/identity";
import {
  gitCredentialEnvironment,
  gitCredentialRequestValid,
  gitCredentialSignature,
} from "@/lib/runtime/git-credential";

const config = { clientId: "Iv23test", slug: "outrunner-sh", privateKey: "pem", webhookSecret: "w" };

function installation(id: number, login: string, extra: Partial<OrgInstallation> = {}): OrgInstallation {
  return {
    id,
    accountLogin: login,
    accountType: "Organization",
    repositorySelection: "selected",
    suspendedAt: null,
    suspended: false,
    installedBy: null,
    createdAt: "2026-10-27T00:00:00Z",
    ...extra,
  };
}

const NOW = new Date("2026-10-27T12:00:00Z").getTime();

function deps(over: Partial<IdentityDeps> = {}) {
  const minted: Array<{ installationId: number; repo: string; permissions?: TokenPermissions }> = [];
  const d: IdentityDeps = {
    identity: async () => "app",
    personalToken: async () => "gho_mine",
    config: () => config,
    installations: async () => [installation(7, "ZeroTrail")],
    repoLevel: async () => "write",
    granted: async () => ({
      contents: "write",
      pull_requests: "write",
      workflows: "write",
      checks: "read",
      statuses: "read",
      metadata: "read",
      issues: "write",
    }),
    mint: async (_config, installationId, repo, permissions) => {
      minted.push({ installationId, repo, permissions });
      return { token: `ghs_${minted.length}`, expiresAt: new Date(NOW + 60 * 60 * 1000) };
    },
    cache: new Map<string, InstallationToken>(),
    now: () => NOW,
    ...over,
  };
  return { d, minted };
}

const ask = { userId: "u1", orgId: "o1", repo: "zerotrail/api" };

test("working as themselves, a member gets their own token, whatever the repository", async () => {
  const { d, minted } = deps({ identity: async () => "personal" });
  assert.deepEqual(await resolveGitCredential(ask, d), { identity: "personal", token: "gho_mine", expiresAt: null });
  assert.equal(minted.length, 0);
  await assert.rejects(
    resolveGitCredential(ask, { ...d, personalToken: async () => null }),
    MissingGithubTokenError,
  );
});

test("working as the App, a member gets its installation's token for that one repository, kept until near its end", async () => {
  const { d, minted } = deps();
  const first = await resolveGitCredential(ask, d);
  assert.equal(first.identity, "app");
  assert.equal(first.token, "ghs_1");
  // The account's login is matched whatever its case; only what a session
  // needs, not everything the App has (issues).
  assert.deepEqual(minted, [
    {
      installationId: 7,
      repo: "api",
      permissions: {
        contents: "write",
        pull_requests: "write",
        workflows: "write",
        checks: "read",
        statuses: "read",
        metadata: "read",
      },
    },
  ]);
  assert.equal((await resolveGitCredential(ask, d)).token, "ghs_1");
  // Within 10 minutes of its end, a new one.
  d.now = () => NOW + 51 * 60 * 1000;
  assert.equal((await resolveGitCredential(ask, d)).token, "ghs_2");
});

test("read access gets a token that can only read, asked for or the member's level", async () => {
  const { d, minted } = deps();
  await resolveGitCredential({ ...ask, level: "read" }, d);
  const readOnly = { contents: "read", pull_requests: "read", checks: "read", statuses: "read", metadata: "read" };
  assert.deepEqual(minted[0].permissions, readOnly);
  // A writer's is another token, not the reader's.
  assert.equal((await resolveGitCredential(ask, d)).token, "ghs_2");

  const reader = deps({ repoLevel: async () => "read" });
  await resolveGitCredential(ask, reader.d);
  assert.deepEqual(reader.minted[0].permissions, readOnly);
});

test("the App reaches only a project the member has access to", async () => {
  const { d, minted } = deps({ repoLevel: async () => null });
  await assert.rejects(resolveGitCredential(ask, d), (error: unknown) => {
    assert.ok(error instanceof GitIdentityError);
    assert.equal(error.reason, "no_access");
    return true;
  });
  assert.equal(minted.length, 0);
  // Their own account reaches what it reaches, as before.
  const own = deps({ identity: async () => "personal", repoLevel: async () => null });
  assert.equal((await resolveGitCredential(ask, own.d)).token, "gho_mine");
});

test("a token asks for no more than its installation was granted", () => {
  assert.deepEqual(
    narrowPermissions(
      { contents: "write", workflows: "write", checks: "read", metadata: "read" },
      { contents: "read", metadata: "read", checks: "write" },
    ),
    { contents: "read", checks: "read", metadata: "read" },
  );
});

test("working as the App never falls back to the member's own token", async () => {
  const none = deps({ installations: async () => [installation(7, "someone-else")] });
  await assert.rejects(resolveGitCredential(ask, none.d), (error: unknown) => {
    assert.ok(error instanceof GitIdentityError);
    assert.equal(error.reason, "no_installation");
    assert.equal(error.href, "/settings/org/github");
    return true;
  });

  const suspended = deps({ installations: async () => [installation(7, "zerotrail", { suspended: true })] });
  await assert.rejects(resolveGitCredential(ask, suspended.d), (error: unknown) => {
    assert.ok(error instanceof GitIdentityError);
    assert.equal(error.reason, "suspended");
    assert.equal(error.href, "https://github.com/organizations/zerotrail/settings/installations/7");
    return true;
  });

  const unpicked = deps({
    mint: async () => {
      throw new GitHubAppError("GitHub answered 422", 422);
    },
  });
  await assert.rejects(resolveGitCredential(ask, unpicked.d), (error: unknown) => {
    assert.ok(error instanceof GitIdentityError);
    assert.equal(error.reason, "unreachable");
    return true;
  });

  const unset = deps({ config: () => null });
  await assert.rejects(resolveGitCredential(ask, unset.d), (error: unknown) => {
    assert.ok(error instanceof GitIdentityError);
    assert.equal(error.reason, "app_unconfigured");
    return true;
  });
});

test("a box's request is its own only signed with its secret, over its sandbox, time and body, and recently", () => {
  const body = '{"repo":"zerotrail/api"}';
  const signature = gitCredentialSignature("s3cret", "sb-1", "1000", body);
  const expected = createHmac("sha256", "s3cret").update(`git-credential\nsb-1\n1000\n${body}`).digest("hex");
  assert.equal(signature, `sha256=${expected}`);

  const request = { sandboxId: "sb-1", timestamp: "1000", signature, body };
  assert.equal(gitCredentialRequestValid("s3cret", request, 1000 + 60), true);
  assert.equal(gitCredentialRequestValid("other", request, 1000), false);
  assert.equal(gitCredentialRequestValid("s3cret", { ...request, sandboxId: "sb-2" }, 1000), false);
  assert.equal(gitCredentialRequestValid("s3cret", { ...request, body: '{"repo":"zerotrail/web"}' }, 1000), false);
  // More than five minutes either way.
  assert.equal(gitCredentialRequestValid("s3cret", request, 1000 + 301), false);
  assert.equal(gitCredentialRequestValid("s3cret", request, 1000 - 301), false);
  assert.equal(gitCredentialRequestValid("s3cret", { ...request, timestamp: null }, 1000), false);
  assert.equal(gitCredentialRequestValid("s3cret", { ...request, timestamp: "1e3" }, 1000), false);
  assert.equal(gitCredentialRequestValid("s3cret", { ...request, signature: null }, 1000), false);
});

test("a box asks with its sandbox and Outrunner's public address, and only one it can reach", () => {
  assert.deepEqual(gitCredentialEnvironment("sb-1", "https://app.outrunner.sh/"), {
    RUNTIME_SANDBOX_ID: "sb-1",
    OUTRUNNER_APP_URL: "https://app.outrunner.sh",
  });
  assert.deepEqual(gitCredentialEnvironment("sb-1", "http://localhost:3000"), {});
  assert.deepEqual(gitCredentialEnvironment("sb-1", undefined), {});
});
