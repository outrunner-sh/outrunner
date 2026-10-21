import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { importSessions, type ImportProgress } from "@/lib/imports/client";
import { ImportCapture, ImportCommitRequest, type ScannedSession } from "@/lib/runtime/import-scan";

const fixtures = JSON.parse(readFileSync(path.join(process.cwd(), "lib/runtime/import-scan.fixtures.json"), "utf8"));
const capture = ImportCapture.parse(fixtures.Capture[0]);
const PROJECT = "22222222-2222-4222-8222-222222222222";

function session(key: string, extra: Partial<ScannedSession> = {}): ScannedSession {
  return { ...capture.session, key, sessionId: key.split(":")[1], ...extra };
}

test("each picked session is planned, captured, uploaded and committed, or says why not", async () => {
  const sessions = [
    session("claude:ok"),
    session("claude:planned-out"),
    session("claude:capture-skip"),
    session("claude:commit-fails"),
    session("claude:never", { skip: { reason: "worktree-missing" } }),
  ];
  const final = new Map<string, ImportProgress>();
  const commits: unknown[] = [];
  let planned: string[] = [];

  await importSessions(sessions, { branchAs: { "claude:ok": "mine" } }, {
    plan: async (req) => {
      planned = req.sessions.map((s) => `${s.key}${s.branchAs ? `>${s.branchAs}` : ""}`);
      return req.sessions.map((s, i) =>
        s.key === "claude:planned-out"
          ? { key: s.key, status: "skipped", skip: { reason: "no-repo-access" } }
          : {
              key: s.key,
              status: "ready",
              workspaceId: `33333333-3333-4333-8333-33333333333${i}`,
              projectId: PROJECT,
              branch: s.branchAs ?? "feature",
              renamed: false,
              importedAt: "2026-10-21T12:00:00.000Z",
              uploads: { bundle: { url: "u", path: "p" } },
            },
      );
    },
    capture: async (key) =>
      key === "claude:capture-skip"
        ? { skip: { reason: "too-large", detail: "over 1 GB" } }
        : { ...capture, session: { ...capture.session, key, sessionId: key.split(":")[1] } },
    commit: async (body) => {
      // What the page sends is what the route accepts.
      commits.push(ImportCommitRequest.parse(body));
      if (body.key === "claude:commit-fails") throw new Error("Could not finish the import.");
      return { workspace: { id: body.workspaceId } };
    },
    onProgress: (p) => final.set(p.key, p),
  });

  assert.deepEqual(planned, ["claude:ok>mine", "claude:planned-out", "claude:capture-skip", "claude:commit-fails"]);
  assert.deepEqual(
    Object.fromEntries([...final].map(([k, p]) => [k, [p.state, p.message ?? p.workspaceId ?? null]])),
    {
      "claude:ok": ["done", "33333333-3333-4333-8333-333333333330"],
      "claude:planned-out": ["skipped", "Your GitHub account can't see its repository."],
      "claude:capture-skip": ["skipped", "It's too large to import. (over 1 GB)"],
      "claude:commit-fails": ["failed", "Could not finish the import."],
    },
  );
  assert.equal(commits.length, 2);
  const first = commits[0] as ImportCommitRequest;
  assert.deepEqual([first.branch, first.bundleRef, first.artifacts.patch.encoding], ["mine", "feature", "gzip"]);
});
