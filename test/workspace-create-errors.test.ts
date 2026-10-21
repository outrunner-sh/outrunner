import assert from "node:assert/strict";
import { test } from "node:test";

import { branchTakenResponse, workspaceCreateErrorResponse } from "@/lib/http/workspace-create-errors";

/** The error Supabase returns when the live-branch index refuses the insert. */
function branchTaken(): { code: string; message: string } {
  return {
    code: "23505",
    message: 'duplicate key value violates unique constraint "workspaces_active_branch_unique"',
  };
}

test("a taken branch names the session that holds it, and links to it", async () => {
  const response = branchTakenResponse({ id: "w-1", label: "Fix the flaky test" });
  const body = (await response.json()) as { error: string; sessionHref: string };
  assert.equal(response.status, 409);
  assert.equal(
    body.error,
    "“Fix the flaky test” is already working on that branch. Open that session, or pick another branch.",
  );
  assert.equal(body.sessionHref, "/workspaces/w-1");
});

test("a branch another session holds answers 409, saying what to do about it", async () => {
  const response = workspaceCreateErrorResponse(branchTaken(), "context");
  const body = (await response.json()) as { error: string };
  assert.equal(response.status, 409);
  assert.equal(
    body.error,
    "Another session is already working on that branch. Pick another branch, or open that session from the sidebar.",
  );
});

test("the conflict answer keeps nothing in the log", async () => {
  const error = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(...args);
  try {
    workspaceCreateErrorResponse(branchTaken(), "context");
    assert.deepEqual(logged, []);
  } finally {
    console.error = error;
  }
});

test("anything else answers 500 and keeps its message in the log", async () => {
  const error = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(...args);
  try {
    const failure = new Error("connect ECONNREFUSED 10.0.0.9:5432");
    const response = workspaceCreateErrorResponse(failure, "context");
    const body = (await response.json()) as { error: string };
    assert.equal(response.status, 500);
    assert.equal(body.error, "Couldn't create the session. Try again in a moment.");
    assert.deepEqual(logged, ["context", failure]);
  } finally {
    console.error = error;
  }
});
