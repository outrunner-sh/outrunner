import assert from "node:assert/strict";
import { test } from "node:test";

import { BRANCH_RACE_ATTEMPTS, generatedBranch, insertOnBranch } from "@/lib/session/generated-branch";

const nothingTaken = { sessionBranches: async () => new Set<string>(), knownOnGitHub: async () => false };
const taken = (error = "branch") => Object.assign(new Error(error), { code: "23505" });

test("a free name is used as it is, with no suffix", async () => {
  assert.equal(await generatedBranch({ prompt: "fix the login redirect" }, nothingTaken), "fix-login-redirect");
});

test("a name a session has, or had, gets the next number", async () => {
  // fix-login-redirect is a live session's; -2 an archived or ended one's.
  const deps = { ...nothingTaken, sessionBranches: async () => new Set(["fix-login-redirect", "fix-login-redirect-2"]) };
  assert.equal(await generatedBranch({ prompt: "fix the login redirect" }, deps), "fix-login-redirect-3");
});

test("a name GitHub knows, as a branch or an old pull request's head, isn't reused", async () => {
  const onGitHub = new Set(["fix-login-redirect"]);
  const asked: string[] = [];
  const deps = { ...nothingTaken, knownOnGitHub: async (b: string) => (asked.push(b), onGitHub.has(b)) };
  assert.equal(await generatedBranch({ prompt: "fix the login redirect" }, deps), "fix-login-redirect-2");
  assert.deepEqual(asked, ["fix-login-redirect", "fix-login-redirect-2"]);
});

test("a session's own names aren't asked of GitHub", async () => {
  const asked: string[] = [];
  const deps = {
    sessionBranches: async () => new Set(["fix-login-redirect"]),
    knownOnGitHub: async (b: string) => (asked.push(b), false),
  };
  await generatedBranch({ prompt: "fix the login redirect" }, deps);
  assert.deepEqual(asked, ["fix-login-redirect-2"]);
});

test("when it can't be checked, a random suffix keeps it off what's there", async () => {
  const deps = { ...nothingTaken, knownOnGitHub: async () => { throw new Error("GitHub down"); } };
  const errors = console.error;
  console.error = () => {};
  try {
    assert.match(await generatedBranch({ prompt: "fix the login redirect" }, deps), /^fix-login-redirect-[0-9a-f]{6}$/);
  } finally {
    console.error = errors;
  }
});

test("two creates at once both succeed: the one that loses the race takes the next name", async () => {
  const rows = new Set<string>();
  const sessions = { ...nothingTaken, sessionBranches: async () => new Set(rows) };
  // Both check before either inserts, so both pick fix-login-redirect.
  const picked = await Promise.all([1, 2].map(() => generatedBranch({ prompt: "fix the login redirect" }, sessions)));
  assert.deepEqual(picked, ["fix-login-redirect", "fix-login-redirect"]);
  const insert = async (branch: string) => {
    if (rows.has(branch)) throw taken();
    rows.add(branch);
    return branch;
  };
  const make = (first: string) =>
    insertOnBranch({
      requested: "",
      generate: async (lost) => (lost.size === 0 ? first : generatedBranch({ prompt: "fix the login redirect" }, sessions, lost)),
      insert,
      isBranchTaken: (e) => (e as { code?: string }).code === "23505",
    });
  const made = await Promise.all(picked.map(make));
  assert.deepEqual(made.sort(), ["fix-login-redirect", "fix-login-redirect-2"]);
});

test("a branch the user asked for is tried once, never renamed", async () => {
  let tries = 0;
  await assert.rejects(
    insertOnBranch({
      requested: "my-branch",
      generate: async () => assert.fail("not generated"),
      insert: async () => { tries++; throw taken(); },
      isBranchTaken: () => true,
    }),
    /branch/,
  );
  assert.equal(tries, 1);
});

test("races are retried a few times, other failures not at all", async () => {
  let tries = 0;
  await assert.rejects(
    insertOnBranch({ requested: "", generate: async () => "b", insert: async () => { tries++; throw taken(); }, isBranchTaken: () => true }),
  );
  assert.equal(tries, BRANCH_RACE_ATTEMPTS);
  tries = 0;
  await assert.rejects(
    insertOnBranch({ requested: "", generate: async () => "b", insert: async () => { tries++; throw new Error("db down"); }, isBranchTaken: () => false }),
    /db down/,
  );
  assert.equal(tries, 1);
});
