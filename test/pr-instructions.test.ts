import assert from "node:assert/strict";
import { test } from "node:test";

import { EVIDENCE_REPLY_RULE } from "@/lib/session/pr-template";
import { prInstructions } from "@/lib/session/pr-instructions";

const DESKTOP = { desktop: true };
const NO_DESKTOP = { desktop: false };
const FOOTER = { sessionUrl: "https://app.outrunner.sh/workspaces/ws-1", userName: "Ada Lovelace" };

function instructions(over: Partial<Parameters<typeof prInstructions>[0]> = {}) {
  return prInstructions({ branch: "b", baseBranch: "main", uncommitted: 0, tools: DESKTOP, footer: FOOTER, ...over });
}

test("the instructions name the branch, its target and what's uncommitted", () => {
  const md = instructions({ branch: "runtime/abc", baseBranch: "develop", uncommitted: 3 });
  assert.match(md, /^There are 3 uncommitted changes\.$/m);
  assert.match(md, /^The current branch is runtime\/abc\.$/m);
  assert.match(md, /^The target branch is origin\/develop\.$/m);
  assert.match(md, /`git push -u origin runtime\/abc`/);
  assert.match(md, /`git diff origin\/develop\.\.\.`/);
  assert.match(md, /`gh pr create --base develop --title "…" --body-file <file>`/);
});

test("one uncommitted change is singular, none says so", () => {
  assert.match(instructions({ uncommitted: 1 }), /^There is 1 uncommitted change\.$/m);
  assert.match(instructions({ uncommitted: 0 }), /^There are no uncommitted changes\.$/m);
});

test("an unknown count is left out rather than guessed", () => {
  const md = instructions({ uncommitted: null });
  assert.doesNotMatch(md, /^There (is|are) .*uncommitted/m);
  assert.match(md, /^The current branch is b\.$/m);
});

test("on a box with a desktop, a visible change is run, checked, captured and uploaded before the PR", () => {
  const md = instructions({ baseBranch: "develop" });
  const evidence = md.indexOf("produce the evidence now");
  const push = md.indexOf("git push -u origin");
  assert.ok(evidence > 0 && evidence < push, "the evidence comes before the push and gh pr create");
  for (const step of [
    /1\. Run the app/,
    /\*\*Before\*\*, reproduce it on origin\/develop without disturbing this branch's work: a second worktree \(`git worktree add \/tmp\/before origin\/develop`/,
    /`git stash -u`/,
    /2\. For \*\*After\*\*, verify the change on this branch in Chromium on the session desktop/,
    /3\. Capture screenshots, or record with `record_start` \/ `record_stop` and make a GIF/,
    /4\. Upload them, and write the body from the template with Evidence, "Verified in the browser" and Tests filled in/,
    /`curl -fsSL https:\/\/get\.docker\.com \| sudo sh`/,
    /`outrunner media gif <recording\.mp4>/,
    /never "screenshot"/,
    /Backend-only and docs changes skip this/,
  ]) {
    assert.match(md, step);
  }
  // Even with a desktop, missing tools never fail the PR.
  assert.match(md, /If the desktop or upload tools turn out not to be available in this session, don't fail the PR/);
});

test("without a desktop the template still applies, and Evidence says why there is none", () => {
  const md = instructions({ tools: NO_DESKTOP });
  assert.match(md, /has no desktop to verify the change in a browser/);
  assert.match(md, /Still use the template, and don't fail the PR: under Evidence, say in one line why there is none/);
  assert.match(md, /each item unchecked with the reason/);
  assert.doesNotMatch(md, /record_start|get\.docker\.com|verify the change on this branch in Chromium/);
  assert.match(md, /## Evidence\n/);
  assert.ok(md.includes(EVIDENCE_REPLY_RULE));
  assert.match(md, /### Verified in the browser/);
});

test("a push to an open PR refreshes its evidence, keeping the footer", () => {
  assert.ok(instructions().includes(EVIDENCE_REPLY_RULE), "Create PR requires the same uploaded embeds in the final chat reply");
  assert.match(instructions(), /Then share its link and evidence in your final chat reply/);
  assert.match(instructions(), /If this branch already has a pull request, the push updates it\. When a push updates an open PR and the new commits change what a person sees, capture new evidence and refresh the Evidence section with `gh pr edit --body-file`, keeping the footer\./);
});

test("the body is the template, ending in the session's footer", () => {
  const md = instructions();
  assert.match(md, /under 80 characters, as "Area: what changes, plainly"/);
  assert.match(md, /Describe the whole branch diff/);
  assert.match(md, /<sub>Created by \*\*Ada Lovelace\*\* with \[Outrunner\]\(https:\/\/app\.outrunner\.sh\/workspaces\/ws-1\)<\/sub>/);
  assert.match(md, /keep the footer and any Co-Authored-By trailers it already has exactly as they are/);
  assert.doesNotMatch(md, /under five sentences/);
});
