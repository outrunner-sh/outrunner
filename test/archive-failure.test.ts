import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRequestError, InvalidSnapshotManifestError } from "@/lib/runtime/agent-client";
import { archiveFailure, archiveFailureReport } from "@/lib/session/archive-failure";

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
  assert.match(archiveFailure(privateDetail, "capture").error, /files were kept/);
  assert.doesNotMatch(archiveFailure(privateDetail, "capture").error, /secret|storage.test/);
});

test("legacy storage rejections identify the failed artifact/status without disclosing the response body", () => {
  const error = new AgentRequestError(500, {code: "INTERNAL", message: "upload conversation: unexpected status 503: signed=https://secret.test?token=private"});
  const result = archiveFailureReport(error, "capture", "fixture-ref");
  assert.match(result.error, /storage rejected.*conversation.*HTTP 503.*operator.*files were kept.*fixture-ref/);
  assert.deepEqual(result.diagnostic, {
    reference: "fixture-ref", stage: "capture", agentHttpStatus: 500, agentCode: "INTERNAL",
    snapshot: { stage: "upload", cause: "storage_http", httpStatus: 503, artifact: "conversation" },
  });
  assert.doesNotMatch(JSON.stringify(result), /secret.test|token=|private/);
  const chat = archiveFailure(new AgentRequestError(500, {code: "INTERNAL", message: "upload chats/c1/rollout.jsonl: unexpected status 403: private"}), "capture");
  assert.match(chat.error, /chat.*HTTP 403/);
});

test("structured capture failures remain distinct from upload and unknown agent failures", () => {
  for (const [snapshot, expected] of [
    [{ stage: "capture", artifact: "bundle", cause: "command_failed", exitCode: 128 }, /capture its repository.*bundle.*128/],
    [{ stage: "capture", artifact: "conversation", cause: "missing_file" }, /file.*missing.*remaining files were kept/],
    [{ stage: "upload", artifact: "chat", cause: "network" }, /couldn't reach Snapshot storage.*chat/],
  ] as const) {
    const result = archiveFailureReport(new AgentRequestError(500, {code:"INTERNAL",message:"/private/worktree?token=secret", snapshot}), "capture", "fixture-ref");
    assert.match(result.error, expected);
    assert.doesNotMatch(JSON.stringify(result), /private|token=secret/);
  }
  const unknown = archiveFailureReport(new AgentRequestError(500, {code:"INTERNAL",message:"something private failed"}), "capture", "fixture-ref");
  assert.match(unknown.error, /HTTP 500, INTERNAL.*files were kept/);
  assert.equal(unknown.diagnostic.snapshot, undefined, "unknown failures must not be guessed as storage failures");
});

test("invalid archive manifests are distinguished from other response validation failures", () => {
  const result = archiveFailureReport(new InvalidSnapshotManifestError(new Error("private manifest")), "capture", "ref");
  assert.match(result.error, /invalid Snapshot manifest.*files were kept/);
  assert.equal(result.diagnostic.invalidManifest, true);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  const health = Object.assign(new Error("private health response"), { name: "ZodError" });
  assert.equal(archiveFailureReport(health, "capture", "ref").diagnostic.invalidManifest, undefined);
});
