/**
 * The agent naming its session's branch, once, when it knows what the change
 * is (`outrunner-session rename-branch <type>/<what-it-does>`): the name made
 * from the first prompt (lib/session/branch-name.ts) is a stand-in until then.
 *
 * Two steps, so the box can undo its half: `check` says the name it may take
 * (numbered `-2`… when taken) and changes nothing; the box renames the branch
 * in every checkout; `commit` records it, or refuses, and the box renames it
 * back. Only a branch Outrunner chose, never pushed, with no pull request:
 * after that, GitHub, webhooks and pull request lookups know it by its name.
 * A session that can never be renamed is refused with 410 (FINAL), for the
 * box to stop asking; `commit` is safe to send again, for a box whose first
 * answer was lost.
 *
 * Pure but for what's given (deps), for the session tools and the tests.
 */

import { firstFreeBranch } from "@/lib/session/branch-name";

/** A name's type or area: a word. */
export const BRANCH_TYPES = ["fix", "feat", "refactor", "docs", "test", "chore", "perf"] as const;

/** A refusal that won't change: the box stops offering the rename. */
export const FINAL = 410;

/** What a name says after its type, at most: 40 for the words, room for an issue key. */
const MAX_WHAT = 52;

/** Prefixes that name a tool, not the change. */
const TOOL_PREFIXES = new Set(["outrunner", "runtime", "claude", "codex", "cursor", "copilot", "replicas", "session"]);

/** `<type>/<what-it-does>`: lowercase words joined by hyphens, one slash. */
const NAME = /^([a-z][a-z0-9]{1,19})\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** The session a rename is for, as recorded. */
export type RenameSession = {
  id: string;
  branch: string;
  /** Still on the name Outrunner chose, and allowed a new one. */
  branchRenamable: boolean;
};

export type RenameBranchDeps = {
  session(id: string): Promise<RenameSession | null>;
  /** Whether a pull request of the session's is on record. */
  hasPullRequest(id: string): Promise<boolean>;
  /** The branches of `base` and `base-<n>` the project's sessions have had,
   *  ended ones and teammates' too. */
  sessionBranches(id: string, base: string): Promise<Set<string>>;
  /** Whether GitHub knows `branch` in any of the session's repositories: a
   *  branch there, or a pull request's head. */
  knownOnGitHub(id: string, branch: string): Promise<boolean>;
  /** Record `to`, and that it's named for good, if the session is still on
   *  `from` and renamable: false when it isn't. Throws Postgres' 23505 when
   *  another session took `to` meanwhile. */
  rename(id: string, from: string, to: string): Promise<boolean>;
  /** It keeps its name from now on (pushed already). */
  settle(id: string): Promise<void>;
};

/** What a step answers: the name (check), a sentence (commit), or why not. */
export type RenameAnswer = { status: number; text?: string; error?: string };

const refuse = (status: number, error: string): RenameAnswer => ({ status, error });

/** Why `name` isn't one a branch is named, or null when it is. */
export function nameProblem(name: string): string | null {
  const match = NAME.exec(name);
  if (!match) {
    return "Name it <type>/<what-it-does>: lowercase words joined by hyphens after one type, e.g. fix/google-sign-in-redirect.";
  }
  const [, type, what] = match;
  if (TOOL_PREFIXES.has(type)) return `Start with the kind of change (${BRANCH_TYPES.join(", ")}) or its area, not ${type}/.`;
  if (what.length > MAX_WHAT) return `Keep what it does to a few words: ${what.length} characters is too long.`;
  return null;
}

/** Whether a rename may still happen, or why not. */
async function refusal(session: RenameSession | null, deps: RenameBranchDeps): Promise<RenameAnswer | null> {
  if (!session) return refuse(404, "That session isn't Outrunner's any more.");
  if (!session.branchRenamable) {
    return refuse(FINAL, `This branch, ${session.branch}, keeps its name: it was named already, or chosen, not made up by Outrunner.`);
  }
  if (await deps.hasPullRequest(session.id)) {
    await deps.settle(session.id);
    return refuse(FINAL, `This branch, ${session.branch}, has a pull request, so it keeps its name.`);
  }
  if (await deps.knownOnGitHub(session.id, session.branch)) {
    await deps.settle(session.id);
    return refuse(FINAL, `This branch, ${session.branch}, is on GitHub already, so it keeps its name.`);
  }
  return null;
}

/** `check`: the name the session may take, `-2`… when `name` is taken. */
export async function checkRename(sessionId: string, name: string, deps: RenameBranchDeps): Promise<RenameAnswer> {
  const problem = nameProblem(name);
  if (problem) return refuse(400, problem);
  const session = await deps.session(sessionId);
  const refused = await refusal(session, deps);
  if (refused) return refused;
  if (name === session!.branch) return refuse(409, `The branch is ${name} already.`);
  const sessions = await deps.sessionBranches(sessionId, name);
  sessions.delete(session!.branch);
  const free = await firstFreeBranch(name, async (branch) => sessions.has(branch) || (await deps.knownOnGitHub(sessionId, branch)));
  if (!free) return refuse(409, `${name} and its numbered names are all taken: pick another.`);
  return { status: 200, text: free };
}

/** `commit`: record the box's rename of `from` to `to`, if `to` is still
 *  free: taken since `check` (or never checked), it's refused. Recorded
 *  already (the box sending it again, its first answer lost): done. */
export async function commitRename(sessionId: string, from: string, to: string, deps: RenameBranchDeps): Promise<RenameAnswer> {
  if (nameProblem(to)) return refuse(400, "That isn't a name `check` gave.");
  const session = await deps.session(sessionId);
  if (session && session.branch === to && !session.branchRenamable) return { status: 200, text: to };
  const sessions = await deps.sessionBranches(sessionId, to);
  sessions.delete(from);
  if (sessions.has(to) || (await deps.knownOnGitHub(sessionId, to))) {
    return refuse(409, `${to} was taken meanwhile: run the command again.`);
  }
  try {
    if (!(await deps.rename(sessionId, from, to))) {
      return refuse(409, `The session isn't on ${from} any more, or its branch was named meanwhile.`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return refuse(409, `Another session took ${to} meanwhile: run the command again.`);
    }
    throw error;
  }
  return { status: 200, text: to };
}
