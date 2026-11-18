import assert from "node:assert/strict";
import { test } from "node:test";

import { prInstructionFooter, prInstructions } from "@/lib/session/pr-instructions";
import { EVIDENCE_REPLY_RULE } from "@/lib/session/pr-template";

const DESKTOP = { desktop: true };
const NO_DESKTOP = { desktop: false };
const FOOTER = { sessionUrl: "https://app.outrunner.sh/workspaces/ws-1", userName: "Ada Lovelace" };

function instructions(over: Partial<Parameters<typeof prInstructions>[0]> = {}) {
  return prInstructions({ branch: "b", baseBranch: "main", changedFiles: 0, tools: DESKTOP, footer: FOOTER, ...over });
}

test("the instructions name the branch, its target and how many files differ from it", () => {
  const md = instructions({ branch: "runtime/abc", baseBranch: "develop", changedFiles: 3 });
  assert.match(md, /^3 files differ from origin\/develop\.$/m);
  // Not "uncommitted": the count is the whole branch's, commits included.
  assert.doesNotMatch(md, /^There (is|are) .*uncommitted/m);
  assert.match(md, /^The current branch is runtime\/abc\.$/m);
  assert.match(md, /^The target branch is origin\/develop\.$/m);
  // HEAD, not the name: its agent may have renamed the branch since.
  assert.match(md, /`git push -u origin HEAD`/);
  assert.match(md, /`git diff origin\/develop\.\.\.`/);
  assert.match(md, /`gh pr create --base develop --title "…" --body-file <file>`/);
});

test("the instructions require the prompting user's co-author trailer on every commit", () => {
  const md = instructions({ footer: { ...FOOTER, coAuthors: ["Ada <1+ada@users.noreply.github.com>"] } });
  assert.match(md, /project variables `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`/);
  assert.match(md, /`Co-Authored-By: Ada <1\+ada@users\.noreply\.github\.com>`/);
  assert.match(md, /Before pushing, inspect every commit unique to the branch/);
});

test("the Environment panel's Create PR footer carries the trusted co-author", () => {
  const footer = prInstructionFooter("https://app/workspaces/w", "Ada <1+ada@users.noreply.github.com>");
  const md = instructions({ footer });
  assert.deepEqual(footer.coAuthors, ["Ada <1+ada@users.noreply.github.com>"]);
  assert.match(md, /`Co-Authored-By: Ada <1\+ada@users\.noreply\.github\.com>`/);
});

test("one changed file is singular, none says so", () => {
  assert.match(instructions({ changedFiles: 1 }), /^1 file differs from origin\/main\.$/m);
  assert.match(instructions({ changedFiles: 0 }), /^No files differ from origin\/main\.$/m);
});

test("an unknown count is left out rather than guessed", () => {
  const md = instructions({ changedFiles: null });
  assert.doesNotMatch(md, /differ from/);
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

test("a stand-in branch is named for good before the push, and only then", () => {
  const named = instructions({ branch: "right-sidebar-expandable", baseBranch: "main", changedFiles: 1, nameBranch: true });
  const rename = named.indexOf("outrunner-session rename-branch");
  assert.ok(rename > 0 && rename < named.indexOf("git push -u origin HEAD"), named);
  assert.match(named, /If the branch is still right-sidebar-expandable/);
  assert.doesNotMatch(instructions({ branch: "fix/x", baseBranch: "main", changedFiles: 1 }), /rename-branch/);
});
