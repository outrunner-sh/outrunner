import assert from "node:assert/strict";
import { test } from "node:test";

import { autoReviewRequest } from "@/lib/api/auto-review";
import type { SessionCheckout } from "@/lib/runtime/types";
import { REVIEW_INSTRUCTIONS_FILENAME, REVIEW_PROMPT, reviewInstructions } from "@/lib/session/review-instructions";

const WEB = "11111111-1111-4111-8111-111111111111";
const API = "22222222-2222-4222-8222-222222222222";

test("no pull request opened, no review asked for", () => {
  assert.equal(autoReviewRequest(null, []), null);
});

test("a session's pull request is reviewed as the Review button asks", () => {
  const request = autoReviewRequest(null, [{ projectId: WEB, number: 412, baseBranch: "main" }]);
  assert.deepEqual(request, {
    prompt: REVIEW_PROMPT,
    files: [{ filename: REVIEW_INSTRUCTIONS_FILENAME, content: reviewInstructions({ baseBranch: "main", pullRequestNumber: 412 }) }],
  });
  assert.match(request!.files[0].content, /pull request #412/);
  assert.match(request!.files[0].content, /origin\/main/);
});

test("in a session of several repositories, each pull request gets its own repository's review", () => {
  const checkouts: SessionCheckout[] = [
    { projectId: WEB, fullName: "acme/web", checkout: "web", baseBranch: "main" },
    { projectId: API, fullName: "acme/api", checkout: "api", baseBranch: "develop" },
  ];
  const one = autoReviewRequest(checkouts, [{ projectId: API, number: 7, baseBranch: "develop" }]);
  assert.equal(one!.files.length, 1);
  assert.equal(one!.files[0].filename, REVIEW_INSTRUCTIONS_FILENAME);
  assert.match(one!.files[0].content, /git -C api diff origin\/develop\.\.\./);

  const both = autoReviewRequest(checkouts, [
    { projectId: WEB, number: 412, baseBranch: "main" },
    { projectId: API, number: 7, baseBranch: "develop" },
  ]);
  assert.deepEqual(
    both!.files.map((f) => f.filename),
    ["Review request (web).md", "Review request (api).md"],
  );
  assert.match(both!.files[0].content, /pull request #412 on acme\/web/);
  assert.match(both!.files[1].content, /pull request #7 on acme\/api/);
});
