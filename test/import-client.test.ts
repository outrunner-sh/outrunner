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

test("each repository's picked environment is read on the Mac and kept, one failing alone", async () => {
  const { importEnvironments } = await import("@/lib/imports/client");
  const saved: string[] = [];
  const results = await importEnvironments(
    [
      { repo: "ada/app", vars: ["APP_TOKEN", "PATH"], files: ["api/.env"], scripts: true },
      { repo: "ada/none", vars: [], files: [], scripts: false },
      { repo: "ada/gone", vars: ["X"], files: [], scripts: false },
    ],
    {
      read: async (repo, pick) => {
        if (repo === "ada/gone") throw new Error("nothing of ada/gone's environment is on this Mac any more");
        return { repo, env: Object.fromEntries(pick.vars.map((v) => [v, "x"])), files: { "api/.env": "A=1\n" } };
      },
      save: async (capture) => {
        saved.push(capture.repo);
        return { refused: capture.env.PATH ? ["PATH"] : [] };
      },
    },
  );
  assert.deepEqual(saved, ["ada/app"]);
  assert.deepEqual(results, [
    { repo: "ada/app", ok: true, message: "Left out PATH: cloud sessions set those themselves." },
    { repo: "ada/gone", ok: false, message: "nothing of ada/gone's environment is on this Mac any more" },
  ]);
});

test("the picked setup is archived to the planned place and committed with it", async () => {
  const { importAgentConfig } = await import("@/lib/imports/client");
  const sha = `sha256:${"5".repeat(64)}`;
  const commits: unknown[] = [];
  const result = await importAgentConfig(
    { items: ["claude-md"], mcp: ["tracker"], plugins: false },
    {
      plan: async () => ({ path: "archives/u/agent-config/a.tar.gz", url: "https://upload" }),
      capture: async (pick) => {
        assert.equal(pick.upload, "https://upload");
        return {
          archive: { name: "agent-config.tar.gz", path: "/tmp/x", sha256: sha, size: 7, encoding: "gzip" },
          items: pick.items,
          mcpServers: { tracker: { url: "https://mcp" } },
          settings: {},
        };
      },
      commit: async (req) => void commits.push(req),
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(commits, [
    {
      archive: { path: "archives/u/agent-config/a.tar.gz", sha256: sha, size: 7 },
      items: ["claude-md"],
      mcpServers: { tracker: { url: "https://mcp" } },
      settings: {},
    },
  ]);
  // MCP servers alone need no archive, and nothing picked does nothing.
  let planned = 0;
  const mcpOnly = await importAgentConfig(
    { items: [], mcp: ["tracker"], plugins: false },
    {
      plan: async () => {
        planned++;
        return { path: "", url: "" };
      },
      capture: async () => ({ items: [], mcpServers: { tracker: {} }, settings: {} }),
      commit: async () => {},
    },
  );
  assert.deepEqual([mcpOnly, planned], [{ ok: true }, 0]);
});

test("a setup pick a rescan no longer offers is not imported, and a skipped one never is", async () => {
  const { configInScan } = await import("@/lib/imports/client");
  const scan = {
    config: {
      items: [
        { id: "claude-md", kind: "claude-md" as const, name: "CLAUDE.md", path: "", bytes: 0 },
        { id: "skill:huge", kind: "skill" as const, name: "huge", path: "", bytes: 0, skip: { reason: "too-large" as const } },
      ],
      mcpServers: [
        { name: "tracker", transport: "http", envNames: [], headerNames: [] },
        { name: "onlyhere", transport: "stdio", envNames: [], headerNames: [], skip: { reason: "unportable-mcp" as const } },
      ],
      plugins: [],
    },
  };
  const config = { items: ["claude-md", "skill:huge", "skill:vanished"], mcp: ["tracker", "onlyhere"], plugins: true };

  // No plugins in this scan, so a plugins pick from an earlier one is dropped.
  assert.deepEqual(configInScan(config, scan), { items: ["claude-md"], mcp: ["tracker"], plugins: false });
  // Before the first scan lands nothing is picked, so Import stays disabled.
  assert.deepEqual(configInScan(config, null), { items: [], mcp: [], plugins: false });
});

test("a workspace archived in Conductor is neither offered nor listed as blocked", async () => {
  const { offeredSessions } = await import("@/lib/imports/client");
  const live = session("claude:live", { conductorState: "ready" });
  const cli = session("claude:cli", { conductorState: undefined });
  const gone = session("claude:gone", { skip: { reason: "worktree-missing" } });
  const { importable, blocked } = offeredSessions([
    live,
    session("claude:put-away", { conductorState: "archived" }),
    cli,
    gone,
    session("claude:put-away-gone", { conductorState: "archived", skip: { reason: "worktree-missing" } }),
  ]);
  assert.deepEqual(importable.map((s) => s.key), ["claude:live", "claude:cli"]);
  assert.deepEqual(blocked.map((s) => s.key), ["claude:gone"]);
});

test("a project's environment on the Mac is found by its repository, in any case", async () => {
  const { environmentFor } = await import("@/lib/imports/client");
  const app = { repo: "Ada/App", vars: [{ name: "APP_TOKEN", shared: false }], files: [] };
  assert.equal(environmentFor([app], "ada/app"), app);
  assert.equal(environmentFor([app], "ada/other"), null);
  assert.equal(environmentFor([], "ada/app"), null);
});

test("secrets need agreement; scripts, items and plugins alone don't", async () => {
  const { environmentPickSecrets, configPickSecrets, hasEnvironmentPick, hasConfigPick } = await import(
    "@/lib/imports/client"
  );
  const none = { items: [], mcp: [], plugins: false };
  const scriptsOnly = { repo: "ada/app", vars: [], files: [], scripts: true };
  assert.equal(environmentPickSecrets(scriptsOnly), false);
  assert.equal(configPickSecrets({ ...none, items: ["claude-md"], plugins: true }), false);
  assert.equal(environmentPickSecrets({ ...scriptsOnly, vars: ["APP_TOKEN"] }), true);
  assert.equal(environmentPickSecrets({ ...scriptsOnly, files: ["api/.env"] }), true);
  assert.equal(configPickSecrets({ ...none, mcp: ["tracker"] }), true);
  // Still something to import, though it needs no agreement.
  assert.equal(hasEnvironmentPick(scriptsOnly), true);
  assert.equal(hasEnvironmentPick({ ...scriptsOnly, scripts: false }), false);
  assert.equal(hasConfigPick({ ...none, plugins: true }), true);
  assert.equal(hasConfigPick(none), false);
});
