import assert from "node:assert/strict";
import { test } from "node:test";

import { listedSessions, rememberListedSessions } from "@/lib/session/listed-sessions";
import {
  ARCHIVE_NOTICE,
  archiveInBackground,
  archiveWithUndo,
  dismissArchiveNotice,
  PENDING_ARCHIVE,
  sendPendingArchive,
  UNDO_MS,
  undoArchive,
} from "@/lib/session/optimistic-archive";
import type { SessionListEntry } from "@/lib/session/session-list";

const session = { id: "archive-probe", title: "Work to keep" };
const seed = () => {
  dismissArchiveNotice();
  rememberListedSessions([{ ...session, status: "ready" } as SessionListEntry]);
};

test("a background archive keeps the unsaved-files warning after it completes", async (t) => {
  seed();
  let answer!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { answer = resolve; });
  t.mock.method(globalThis, "fetch", () => response);
  const finished = archiveInBackground(session);
  // The screen is free to move on before the server answers.
  assert.equal(listedSessions()?.sessions[0].status, "archiving");
  assert.equal(ARCHIVE_NOTICE.get(), null);
  const note = "Archived without its files: its box couldn't be reached.";
  answer(new Response(JSON.stringify({ note }), { status: 200 }));
  await finished;
  assert.equal(listedSessions()?.sessions[0].status, "archived");
  assert.deepEqual(ARCHIVE_NOTICE.get(), { ...session, message: note, kind: "unsaved" });
  dismissArchiveNotice();
  assert.equal(ARCHIVE_NOTICE.get(), null);
});

test("a saved background archive needs no notice; a refusal still says why and invalidates the list", async (t) => {
  seed();
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  await archiveInBackground(session);
  assert.equal(listedSessions()?.sessions[0].status, "archived");
  assert.equal(ARCHIVE_NOTICE.get(), null);

  seed();
  const message = "The snapshot could not be saved. Try again.";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: message }), { status: 500 }));
  await archiveInBackground(session);
  assert.equal(listedSessions()?.at, 0);
  assert.deepEqual(ARCHIVE_NOTICE.get(), { ...session, message, kind: "error" });
  dismissArchiveNotice();
});

test("Undo takes an archive back before anything is sent", (t) => {
  seed();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  archiveWithUndo(session);
  // Out of the lists at once, nothing asked yet.
  assert.equal(listedSessions()?.sessions[0].status, "archiving");
  assert.equal(PENDING_ARCHIVE.get()?.id, session.id);
  assert.deepEqual(undoArchive(), { ...session, listed: "ready", returnTo: null });
  assert.equal(listedSessions()?.sessions[0].status, "ready");
  assert.equal(PENDING_ARCHIVE.get(), null);
  // Its moment passing sends nothing: it was taken back.
  t.mock.timers.tick(UNDO_MS);
  assert.equal(fetch.mock.callCount(), 0);
  // Already taken back, Undo again does nothing.
  assert.equal(undoArchive(), null);
});

test("an archive not undone is sent once its moment passes; archiving another sends the one waiting", async (t) => {
  seed();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    bodies.push(url);
    return new Response("{}", { status: 200 });
  });
  archiveWithUndo(session);
  // A second click on the same row asks nothing more.
  archiveWithUndo(session);
  assert.equal(bodies.length, 0);
  t.mock.timers.tick(UNDO_MS);
  assert.deepEqual(bodies, [`/api/workspaces/${session.id}/lifecycle`]);
  assert.equal(PENDING_ARCHIVE.get(), null);
  await Promise.resolve();

  archiveWithUndo({ id: "first", title: "First" });
  archiveWithUndo({ id: "second", title: "Second" });
  // Only the latest can be undone: the first went at once.
  assert.deepEqual(bodies.slice(1), ["/api/workspaces/first/lifecycle"]);
  assert.equal(PENDING_ARCHIVE.get()?.id, "second");
  await sendPendingArchive();
  assert.deepEqual(bodies.slice(1), ["/api/workspaces/first/lifecycle", "/api/workspaces/second/lifecycle"]);
});
