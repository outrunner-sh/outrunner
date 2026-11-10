import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubConnection } from "@/lib/db/github-connections";
import { GitHubSyncError, MissingGithubTokenError } from "@/lib/github/client";
import type { UserTokens } from "@/lib/github/user-auth";
import { GitHubConnectionBrokenError, userAccessToken, type UserConnectionDeps } from "@/lib/github/user-connection";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function connection(over: Partial<GitHubConnection> = {}): GitHubConnection {
  return {
    userId: "u1",
    githubUserId: 42,
    githubLogin: "md",
    accessToken: "ghu_1",
    accessExpiresAt: new Date(NOW + 4 * HOUR),
    refreshToken: "ghr_1",
    refreshExpiresAt: new Date(NOW + 100 * 24 * HOUR),
    refreshCiphertext: "sealed:ghr_1",
    broken: false,
    updatedAt: "2026-11-05T08:00:00Z",
    ...over,
  };
}

const renewed: UserTokens = {
  accessToken: "ghu_2",
  accessExpiresAt: new Date(NOW + 8 * HOUR),
  refreshToken: "ghr_2",
  refreshExpiresAt: new Date(NOW + 184 * 24 * HOUR),
};

/** A store of one connection, and GitHub's renewal, as `over` has them. */
function deps(start: GitHubConnection | null, over: Partial<UserConnectionDeps> = {}) {
  let row = start;
  const log: string[] = [];
  const d: UserConnectionDeps = {
    read: async () => row,
    claim: async () => (log.push("claim"), true),
    release: async () => void log.push("release"),
    saveRefreshed: async (_userId, used, tokens) => {
      log.push(`save over ${used}`);
      if (!row || row.refreshCiphertext !== used) return false;
      row = {
        ...row,
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshToken: tokens.refreshToken,
        refreshExpiresAt: tokens.refreshExpiresAt,
        refreshCiphertext: `sealed:${tokens.refreshToken}`,
      };
      return true;
    },
    markBroken: async (_userId, used) => {
      log.push(`break ${used}`);
      if (row && (!used || row.refreshCiphertext === used)) row = { ...row, broken: true };
    },
    refresh: async (refreshToken) => (log.push(`refresh ${refreshToken}`), renewed),
    sleep: async () => undefined,
    now: () => NOW,
    ...over,
  };
  return { d, log, row: () => row, set: (next: GitHubConnection | null) => void (row = next) };
}

test("a user who never connected has none", async () => {
  assert.equal(await userAccessToken("u1", deps(null).d), null);
});

test("a token with time left is handed out as it is, never renewed", async () => {
  const { d, log } = deps(connection());
  assert.deepEqual(await userAccessToken("u1", d), {
    token: "ghu_1",
    expiresAt: new Date(NOW + 4 * HOUR),
    githubUserId: 42,
    login: "md",
  });
  assert.deepEqual(log, []);
});

test("a token about to expire is renewed under a claim, and saved over the refresh token it used", async () => {
  const { d, log, row } = deps(connection({ accessExpiresAt: new Date(NOW + 5 * 60_000) }));
  assert.equal((await userAccessToken("u1", d))?.token, "ghu_2");
  assert.deepEqual(log, ["claim", "refresh ghr_1", "save over sealed:ghr_1"]);
  assert.equal(row()?.refreshToken, "ghr_2");
});

test("while another server renews it, this one waits and takes what it saved", async () => {
  const store = deps(connection({ accessExpiresAt: new Date(NOW - 1) }));
  let reads = 0;
  const d: UserConnectionDeps = {
    ...store.d,
    claim: async () => false,
    read: async () => {
      reads++;
      // The other server's renewal lands after a wait.
      if (reads === 3) store.set(connection({ accessToken: "ghu_theirs", accessExpiresAt: new Date(NOW + 8 * HOUR), refreshCiphertext: "sealed:ghr_9" }));
      return store.row();
    },
    refresh: async () => assert.fail("only the server holding the claim renews"),
  };
  assert.equal((await userAccessToken("u1", d))?.token, "ghu_theirs");
});

test("a refresh token GitHub refuses breaks the connection: reconnect, which the routes say", async () => {
  const { d, row } = deps(connection({ accessExpiresAt: new Date(NOW - 1) }), { refresh: async () => "revoked" });
  const error = await userAccessToken("u1", d).catch((e: unknown) => e);
  assert.ok(error instanceof GitHubConnectionBrokenError);
  // A MissingGithubTokenError, so every route answers it with `reconnect: true`.
  assert.ok(error instanceof MissingGithubTokenError);
  assert.equal(row()?.broken, true);
  await assert.rejects(userAccessToken("u1", d), GitHubConnectionBrokenError);
});

test("a refresh token another server spent first is no break: its renewal is used", async () => {
  const store = deps(connection({ accessExpiresAt: new Date(NOW - 1) }));
  const d: UserConnectionDeps = {
    ...store.d,
    refresh: async () => {
      // Spent and saved elsewhere, just now (its claim had run out).
      store.set(connection({ accessToken: "ghu_theirs", accessExpiresAt: new Date(NOW + 8 * HOUR), refreshCiphertext: "sealed:ghr_9" }));
      return "revoked";
    },
  };
  assert.equal((await userAccessToken("u1", d))?.token, "ghu_theirs");
  assert.equal(store.row()?.broken, false);
});

test("GitHub out of reach: the token held while it lasts, else try again (never a break)", async () => {
  const down = async () => {
    throw new Error("GitHub couldn't be reached.");
  };
  const lasting = deps(connection({ accessExpiresAt: new Date(NOW + 5 * 60_000) }), { refresh: down });
  assert.equal((await userAccessToken("u1", lasting.d))?.token, "ghu_1");
  assert.ok(lasting.log.includes("release"));

  const expired = deps(connection({ accessExpiresAt: new Date(NOW - 1) }), { refresh: down });
  await assert.rejects(userAccessToken("u1", expired.d), GitHubSyncError);
  assert.equal(expired.row()?.broken, false);
});

test("an expiring token with no refresh token, or a refresh token past its date, can only be reconnected", async () => {
  const none = deps(connection({ accessExpiresAt: new Date(NOW - 1), refreshToken: null, refreshCiphertext: null }));
  await assert.rejects(userAccessToken("u1", none.d), GitHubConnectionBrokenError);
  const old = deps(connection({ accessExpiresAt: new Date(NOW - 1), refreshExpiresAt: new Date(NOW - 1) }));
  await assert.rejects(userAccessToken("u1", old.d), GitHubConnectionBrokenError);
  assert.ok(!old.log.some((l) => l.startsWith("refresh")));
});

test("a token that doesn't expire (the App's setting off) is handed out without renewing", async () => {
  const { d, log } = deps(connection({ accessExpiresAt: null, refreshToken: null, refreshCiphertext: null }));
  assert.equal((await userAccessToken("u1", d))?.expiresAt, null);
  assert.deepEqual(log, []);
});

test("connected again while renewing: what's stored now wins", async () => {
  const store = deps(connection({ accessExpiresAt: new Date(NOW - 1) }));
  const d: UserConnectionDeps = {
    ...store.d,
    refresh: async () => {
      store.set(connection({ accessToken: "ghu_new_connection", accessExpiresAt: new Date(NOW + 8 * HOUR), refreshCiphertext: "sealed:other" }));
      return renewed;
    },
  };
  assert.equal((await userAccessToken("u1", d))?.token, "ghu_new_connection");
});

test("waiting on another server's renewal gives up in time, with the token held if it still works", async () => {
  const store = deps(connection({ accessExpiresAt: new Date(NOW + 60_000) }), { claim: async () => false });
  assert.equal((await userAccessToken("u1", store.d))?.token, "ghu_1");
  const stuck = deps(connection({ accessExpiresAt: new Date(NOW - 1) }), { claim: async () => false });
  await assert.rejects(userAccessToken("u1", stuck.d), GitHubSyncError);
});

test("the App's client secret refused is logged as the deployment's to fix, and the held token still used", async () => {
  const { UserAuthError } = await import("@/lib/github/user-auth");
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(String(args[0]));
  try {
    const { d } = deps(connection({ accessExpiresAt: new Date(NOW + 5 * 60_000) }), {
      refresh: async () => {
        throw new UserAuthError("GitHub refused the refresh (incorrect_client_credentials).", null, "incorrect_client_credentials");
      },
    });
    assert.equal((await userAccessToken("u1", d))?.token, "ghu_1");
    assert.ok(logged.some((line) => line.includes("GITHUB_APP_CLIENT_SECRET")));
  } finally {
    console.error = real;
  }
});

test("a connection found broken under the claim gives the claim back", async () => {
  const store = deps(connection({ accessExpiresAt: new Date(NOW - 1) }));
  const d: UserConnectionDeps = {
    ...store.d,
    claim: async () => {
      store.set(connection({ accessExpiresAt: new Date(NOW - 1), broken: true }));
      return true;
    },
  };
  await assert.rejects(userAccessToken("u1", d), GitHubConnectionBrokenError);
  assert.ok(store.log.includes("release"));
});
