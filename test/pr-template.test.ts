import assert from "node:assert/strict";
import { test } from "node:test";

import { CreateWorkspaceRequest } from "@/lib/runtime/agent-protocol";
import { bullets, commitAttributionSection, EVIDENCE_RULES, evidenceToolsFor, PR_BODY_TEMPLATE, prFooter, prGuide } from "@/lib/session/pr-template";

const INPUT = {
  tools: { desktop: true },
  baseBranch: "main",
  sessionUrl: "https://app.outrunner.sh/workspaces/ws-1",
  userName: "Ada Lovelace",
};

test("the body's sections come in #291's order", () => {
  const order = ["## How it works", "### Other changes", "## Evidence", "**Before (", "**After:**", "### Verified in the browser", "### Tests", "<footer>"];
  const at = order.map((heading) => PR_BODY_TEMPLATE.indexOf(heading));
  assert.ok(at.every((i) => i >= 0), `missing: ${order.filter((_, i) => at[i] < 0).join(", ")}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.match(PR_BODY_TEMPLATE, /- \[x\] .*\n- \[ \] /);
});

test("the footer credits the user and links the session, with their trailers", () => {
  assert.equal(
    prFooter({ sessionUrl: "https://app/workspaces/w", userName: "Ada", coAuthors: ["Ada <ada@example.com>"] }),
    "---\n\n<sub>Created by **Ada** with [Outrunner](https://app/workspaces/w)</sub>\n\nCo-Authored-By: Ada <ada@example.com>",
  );
  // No name known: the agent takes the session's git user, which is the user's.
  assert.match(prFooter({ sessionUrl: "https://app/workspaces/w" }), /Created by \*\*<the session's git user\.name>\*\*/);
  assert.doesNotMatch(prFooter({ sessionUrl: "https://app/workspaces/w", userName: "Ada" }), /Co-Authored-By/);
});

test("commits credit the prompting user from project variables, then their GitHub fallback", () => {
  const section = commitAttributionSection(["Ada <1+ada@users.noreply.github.com>"]);
  assert.match(section, /Every commit made for this pull request must credit the user who prompted the work/);
  assert.match(section, /project variables `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`/);
  assert.match(section, /`Co-Authored-By: Ada <1\+ada@users\.noreply\.github\.com>`/);
  assert.match(section, /inspect every commit unique to the branch and amend or rebase any that is missing/);
});

test("the evidence rules are the media guide's", () => {
  const rules = EVIDENCE_RULES.join("\n");
  for (const rule of [
    /still screenshots for static UI/,
    /short looping GIF \(3–10 s\)/,
    /Never a grid or contact sheet of frames/,
    /the same crop for both/,
    /two-column Markdown table/,
    /A new feature usually needs only the after/,
    /16:9 \(1280×720 or 1920×1080\) at 30–60 fps/,
    /under GitHub's 5 MB/,
    /never "screenshot"/,
    /videos are private unless uploaded with access public/,
    /Never commit screenshots to the repository, use local paths or expiring URLs, or rely on `gh --attach`/,
    /never do it as routine cleanup/,
    /stay on the box/,
  ]) {
    assert.match(rules, rule);
  }
});

test("only Daytona's boxes have a desktop", () => {
  assert.deepEqual(evidenceToolsFor("daytona"), { desktop: true });
  assert.deepEqual(evidenceToolsFor("user-daytona"), { desktop: true });
  for (const provider of ["modal", "user-modal", "neev", "local", null] as const) {
    assert.deepEqual(evidenceToolsFor(provider), { desktop: false }, String(provider));
  }
});

test("a session's standing guide has the template, the evidence flow and its footer", () => {
  const guide = prGuide({ ...INPUT, coAuthors: ["Ada <1+ada@users.noreply.github.com>"] });
  assert.match(guide, /^# Pull requests\n\nWhenever you open or update a pull request, write it this way\./);
  assert.match(guide, /Every commit made for this pull request must credit the user who prompted the work/);
  assert.match(guide, /Co-Authored-By: Ada <1\+ada@users\.noreply\.github\.com>/);
  assert.match(guide, /## How it works/);
  assert.match(guide, /verify the change on this branch in Chromium on the session desktop/);
  assert.match(guide, /refresh the Evidence section with `gh pr edit --body-file`, keeping the footer/);
  assert.match(guide, /Created by \*\*Ada Lovelace\*\* with \[Outrunner\]\(https:\/\/app\.outrunner\.sh\/workspaces\/ws-1\)/);
  // Without a desktop: the fallback, and none of the desktop's steps.
  const without = prGuide({ ...INPUT, tools: { desktop: false } });
  assert.match(without, /Still use the template, and don't fail the PR/);
  assert.doesNotMatch(without, /record_start|get\.docker\.com/);
  // It rides with the session's create, within the protocol's bound.
  assert.ok(CreateWorkspaceRequest.safeParse({ workspaceId: "w", repoFullName: "a/b", branch: "b", baseBranch: "main", guide }).success);
});

test("multi-repo guides select the base for the repository being changed", () => {
  const guide = prGuide({ ...INPUT, checkouts: [{ checkout: "web", baseBranch: "main" }, { checkout: "api", baseBranch: "develop" }] });
  assert.match(guide, /Checkout web: origin\/main/);
  assert.match(guide, /Checkout api: origin\/develop/);
  assert.match(guide, /git worktree add \/tmp\/before origin\/<base>/);
  assert.doesNotMatch(guide, /git worktree add \/tmp\/before origin\/main/);
});

test("without a desktop only visible changes require missing-evidence explanations", () => {
  const guide = prGuide({ ...INPUT, tools: { desktop: false } });
  assert.match(guide, /If the diff changes UI or behaviour a person can see, this session's box has no desktop/);
  assert.match(guide, /Backend-only or docs changes leave out "Evidence" and "Verified in the browser"/);
});

test("numbered evidence steps keep double-digit numbering", () => {
  assert.equal(bullets(["9. Capture", "10. Upload", "Other"]), "9. Capture\n10. Upload\n- Other");
});
