import assert from "node:assert/strict";
import { test } from "node:test";

import { branchesDiffer } from "@/hooks/use-standings";
import { runnerOwning } from "@/lib/missions/settle";
import { checkRename, commitRename, nameProblem, type RenameBranchDeps, type RenameSession } from "@/lib/session/rename-branch";
import { callSessionTool, type SessionToolDeps } from "@/lib/session-tools/tools";

const SESSION: RenameSession = { id: "ws", branch: "sign-fails-google-users", branchRenamable: true };

function deps(over: Partial<Omit<RenameBranchDeps, "session">> & { session?: RenameSession | null } = {}): RenameBranchDeps & { settled: string[] } {
  const settled: string[] = [];
  const { session = SESSION, ...rest } = over;
  return {
    settled,
    session: async () => session,
    hasPullRequest: async () => false,
    sessionBranches: async () => new Set([SESSION.branch]),
    knownOnGitHub: async () => false,
    rename: async () => true,
    settle: async (id) => void settled.push(id),
    ...rest,
  };
}

test("a name is <type>/<what-it-does>, in lowercase words, not a tool's", () => {
  for (const ok of ["fix/google-sign-in", "feat/expandable-right-sidebar", "fix/nee-268-mask-chat-secrets", "security/box-request-hardening", "perf/faster-ci"]) {
    assert.equal(nameProblem(ok), null, ok);
  }
  for (const bad of ["google-sign-in", "Fix/Sign-In", "fix/sign in", "fix/a/b", "fix/", "fix/-x", "fix/x-", "fix/x--y", "-fix/x", "f/x"]) {
    assert.ok(nameProblem(bad), bad);
  }
  assert.match(nameProblem("outrunner/fix-login") ?? "", /kind of change/);
  assert.match(nameProblem("claude/fix-login") ?? "", /kind of change/);
  assert.match(nameProblem(`fix/${"word-".repeat(12)}end`) ?? "", /too long/);
});

test("check gives the name, or its next free number, and changes nothing", async () => {
  const d = deps();
  assert.deepEqual(await checkRename("ws", "fix/google-sign-in", d), { status: 200, text: "fix/google-sign-in" });
  const taken = deps({
    sessionBranches: async () => new Set([SESSION.branch, "fix/google-sign-in"]),
    knownOnGitHub: async (_, b) => b === "fix/google-sign-in-2",
  });
  assert.deepEqual(await checkRename("ws", "fix/google-sign-in", taken), { status: 200, text: "fix/google-sign-in-3" });
});

test("only a made-up branch, never pushed, with no pull request, is renamed", async () => {
  assert.equal((await checkRename("ws", "fix/x", deps({ session: null }))).status, 404);
  // For good: 410, for the box to stop offering it.
  assert.equal((await checkRename("ws", "fix/x", deps({ session: { ...SESSION, branchRenamable: false } }))).status, 410);
  const withPr = deps({ hasPullRequest: async () => true });
  const refused = await checkRename("ws", "fix/x", withPr);
  assert.equal(refused.status, 410);
  assert.match(refused.error ?? "", /pull request/);
  assert.deepEqual(withPr.settled, ["ws"]);
  // Pushed already: refused, and it keeps its name from now on.
  const pushed = deps({ knownOnGitHub: async (_, b) => b === SESSION.branch });
  const pushedAnswer = await checkRename("ws", "fix/x", pushed);
  assert.match(pushedAnswer.error ?? "", /on GitHub already/);
  assert.equal(pushedAnswer.status, 410);
  assert.deepEqual(pushed.settled, ["ws"]);
  assert.equal((await checkRename("ws", "Not A Name", deps())).status, 400);
});

test("commit records the box's rename, or says why not", async () => {
  const renamed: string[][] = [];
  assert.deepEqual(await commitRename("ws", SESSION.branch, "fix/x", deps({ rename: async (...a) => (renamed.push(a), true) })), { status: 200, text: "fix/x" });
  assert.deepEqual(renamed, [["ws", SESSION.branch, "fix/x"]]);
  assert.equal((await commitRename("ws", SESSION.branch, "fix/x", deps({ rename: async () => false }))).status, 409);
  const raced = deps({ rename: async () => { throw Object.assign(new Error("dup"), { code: "23505" }); } });
  assert.match((await commitRename("ws", SESSION.branch, "fix/x", raced)).error ?? "", /took fix\/x meanwhile/);
  assert.equal((await commitRename("ws", SESSION.branch, "not a name", deps())).status, 400);
  // Without a check first (a box resuming a rename): still refused when the
  // stand-in is pushed or has a pull request.
  const pushed = deps({ knownOnGitHub: async (_, b) => b === SESSION.branch, rename: async () => assert.fail("recorded") });
  assert.equal((await commitRename("ws", SESSION.branch, "fix/x", pushed)).status, 410);
  assert.deepEqual(pushed.settled, ["ws"]);
  const withPr = deps({ hasPullRequest: async () => true, rename: async () => assert.fail("recorded") });
  assert.equal((await commitRename("ws", SESSION.branch, "fix/x", withPr)).status, 410);
  // Sent again after a lost answer: recorded already, so done.
  const recorded = deps({ session: { ...SESSION, branch: "fix/x", branchRenamable: false }, rename: async () => assert.fail("recorded twice") });
  assert.deepEqual(await commitRename("ws", SESSION.branch, "fix/x", recorded), { status: 200, text: "fix/x" });
  // Taken since check, by a session or on GitHub: refused before it's recorded.
  const takenBySession = deps({ sessionBranches: async () => new Set([SESSION.branch, "fix/x"]), rename: async () => assert.fail("recorded") });
  assert.match((await commitRename("ws", SESSION.branch, "fix/x", takenBySession)).error ?? "", /taken meanwhile/);
  const onGitHub = deps({ knownOnGitHub: async (_, b) => b === "fix/x", rename: async () => assert.fail("recorded") });
  assert.equal((await commitRename("ws", SESSION.branch, "fix/x", onGitHub)).status, 409);
});

test("the session tool checks, then commits, as the box asks", async () => {
  const tools: SessionToolDeps = {
    actor: async () => ({ userId: "u", orgId: "o", role: "member" }) as never,
    learnings: {} as never,
    memory: {} as never,
    renameBranch: deps(),
    base: "https://app.example",
  };
  const scope = { userId: "u", orgId: "o", workspaceId: "ws" };
  assert.deepEqual(await callSessionTool(scope, "rename_branch", { phase: "check", name: "fix/x" }, tools), { status: 200, text: "fix/x" });
  assert.deepEqual(await callSessionTool(scope, "rename_branch", { phase: "commit", from: SESSION.branch, to: "fix/x" }, tools), { status: 200, text: "fix/x" });
  assert.equal((await callSessionTool(scope, "rename_branch", { phase: "other" }, tools)).status, 400);
  assert.equal((await callSessionTool(scope, "rename_branch", { phase: "check", name: "fix/x" }, { ...tools, renameBranch: undefined })).status, 404);
});

test("a page re-reads its sessions when one's branch was renamed", () => {
  assert.equal(branchesDiffer({ a: "x", b: "y" }, { a: "x", b: "y" }), false);
  assert.equal(branchesDiffer({ a: "sign-fails-google" }, { a: "fix/google-sign-in" }), true);
  // One only the server lists is a new session's, which ids catch.
  assert.equal(branchesDiffer({ a: "x" }, { a: "x", b: "new" }), false);
  assert.equal(branchesDiffer(undefined, { a: "x" }), false);
});

test("a Ship renamed before it pushed is matched by its new branch", () => {
  // Read from the database at match time, as runnersFor does.
  const ship = { id: "ship", branch: "fix/google-sign-in" };
  const own = new Set(["fix/google-sign-in"]);
  assert.equal(runnerOwning([ship], "fix/google-sign-in", own), ship);
  assert.equal(runnerOwning([ship], "sign-fails-google-users", own), undefined);
});
