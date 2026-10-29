import assert from "node:assert/strict";
import { test } from "node:test";

import { signInRedirect } from "@/lib/auth/sign-in-redirect";
import { mediaRequestSignature, mediaRequestValid } from "@/lib/media/box-auth";
import { type BoxComputer, type BoxUploadDeps, finishUpload, type PendingMedia, startUpload } from "@/lib/media/box-uploads";
import {
  cleanMediaName,
  MAX_MEDIA_BYTES,
  mediaMarkdown,
  parseUploadRequest,
  publicIdFromFile,
  publicMediaPath,
  sniffMediaType,
} from "@/lib/media/media";

const PUBLIC_ID = "a".repeat(43);
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const MEDIA_ID = "33333333-3333-4333-8333-333333333333";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const bytes = (text: string) => new TextEncoder().encode(text);

test("files are told apart by their first bytes, not their name", () => {
  assert.equal(sniffMediaType(PNG), "image/png");
  assert.equal(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMediaType(bytes("GIF89a......")), "image/gif");
  assert.equal(sniffMediaType(bytes("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffMediaType(bytes("\0\0\0\x20ftypisom")), "video/mp4");
  assert.equal(sniffMediaType(bytes("<svg xmlns=")), null);
  assert.equal(sniffMediaType(bytes("<html><script>")), null);
  assert.equal(sniffMediaType(new Uint8Array()), null);
});

test("a link ends in its type's extension, and only the id is read back", () => {
  assert.equal(publicMediaPath(PUBLIC_ID, "image/gif"), `/m/${PUBLIC_ID}.gif`);
  assert.equal(publicIdFromFile(`${PUBLIC_ID}.gif`), PUBLIC_ID);
  assert.equal(publicIdFromFile(`${PUBLIC_ID}.png`), PUBLIC_ID);
  assert.equal(publicIdFromFile(PUBLIC_ID), PUBLIC_ID);
  assert.equal(publicIdFromFile("short.gif"), null);
  assert.equal(publicIdFromFile(`${PUBLIC_ID}x.gif`), null);
});

test("a name can't break out of the markdown's alt text", () => {
  assert.equal(cleanMediaName("Before: [old] page\n"), "Before: old page");
  assert.equal(cleanMediaName("  "), "Screenshot");
  assert.equal(cleanMediaName(undefined, "after.gif"), "after.gif");
  assert.equal(cleanMediaName("x".repeat(300)).length, 200);
  assert.equal(mediaMarkdown("After] (evil)", "https://app/m/x.png"), "![After (evil)](https://app/m/x.png)");
});

test("an upload request names its session, an allowed type and a size within the cap", () => {
  const ok = { workspaceId: SESSION, name: "After", contentType: "image/gif", sizeBytes: 1000 };
  assert.deepEqual(parseUploadRequest(ok), { ...ok, access: "public" });
  assert.ok("error" in parseUploadRequest({ ...ok, access: "friends" }));
  assert.ok("error" in parseUploadRequest({ ...ok, workspaceId: "nope" }));
  assert.ok("error" in parseUploadRequest({ ...ok, contentType: "image/svg+xml" }));
  assert.ok("error" in parseUploadRequest({ ...ok, contentType: "text/html" }));
  assert.ok("error" in parseUploadRequest({ ...ok, sizeBytes: 0 }));
  assert.ok("error" in parseUploadRequest({ ...ok, sizeBytes: 1.5 }));
  assert.ok("error" in parseUploadRequest({ ...ok, sizeBytes: MAX_MEDIA_BYTES + 1 }));
});

test("a video's link is private unless uploaded as public; an image's is public", () => {
  const video = { workspaceId: SESSION, name: "Walkthrough", contentType: "video/mp4", sizeBytes: 1000 };
  assert.equal((parseUploadRequest(video) as { access: string }).access, "private");
  assert.equal((parseUploadRequest({ ...video, access: "public" }) as { access: string }).access, "public");
  const image = { ...video, contentType: "image/png" };
  assert.equal((parseUploadRequest(image) as { access: string }).access, "public");
  assert.equal((parseUploadRequest({ ...image, access: "private" }) as { access: string }).access, "private");
  // GitHub doesn't play a video from a link: it's a link, not an image.
  assert.equal(mediaMarkdown("Walkthrough", "https://app/m/x.mp4", "video/mp4"), "[Walkthrough](https://app/m/x.mp4)");
});

test("a signature is for one purpose, one sandbox and one body, and only recently", () => {
  const now = 1_800_000_000;
  const body = JSON.stringify({ workspaceId: SESSION });
  const signed = {
    sandboxId: "sb-1",
    timestamp: String(now),
    signature: mediaRequestSignature("secret", "media-upload", "sb-1", String(now), body),
    body,
  };
  assert.equal(mediaRequestValid("secret", "media-upload", signed, now), true);
  assert.equal(mediaRequestValid("secret", "media-complete", signed, now), false);
  assert.equal(mediaRequestValid("other", "media-upload", signed, now), false);
  assert.equal(mediaRequestValid("secret", "media-upload", { ...signed, sandboxId: "sb-2" }, now), false);
  assert.equal(mediaRequestValid("secret", "media-upload", { ...signed, body: "{}" }, now), false);
  assert.equal(mediaRequestValid("secret", "media-upload", signed, now + 301), false);
  assert.equal(mediaRequestValid("secret", "media-upload", { ...signed, signature: null }, now), false);
});

test("the agent signs as the control plane checks (runtime-agent/internal/media's Sign)", () => {
  assert.equal(
    mediaRequestSignature("secret", "media-upload", "sb-1", "1800000000", '{"workspaceId":"w"}'),
    "sha256=f7cad8db0fa8de3b5ff54f9ed50ee5282207ac63b825b9dca2b534f0c405d962",
  );
});

test("the media links are public, signed out", () => {
  const at = (pathname: string) => signInRedirect({ method: "GET", pathname, search: "", signedIn: false });
  assert.equal(at(`/m/${PUBLIC_ID}.gif`), null);
  assert.notEqual(at("/media/some-id"), null);
  assert.notEqual(at("/mine"), null);
});

/** A box with one session, its uploads kept in memory. */
function fakeBox(overrides: Partial<BoxUploadDeps> = {}, computer: Partial<BoxComputer> = {}) {
  const rows = new Map<string, PendingMedia>();
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const deps: BoxUploadDeps = {
    computersFor: async (sandboxId) =>
      sandboxId === "sb-1"
        ? [{ ownerId: "u1", orgId: "o1", projectId: "p1", workspaceId: SESSION, agentSecret: "secret", ...computer }]
        : [],
    session: async (id) =>
      id === SESSION
        ? { id, ownerId: "u1", orgId: "o1", projectId: "p1" }
        : id === OTHER_SESSION
          ? { id, ownerId: "u1", orgId: "o1", projectId: "p1" }
          : null,
    isMember: async () => true,
    allowed: () => true,
    sweep: async () => {
      calls.push("sweep");
    },
    reserve: async (row) => {
      rows.set(row.id, { ...row, status: "pending" });
      return null;
    },
    signUpload: async (path) => `https://storage.example/upload/${path}?token=t`,
    media: async (id) => rows.get(id) ?? null,
    stored: async (path) => {
      const data = objects.get(path);
      return data ? { size: data.length, head: data.subarray(0, 16) } : null;
    },
    markReady: async (id) => {
      rows.get(id)!.status = "ready";
    },
    discard: async (media) => {
      rows.delete(media.id);
      objects.delete(media.storagePath);
      calls.push("discard");
    },
    newId: () => MEDIA_ID,
    newPublicId: () => PUBLIC_ID,
    url: (path) => `https://app.example${path}`,
    ...overrides,
  };
  return { deps, rows, objects, calls };
}

function signed(purpose: "media-upload" | "media-complete", body: unknown, secret = "secret") {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    sandboxId: "sb-1",
    timestamp,
    signature: mediaRequestSignature(secret, purpose, "sb-1", timestamp, text),
    body: text,
  };
}

const ASK = { workspaceId: SESSION, name: "After: the new page", contentType: "image/png", sizeBytes: PNG.length };

test("an upload is reserved, put in storage, checked, and then has its link", async () => {
  const { deps, rows, objects, calls } = fakeBox();
  const started = await startUpload(deps, signed("media-upload", ASK));
  assert.equal(started.status, 201);
  assert.equal(started.body.id, MEDIA_ID);
  assert.equal(started.body.uploadUrl, `https://storage.example/upload/o1/${MEDIA_ID}?token=t`);
  assert.deepEqual(calls, ["sweep"]);
  assert.equal(rows.get(MEDIA_ID)?.status, "pending");
  assert.equal(rows.get(MEDIA_ID)?.ownerId, "u1");
  assert.equal(rows.get(MEDIA_ID)?.orgId, "o1");
  assert.equal(rows.get(MEDIA_ID)?.access, "public");

  // Not there yet: nothing goes live.
  const early = await finishUpload(deps, signed("media-complete", { workspaceId: SESSION, id: MEDIA_ID }));
  assert.equal(early.status, 409);

  objects.set(`o1/${MEDIA_ID}`, PNG);
  const done = await finishUpload(deps, signed("media-complete", { workspaceId: SESSION, id: MEDIA_ID }));
  assert.equal(done.status, 200);
  assert.equal(done.body.url, `https://app.example/m/${PUBLIC_ID}.png`);
  assert.equal(done.body.pageUrl, `https://app.example/media/${MEDIA_ID}`);
  assert.equal(done.body.markdown, `![After: the new page](https://app.example/m/${PUBLIC_ID}.png)`);
  assert.equal(rows.get(MEDIA_ID)?.status, "ready");

  // Asked again (a retry after a lost answer): the same link.
  const again = await finishUpload(deps, signed("media-complete", { workspaceId: SESSION, id: MEDIA_ID }));
  assert.equal(again.body.url, done.body.url);
});

test("bytes that aren't what was asked for are thrown away", async () => {
  const { deps, rows, objects, calls } = fakeBox();
  await startUpload(deps, signed("media-upload", ASK));
  objects.set(`o1/${MEDIA_ID}`, bytes("<html><script>alert(1)</script>").subarray(0, PNG.length));
  const done = await finishUpload(deps, signed("media-complete", { workspaceId: SESSION, id: MEDIA_ID }));
  assert.equal(done.status, 422);
  assert.equal(rows.size, 0);
  assert.ok(calls.includes("discard"));
});

test("a box can't upload for a session that isn't on it, or with another box's secret", async () => {
  const { deps } = fakeBox();
  assert.equal((await startUpload(deps, signed("media-upload", ASK, "wrong"))).status, 401);
  assert.equal((await startUpload(deps, { ...signed("media-upload", ASK), sandboxId: "sb-2" })).status, 401);
  assert.equal((await startUpload(deps, signed("media-upload", { ...ASK, workspaceId: OTHER_SESSION }))).status, 404);
  // A signature for the last step doesn't start one.
  assert.equal((await startUpload(deps, signed("media-complete", ASK))).status, 401);
});

test("a project's shared box uploads for any of the project's sessions", async () => {
  const { deps } = fakeBox({}, { workspaceId: null });
  assert.equal((await startUpload(deps, signed("media-upload", { ...ASK, workspaceId: OTHER_SESSION }))).status, 201);
});

test("one session's upload can't be finished by another's", async () => {
  const { deps, objects } = fakeBox({}, { workspaceId: null });
  await startUpload(deps, signed("media-upload", ASK));
  objects.set(`o1/${MEDIA_ID}`, PNG);
  const done = await finishUpload(deps, signed("media-complete", { workspaceId: OTHER_SESSION, id: MEDIA_ID }));
  assert.equal(done.status, 404);
});

test("an org over its caps, or uploading too fast, is told why", async () => {
  const daily = fakeBox({ reserve: async () => "daily" });
  const capped = await startUpload(daily.deps, signed("media-upload", ASK));
  assert.equal(capped.status, 429);
  assert.match(String(capped.body.error), /last day/);

  const storage = fakeBox({ reserve: async () => "storage" });
  assert.match(String((await startUpload(storage.deps, signed("media-upload", ASK))).body.error), /GB limit/);

  const fast = fakeBox({ allowed: () => false });
  assert.equal((await startUpload(fast.deps, signed("media-upload", ASK))).status, 429);
});

test("a member who left the org can't upload", async () => {
  const { deps } = fakeBox({ isMember: async () => false });
  assert.equal((await startUpload(deps, signed("media-upload", ASK))).status, 403);
});

test("a sweep that fails doesn't stop the upload", async () => {
  const { deps } = fakeBox({
    sweep: async () => {
      throw new Error("db down");
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await startUpload(deps, signed("media-upload", ASK))).status, 201);
  } finally {
    console.warn = warn;
  }
});
