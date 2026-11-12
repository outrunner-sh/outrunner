import assert from "node:assert/strict";
import { test } from "node:test";

import { LinearRevokedError, LinearUnauthorizedError, LinearUnavailableError, type LinearTokens } from "@/lib/trackers/linear";
import {
  accessToken,
  LEASE_MS,
  refreshIfDue,
  tokenAfterRefusal,
  TokenUnavailableError,
  TrackerDisconnectedError,
  WAIT_MS,
  withToken,
  type TokenDeps,
  type TokenRow,
} from "@/lib/trackers/tokens";

const HOUR = 60 * 60 * 1000;
const START = 1_000_000;

function tokens(access: string): LinearTokens {
  return { accessToken: access, refreshToken: `${access}-refresh`, expiresAt: new Date(START + 24 * HOUR), refreshExpiresAt: null };
}

/** One install's row, with the lease as the database's conditional update has it. */
function harness(initial: Partial<TokenRow> = {}, refresh: TokenDeps["refresh"] = async () => tokens("new")) {
  let now = START;
  const row: TokenRow = { id: "i", provider: "linear", accessToken: "old", refreshToken: "r", version: "r", expiresAt: now + 10 * HOUR, disconnected: false, ...initial };
  const state = { leaseUntil: 0, refreshes: 0, sleeps: 0, row };
  const deps: TokenDeps = {
    load: async () => ({ ...row }),
    claim: async (_id, opts) => {
      if (row.disconnected || (row.expiresAt ?? 0) >= opts.dueBefore || state.leaseUntil >= opts.now) return null;
      state.leaseUntil = opts.leaseUntil;
      return { ...row };
    },
    store: async (_id, t, version) => {
      if (row.version !== version) return false;
      row.accessToken = t.accessToken;
      row.refreshToken = t.refreshToken ?? row.refreshToken;
      row.version = row.refreshToken;
      row.expiresAt = t.expiresAt.getTime();
      state.leaseUntil = 0;
      return true;
    },
    release: async () => {
      state.leaseUntil = 0;
    },
    disconnect: async (_id, version) => {
      if (row.version !== version) return false;
      row.disconnected = true;
      row.accessToken = null;
      row.refreshToken = null;
      row.version = null;
      return true;
    },
    refresh: async (r) => {
      state.refreshes += 1;
      return refresh(r, row.provider);
    },
    now: () => now,
    sleep: async (ms) => {
      state.sleeps += 1;
      now += ms;
    },
  };
  return { deps, state, now: () => now };
}

test("a token that still works is used without touching the lease", async () => {
  const { deps, state } = harness();
  assert.equal(await accessToken("i", deps), "old");
  assert.equal(state.refreshes, 0);
});

test("a token inside the refresh margin but still valid is used, without waiting on anyone", async () => {
  const h = harness({ expiresAt: START + HOUR });
  h.state.leaseUntil = h.now() + LEASE_MS; // someone else is refreshing
  assert.equal(await accessToken("i", h.deps), "old");
  assert.equal(h.state.sleeps, 0);
});

test("an expired token is refreshed, and the new pair kept", async () => {
  const h = harness({ expiresAt: START - 1 });
  assert.equal(await accessToken("i", h.deps), "new");
  assert.equal(h.state.row.refreshToken, "new-refresh");
  assert.equal(h.state.leaseUntil, 0);
});

test("two callers at once refresh only once", async () => {
  const h = harness({ expiresAt: START - 1 });
  const [a, b] = await Promise.all([accessToken("i", h.deps), accessToken("i", h.deps)]);
  assert.equal(a, "new");
  assert.equal(b, "new");
  assert.equal(h.state.refreshes, 1);
});

test("a caller behind someone else's refresh waits at most WAIT_MS, then gives up", async () => {
  const h = harness({ expiresAt: START - 1 });
  h.state.leaseUntil = h.now() + LEASE_MS;
  const start = h.now();
  await assert.rejects(accessToken("i", h.deps), TokenUnavailableError);
  assert.ok(h.now() - start <= WAIT_MS + 250);
  assert.equal(h.state.refreshes, 0);
});

test("a refresh that died is taken over once its lease is up", async () => {
  const h = harness({ expiresAt: START - 1 });
  h.state.leaseUntil = h.now() - 1;
  assert.equal(await accessToken("i", h.deps), "new");
});

test("Linear refusing the refresh disconnects the install", async () => {
  const h = harness({ expiresAt: START - 1 }, async () => {
    throw new LinearRevokedError("no");
  });
  await assert.rejects(accessToken("i", h.deps), TrackerDisconnectedError);
  assert.equal(h.state.row.disconnected, true);
});

test("Linear being down lets the lease go, for the next caller to try", async () => {
  const h = harness({ expiresAt: START - 1 }, async () => {
    throw new LinearUnavailableError("down");
  });
  await assert.rejects(accessToken("i", h.deps), LinearUnavailableError);
  assert.equal(h.state.leaseUntil, 0);
  assert.equal(h.state.row.disconnected, false);
});

test("a disconnected install has no token to give", async () => {
  const { deps } = harness({ disconnected: true, accessToken: null });
  await assert.rejects(accessToken("i", deps), TrackerDisconnectedError);
});

test("the tick refreshes only what's within 2 hours of its end", async () => {
  const fresh = harness({ expiresAt: START + 3 * HOUR });
  assert.equal(await refreshIfDue("i", "linear", fresh.deps), false);
  const due = harness({ expiresAt: START + HOUR });
  assert.equal(await refreshIfDue("i", "linear", due.deps), true);
  assert.equal(due.state.row.accessToken, "new");
});

test("the tick leaves an install someone else is refreshing", async () => {
  const h = harness({ expiresAt: START + HOUR });
  h.state.leaseUntil = h.now() + LEASE_MS;
  assert.equal(await refreshIfDue("i", "linear", h.deps), false);
  assert.equal(h.state.refreshes, 0);
});

// --- A 401 on a call ---------------------------------------------------------

test("a 401 from the tick's race retries with the newer token, and keeps the install", async () => {
  const h = harness();
  const used: string[] = [];
  const answer = await withToken(
    "i",
    "fallback",
    async (token) => {
      used.push(token);
      if (token === "old") {
        // The tick rotated it between our read and our call.
        h.state.row.accessToken = "rotated";
        throw new LinearUnauthorizedError("401");
      }
      return "answer";
    },
    h.deps,
  );
  assert.equal(answer, "answer");
  assert.deepEqual(used, ["old", "rotated"]);
  assert.equal(h.state.refreshes, 0);
  assert.equal(h.state.row.disconnected, false);
  assert.equal(h.state.row.accessToken, "rotated");
});

test("a 401 with no newer token forces a refresh, however long the token had left", async () => {
  const h = harness({ expiresAt: START + 20 * HOUR });
  const answer = await withToken(
    "i",
    null,
    async (token) => {
      if (token === "old") throw new LinearUnauthorizedError("401");
      return token;
    },
    h.deps,
  );
  assert.equal(answer, "new");
  assert.equal(h.state.refreshes, 1);
  assert.equal(h.state.row.disconnected, false);
});

test("a 401 on a really revoked install: the refused refresh is what disconnects it", async () => {
  const h = harness({}, async () => {
    throw new LinearRevokedError("invalid_grant");
  });
  const answer = await withToken(
    "i",
    "fallback",
    async () => {
      throw new LinearUnauthorizedError("401");
    },
    h.deps,
  );
  assert.equal(answer, "fallback");
  assert.equal(h.state.row.disconnected, true);
});

test("a second 401 on a fresh token doesn't disconnect: it's for later", async () => {
  const h = harness();
  await assert.rejects(
    withToken(
      "i",
      null,
      async () => {
        throw new LinearUnauthorizedError("401");
      },
      h.deps,
    ),
    LinearUnavailableError,
  );
  assert.equal(h.state.row.disconnected, false);
  assert.equal(h.state.row.accessToken, "new");
});

test("a refused token waits on someone else's refresh, and comes back with its result", async () => {
  const h = harness();
  h.state.leaseUntil = h.now() + LEASE_MS;
  const sleep = h.deps.sleep;
  h.deps.sleep = async (ms) => {
    await sleep(ms);
    h.state.row.accessToken = "theirs";
  };
  assert.equal(await tokenAfterRefusal("i", "old", h.deps), "theirs");
  assert.equal(h.state.refreshes, 0);
});

test("a refused token whose refresh takes too long is for a retry, not a disconnect", async () => {
  const h = harness();
  h.state.leaseUntil = h.now() + LEASE_MS;
  await assert.rejects(tokenAfterRefusal("i", "old", h.deps), TokenUnavailableError);
  assert.equal(h.state.row.disconnected, false);
});

test("other failures from the call are the caller's", async () => {
  const h = harness();
  await assert.rejects(
    withToken(
      "i",
      null,
      async () => {
        throw new LinearUnavailableError("down");
      },
      h.deps,
    ),
    LinearUnavailableError,
  );
  assert.equal(h.state.refreshes, 0);
});

test("a disconnected install answers the fallback without asking", async () => {
  const { deps } = harness({ disconnected: true, accessToken: null });
  assert.equal(await withToken("i", "fallback", async () => "asked", deps), "fallback");
});

// --- Authorizing again while something is in flight --------------------------

/** What an admin reconnecting does: new tokens, the lease cleared. */
function reauthorize(row: TokenRow) {
  row.accessToken = "reinstalled";
  row.refreshToken = "reinstalled-refresh";
  row.version = "reinstalled-refresh";
  row.expiresAt = START + 24 * HOUR;
  row.disconnected = false;
}

test("a refresh in flight when someone authorizes again doesn't overwrite what they saved", async () => {
  const h = harness({ expiresAt: START - 1 }, async () => {
    reauthorize(h.state.row);
    return tokens("stale");
  });
  assert.equal(await accessToken("i", h.deps), "reinstalled");
  assert.equal(h.state.row.accessToken, "reinstalled");
  assert.equal(h.state.row.refreshToken, "reinstalled-refresh");
});

test("a refresh refused because someone authorized again doesn't wipe what they saved", async () => {
  const h = harness({ expiresAt: START - 1 }, async () => {
    reauthorize(h.state.row);
    throw new LinearRevokedError("invalid_grant");
  });
  assert.equal(await accessToken("i", h.deps), "reinstalled");
  assert.equal(h.state.row.disconnected, false);
  assert.equal(h.state.row.accessToken, "reinstalled");
});

test("a 401 in flight when someone authorizes again retries with what they saved", async () => {
  const h = harness();
  const answer = await withToken(
    "i",
    null,
    async (token) => {
      if (token === "old") {
        reauthorize(h.state.row);
        throw new LinearUnauthorizedError("401");
      }
      return token;
    },
    h.deps,
  );
  assert.equal(answer, "reinstalled");
  assert.equal(h.state.refreshes, 0);
  assert.equal(h.state.row.disconnected, false);
});

test("a refused refresh with the row unchanged still disconnects", async () => {
  const h = harness({ expiresAt: START - 1 }, async () => {
    throw new LinearRevokedError("invalid_grant");
  });
  await assert.rejects(accessToken("i", h.deps), TrackerDisconnectedError);
  assert.equal(h.state.row.disconnected, true);
});

test("a row with no refresh token is disconnected, unless someone just gave it one", async () => {
  const none = harness({ expiresAt: START - 1, refreshToken: null, version: null });
  await assert.rejects(accessToken("i", none.deps), TrackerDisconnectedError);
  assert.equal(none.state.row.disconnected, true);
});

// --- Confirming a revocation event ---------------------------------------------

/** What the webhook asks: does the install's token still answer? */
const stillWorks = (h: ReturnType<typeof harness>, answer: (token: string) => Promise<boolean>) => withToken("i", false, answer, h.deps);

test("a revocation that isn't: the token answers, and nothing changes", async () => {
  const h = harness();
  assert.equal(await stillWorks(h, async () => true), true);
  assert.equal(h.state.row.disconnected, false);
  assert.equal(h.state.row.accessToken, "old");
});

test("a real revocation: a 401, the refresh refused, disconnected, and false", async () => {
  const h = harness({}, async () => {
    throw new LinearRevokedError("invalid_grant");
  });
  const answer = await stillWorks(h, async () => {
    throw new LinearUnauthorizedError("401");
  });
  assert.equal(answer, false);
  assert.equal(h.state.row.disconnected, true);
});

test("a late revocation after a reconnect: the new token answers, and it stays", async () => {
  const h = harness({}, async () => {
    reauthorize(h.state.row);
    throw new LinearRevokedError("invalid_grant");
  });
  const answer = await stillWorks(h, async (token) => {
    if (token === "old") throw new LinearUnauthorizedError("401");
    return true;
  });
  assert.equal(answer, true);
  assert.equal(h.state.row.disconnected, false);
  assert.equal(h.state.row.accessToken, "reinstalled");
});

test("Linear down while confirming: it throws for a retry, and nothing changes", async () => {
  const h = harness();
  await assert.rejects(
    stillWorks(h, async () => {
      throw new LinearUnavailableError("down");
    }),
    LinearUnavailableError,
  );
  assert.equal(h.state.row.disconnected, false);
});

test("Jira's tokens last an hour, so its refresh margin is shorter than one", async () => {
  // 30 minutes left: Linear would refresh this, and Jira not yet.
  const linear = harness({ expiresAt: START + 30 * 60 * 1000 });
  assert.equal(await refreshIfDue("i", "linear", linear.deps), true);
  const jira = harness({ expiresAt: START + 30 * 60 * 1000, provider: "jira" });
  assert.equal(await refreshIfDue("i", "jira", jira.deps), false);
  const jiraDue = harness({ expiresAt: START + 10 * 60 * 1000, provider: "jira" });
  assert.equal(await refreshIfDue("i", "jira", jiraDue.deps), true);
});

test("a refresh goes to the row's own tracker", async () => {
  const seen: string[] = [];
  const h = harness({ expiresAt: START - 1, provider: "jira" }, async () => tokens("new"));
  const refresh = h.deps.refresh;
  h.deps.refresh = async (r, provider) => {
    seen.push(provider);
    return refresh(r, provider);
  };
  await accessToken("i", h.deps);
  assert.deepEqual(seen, ["jira"]);
});
