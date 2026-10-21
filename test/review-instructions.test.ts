import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewInstructions } from "@/lib/session/review-instructions";

test("the guidelines diff against the session's own target branch", () => {
  const md = reviewInstructions({ baseBranch: "develop", pullRequestNumber: null });
  assert.match(md, /^The target branch is origin\/develop\.$/m);
  assert.match(md, /git merge-base origin\/develop HEAD/);
  // Both halves: committed work against the merge base, and what isn't
  // committed yet. A review that saw only one would miss live edits.
  assert.match(md, /git diff \$MERGE_BASE HEAD/);
  assert.match(md, /git diff HEAD/);
});

test("an open pull request is named as the change under review", () => {
  const md = reviewInstructions({ baseBranch: "main", pullRequestNumber: 99 });
  assert.match(md, /pull request #99/);
});

test("without a pull request the change is the workspace diff, with no number invented", () => {
  const md = reviewInstructions({ baseBranch: "main", pullRequestNumber: null });
  assert.doesNotMatch(md, /pull request #/);
  assert.match(md, /^The change under review is everything in this workspace/m);
});

test("findings come back in the final message, and nothing is posted to GitHub", () => {
  // The session shows the agent's last message (the orientation says so), and
  // publishing a review to GitHub is the user's call, not a side effect of
  // asking Outrunner for one.
  const md = reviewInstructions({ baseBranch: "main", pullRequestNumber: 12 });
  assert.match(md, /Report the findings in your final message/);
  assert.match(md, /Do not post anything to GitHub/);
  // Conductor's MCP tools do not exist here; referring to them would have the
  // agent hunt for a tool it hasn't got.
  assert.doesNotMatch(md, /mcp__conductor__/);
});
