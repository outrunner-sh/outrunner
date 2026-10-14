import assert from "node:assert/strict";
import { test } from "node:test";

import type { HandoffManifest } from "@/lib/runtime/agent-protocol";
import {
  handoffPath,
  HandoffUnavailableError,
  type HandoffStorage,
  isHandoffId,
  loadHandoff,
  mintHandoffUploads,
  removeHandoff,
} from "@/lib/runtime/handoff/storage";
import { continueInCloud, continueInCloudBlocker } from "@/lib/session/continue-in-cloud";

const OWNER = "0b6f2c1e-4d7a-4f3b-9a1c-2e5d8f7a6b4c";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const HANDOFF = "3c2b1a0f-9e8d-4c7b-a6f5-e4d3c2b1a0f9";

function fakeStorage(objects: Record<string, string> = {}) {
  const removed: string[][] = [];
  const storage: HandoffStorage = {
    createSignedUploadUrl: async (path) => ({ signedUrl: `https://store.test/up/${path}`, token: "t", path }),
    createSignedDownloadUrl: async (path) => ({ signedUrl: `https://store.test/down/${path}` }),
    readText: async (path) => objects[path] ?? null,
    remove: async (paths) => {
      removed.push(paths);
    },
  };
  return { storage, removed };
}

const manifest: HandoffManifest = {
  version: 1,
  from: "local",
  title: "Fix the login",
  baseBranch: "main",
  head: "a".repeat(40),
  worktree: "/Users/ada/.outrunner/workspaces/ws-1",
  claudeSessionId: "11111111-2222-4333-8444-555555555555",
  bundle: { sha256: `sha256:${"b".repeat(64)}`, size: 10 },
  patch: { sha256: `sha256:${"c".repeat(64)}`, size: 0 },
  conversation: { sha256: `sha256:${"d".repeat(64)}`, size: 99 },
};

test("a package lives under its owner, by ids the server made", () => {
  assert.equal(handoffPath(OWNER, HANDOFF, "manifest"), `handoffs/${OWNER}/${HANDOFF}/handoff.json`);
  assert.throws(() => handoffPath(OWNER, "../other", "patch"));
  assert.throws(() => handoffPath("someone/else", HANDOFF, "patch"));
  assert.equal(isHandoffId(HANDOFF), true);
  assert.equal(isHandoffId(`${HANDOFF}/../x`), false);
  assert.equal(isHandoffId(42), false);
});

test("uploads are signed for every file a package can hold, all in the owner's folder", async () => {
  const { storage } = fakeStorage();
  const uploads = await mintHandoffUploads(storage, OWNER, HANDOFF);
  assert.deepEqual(
    uploads.map((u) => u.artifact),
    ["bundle", "patch", "conversation", "manifest"],
  );
  for (const upload of uploads) assert.ok(upload.url.includes(`/handoffs/${OWNER}/${HANDOFF}/`), upload.url);
});

test("a finished package gives its manifest and downloads for just the files it holds", async () => {
  const path = `handoffs/${OWNER}/${HANDOFF}/handoff.json`;
  const { storage } = fakeStorage({ [path]: JSON.stringify(manifest) });
  const loaded = await loadHandoff(storage, OWNER, HANDOFF);
  assert.equal(loaded.manifest.title, "Fix the login");
  assert.deepEqual(loaded.downloads.map((d) => d.artifact).sort(), ["bundle", "conversation", "patch"]);

  const fresh = { ...manifest, bundle: null, conversation: null, claudeSessionId: null };
  const { storage: freshStorage } = fakeStorage({ [path]: JSON.stringify(fresh) });
  const loadedFresh = await loadHandoff(freshStorage, OWNER, HANDOFF);
  assert.deepEqual(loadedFresh.downloads.map((d) => d.artifact), ["patch"]);
});

test("a package that isn't there, or can't be read, is unavailable", async () => {
  await assert.rejects(loadHandoff(fakeStorage().storage, OWNER, HANDOFF), HandoffUnavailableError);
  // Another user's package is never found: its path is under them.
  const theirs = fakeStorage({ [`handoffs/${OTHER}/${HANDOFF}/handoff.json`]: JSON.stringify(manifest) });
  await assert.rejects(loadHandoff(theirs.storage, OWNER, HANDOFF), HandoffUnavailableError);
  const garbled = fakeStorage({ [`handoffs/${OWNER}/${HANDOFF}/handoff.json`]: '{"version":2}' });
  await assert.rejects(loadHandoff(garbled.storage, OWNER, HANDOFF), HandoffUnavailableError);
});

test("removing a package removes every file it could hold", async () => {
  const { storage, removed } = fakeStorage();
  await removeHandoff(storage, OWNER, HANDOFF);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].length, 4);
  for (const path of removed[0]) assert.ok(path.startsWith(`handoffs/${OWNER}/${HANDOFF}/`));
});

test("only a git session on a GitHub repository can continue in the cloud", () => {
  assert.match(continueInCloudBlocker({ inPlace: true, repo: "acme/app" }) ?? "", /in place/);
  assert.match(continueInCloudBlocker({ inPlace: false }) ?? "", /GitHub/);
  assert.equal(continueInCloudBlocker({ inPlace: false, repo: "acme/app" }), null);
});

type Call = { url: string; method: string; body: unknown };

function fakeServer(responses: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = responses[`${method} ${url}`] ?? { status: 204, body: null };
    return new Response(answer.body === null ? null : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { fetcher, calls };
}

const uploads = [{ artifact: "manifest" as const, url: "https://store.test/up/m" }];

test("continuing packs the session to the signed URLs, then starts the cloud session from the package", async () => {
  const { fetcher, calls } = fakeServer({
    "POST /api/handoffs": { status: 200, body: { handoffId: HANDOFF, projectId: "p-1", uploads } },
    "POST /api/projects/p-1/workspaces": { status: 201, body: { workspace: { id: "ws-cloud" } } },
  });
  const exported: unknown[] = [];
  const steps: string[] = [];
  const id = await continueInCloud({ repo: "acme/app", title: "Fix the login" }, true, {
    fetch: fetcher,
    exportSession: async (body) => {
      exported.push(body);
    },
    onStep: (step) => steps.push(step),
  });
  assert.equal(id, "ws-cloud");
  assert.deepEqual(steps, ["packing", "starting"]);
  assert.deepEqual(calls[0], { url: "/api/handoffs", method: "POST", body: { repo: "acme/app" } });
  assert.deepEqual(exported, [{ withChat: true, title: "Fix the login", uploads }]);
  assert.deepEqual(calls[1].body, { branch: "", continueFrom: { handoffId: HANDOFF } });
});

test("a pack that fails throws the package away and says why", async () => {
  const { fetcher, calls } = fakeServer({
    "POST /api/handoffs": { status: 200, body: { handoffId: HANDOFF, projectId: "p-1", uploads } },
  });
  await assert.rejects(
    continueInCloud({ repo: "acme/app", title: "t" }, false, {
      fetch: fetcher,
      exportSession: async () => {
        throw new Error("Claude is still working: wait for it to finish, then try again");
      },
    }),
    /still working/,
  );
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url === `/api/handoffs/${HANDOFF}`));
  assert.ok(!calls.some((c) => c.url.includes("/workspaces")), "no cloud session was started");
});

test("a cloud session the server won't start throws the package away too", async () => {
  const { fetcher, calls } = fakeServer({
    "POST /api/handoffs": { status: 200, body: { handoffId: HANDOFF, projectId: "p-1", uploads } },
    "POST /api/projects/p-1/workspaces": { status: 409, body: { error: "Connect Claude in Settings before creating a workspace." } },
  });
  await assert.rejects(
    continueInCloud({ repo: "acme/app", title: "t" }, true, { fetch: fetcher, exportSession: async () => {} }),
    /Connect Claude/,
  );
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url === `/api/handoffs/${HANDOFF}`));
});

test("the server's own reason reaches the user", async () => {
  const { fetcher } = fakeServer({
    "POST /api/handoffs": { status: 404, body: { error: "Your GitHub account can't reach acme/app, so the cloud can't clone it." } },
  });
  await assert.rejects(
    continueInCloud({ repo: "acme/app", title: "t" }, true, { fetch: fetcher, exportSession: async () => {} }),
    /can't reach acme\/app/,
  );
});
