import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentClient, AgentRequestError } from "@/lib/runtime/agent-client";
import { withRuntimeAgentRecovery } from "@/lib/runtime/agent-recovery";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { SNAPSHOT_ARTIFACTS, type SnapshotArtifact } from "@/lib/runtime/snapshot/manifest";
import { archiveFailureReport } from "@/lib/session/archive-failure";
import { archiveFailureLog } from "@/lib/session/archive-failure-log";
import { saveForArchive } from "@/lib/session/archive-save";

function reports(message: string) {
  const error = new AgentRequestError(500, { code: "INTERNAL", message });
  const publicReport = archiveFailureReport(error, "capture", "fixture-reference");
  const log = archiveFailureLog(error, publicReport.diagnostic);
  assert.ok("legacy" in log);
  return { publicReport, log, legacy: log.legacy };
}

test("legacy save failures retain distinct operation and reason hints only in server diagnostics", () => {
  for (const [message, expected] of [
    ["git bundle: exit status 128: fatal: not a git repository: /private/worktree", { operation: "git_bundle", reason: "not_git_repository", exitCode: 128 }],
    ["private-checkout: git bundle: exit status 128: fatal: detected dubious ownership in repository at '/home/private'", { operation: "git_bundle", reason: "dubious_ownership", exitCode: 128 }],
    ["git bundle: exit status 128: fatal: Refusing to create empty bundle.", { operation: "git_bundle", reason: "empty_bundle", exitCode: 128 }],
    ["write patch: open /private/snapshot.patch: permission denied", { operation: "write_patch", reason: "permission_denied" }],
    ["snapshot staging dir: mkdir /private/tmp: no space left on device", { operation: "staging", reason: "no_space" }],
    ["open private-conversation.jsonl: open /private/chat: no such file or directory", { operation: "artifact_io", reason: "missing_file" }],
    ["tmux kill-session private-session: exit status 1: private output", { operation: "stop_session", reason: "unknown", exitCode: 1 }],
    ['upload conversation: Put "https://user:secret@storage.test/private?token=secret": context deadline exceeded (Client.Timeout exceeded while awaiting headers)', { operation: "upload", reason: "timeout", artifact: "conversation" }],
    ['upload chats/private-chat/rollout.jsonl: Put "https://storage.test/private": dial tcp: lookup storage.test on 10.0.0.1:53: no such host', { operation: "upload", reason: "dns", artifact: "chat" }],
  ] as const) {
    const { publicReport, log, legacy } = reports(message);
    assert.deepEqual(legacy, { ...expected, inputTruncated: false });
    assert.match(publicReport.error, /HTTP 500, INTERNAL.*files were kept.*fixture-reference/);
    assert.equal(publicReport.status, 502);
    assert.equal("legacy" in publicReport.diagnostic, false);
    assert.doesNotMatch(JSON.stringify({ publicReport, log }), /private|secret|storage\.test|10\.0\.0\.1/);
  }
});

test("unknown credentials, URLs, paths, response bodies and log injection never survive projection", () => {
  const secrets = [
    "Bearer arbitrary-short-secret", "Authorization: Basic dXNlcjpwYXNz", "ghp_token", "github_pat_token", "sk-api-key",
    "password=unknown-value", '"access_token":"arbitrary-value"', "opaque-value-with-no-credential-shape",
    "https://user:password@example.test/private?X-Amz-Signature=secret", "postgres://user:secret@host/db",
    "file:///home/private/work", "/home/private/with spaces/a.jsonl", "C:\\Users\\private\\work", "../private/work",
    "\\u002fhome\\u002fprivate", "%2Fprivate%2Fwork", "\u001b[31m\r\narchive_failed forged\u202e",
  ];
  for (const privateText of secrets) {
    // Raw content is omitted even when it uses a previously unknown secret shape.
    for (const prefix of ["", "git bundle: exit status 128: ", "upload conversation: "]) {
      const { log, legacy } = reports(prefix + privateText);
      assert.equal(legacy.reason, "unknown");
      assert.equal(JSON.stringify(log).includes(privateText), false);
      assert.ok(JSON.stringify(legacy).length < 200);
    }
  }
  // A storage body must not masquerade as an operation-specific cause.
  const error = new AgentRequestError(500, { code: "INTERNAL", message: "upload conversation: unexpected status 503: permission denied /private" });
  const report = archiveFailureReport(error, "capture", "fixture-reference");
  const log = archiveFailureLog(error, report.diagnostic);
  assert.equal("legacy" in log, false);
  assert.equal(log.snapshot?.cause, "storage_http");
  assert.doesNotMatch(JSON.stringify(log), /permission|private/);
});

test("inspection and output are bounded; unknown and truncated tails remain unknown", () => {
  const huge = "git bundle: exit status 128: " + "x".repeat(1_000_000) + ": permission denied";
  const { legacy } = reports(huge);
  assert.deepEqual(legacy, { operation: "git_bundle", reason: "unknown", exitCode: 128, inputTruncated: true });
  assert.ok(JSON.stringify(legacy).length < 200);
  assert.equal(reports("git bundle: exit status 999: private").legacy.exitCode, undefined);
  assert.equal(reports("git bundle: exit status 12345: private").legacy.exitCode, undefined);
  assert.deepEqual(reports("unrecognized private error").legacy, { operation: "unknown", reason: "unknown", inputTruncated: false });
});

test("typed metadata and unrelated failures keep their existing diagnostic without legacy parsing", () => {
  const typed = new AgentRequestError(500, { code: "INTERNAL", message: "private", snapshot: { stage: "capture", cause: "missing_file", artifact: "bundle" } });
  for (const [error, stage] of [[typed, "capture"], [new Error("private"), "capture"], [new AgentRequestError(401, { code: "UNAUTHORIZED", message: "private" }), "capture"], [typed, "prepare"], [typed, "record"]] as const) {
    const report = archiveFailureReport(error, stage, "fixture-reference");
    assert.deepEqual(archiveFailureLog(error, report.diagnostic), report.diagnostic);
  }
});

test("legacy HTTP 500 envelopes remain failed saves with server-only hints through the real client and recovery", async () => {
  for (const malformedMetadata of [false, true]) {
    const target = { controlBaseUrl: "https://agent.test", wsBaseUrl: "wss://agent.test", controlHeaders: {}, secret: "fixture-secret" };
    const message = "git bundle: exit status 128: fatal: not a git repository: /private/worktree";
    let upgrades = 0;
    let calls = 0;
    const agent = new AgentClient(target, async () => {
      calls++;
      return Response.json({ error: { code: "INTERNAL", message, ...(malformedMetadata && { snapshot: { stage: "invalid", cause: "secret" } }) } }, { status: 500 });
    });
    const identity = { userId: "owner", computerId: "computer", projectId: "project", workspaceId: "ship" };
    const provider = { agentTarget: async () => { throw new Error("must not refresh a reachable agent"); } } as unknown as ComputerRuntimeProvider;
    await assert.rejects(saveForArchive({
      bringBack: async () => {}, connect: async () => agent,
      capture: async () => (await withRuntimeAgentRecovery({ provider, agent, identity, sandboxId: "box", secret: target.secret, workspaceId: "ship", upgrade: async () => { upgrades++; } },
        (current) => current.archiveWorkspace(identity, { archivedAt: "2026-10-29T00:00:00Z", uploads: (Object.keys(SNAPSHOT_ARTIFACTS) as SnapshotArtifact[]).map((artifact) => ({ artifact, url: `https://storage.test/${artifact}` })) }),
      )).result,
    }), (error) => {
      assert.ok(error instanceof AgentRequestError);
      const report = archiveFailureReport(error, "capture", "fixture-reference");
      const log = archiveFailureLog(error, report.diagnostic);
      assert.ok("legacy" in log);
      assert.equal(log.legacy.operation, "git_bundle");
      assert.equal(log.legacy.exitCode, 128);
      assert.doesNotMatch(JSON.stringify({ report, log }), /private|worktree/);
      assert.equal("legacy" in report.diagnostic, false);
      assert.match(report.error, /files were kept.*fixture-reference/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(upgrades, 0);
  }
});
