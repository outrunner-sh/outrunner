import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRequestError } from "@/lib/runtime/agent-client";
import { archiveFailure } from "@/lib/session/archive-failure";

test("archive failures distinguish preparing, capturing and recording while keeping private diagnostics out of the UI", () => {
  const detail = new Error("PUT https://private-storage.test/signed?token=secret failed");
  assert.match(archiveFailure(detail, "prepare").error, /couldn't prepare.*were kept/);
  assert.match(archiveFailure(detail, "capture").error, /files couldn't be saved.*session was kept/);
  assert.match(archiveFailure(detail, "record").error, /files were uploaded.*couldn't record.*was kept/);
  for (const stage of ["prepare", "capture", "record"] as const) {
    assert.doesNotMatch(archiveFailure(detail, stage).error, /secret|private-storage|Try again/);
  }
  const auth = archiveFailure(new AgentRequestError(401, { code: "UNAUTHORIZED", message: "wrong secret" }), "capture");
  assert.equal(auth.status, 409);
  assert.match(auth.error, /box answered.*couldn't access.*were kept/);
});

test("a pending chat fork keeps its actionable refusal without exposing arbitrary agent errors", () => {
  const refusal = new AgentRequestError(500, {
    code: "INTERNAL",
    message: "chat c1 has an unspent fork handoff; send its first prompt or delete the chat before archiving",
  });
  assert.deepEqual(archiveFailure(refusal, "capture"), {
    status: 409,
    error: "One of its chats has a pending fork. Send that chat's first message or delete the chat before archiving. The session and its files were kept.",
  });
  const privateDetail = new AgentRequestError(500, { code: "INTERNAL", message: "upload https://storage.test?token=secret failed" });
  assert.match(archiveFailure(privateDetail, "capture").error, /files couldn't be saved/);
  assert.doesNotMatch(archiveFailure(privateDetail, "capture").error, /secret|storage.test/);
});
