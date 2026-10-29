import assert from "node:assert/strict";
import { test } from "node:test";

import { CloudLimitError, UPGRADE_HREF } from "@/lib/billing/limits";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { saveForArchive, type ArchiveSaveDeps } from "@/lib/session/archive-save";
import { MissingBoxProjectError } from "@/lib/session/box-failure";

const manifest = { sessionId: "s-1" } as unknown as SnapshotManifest;

/** A box that brings back, connects and captures as told, recording what
 *  it was asked. */
function box(fail: { bringBack?: unknown; connect?: unknown; capture?: unknown } = {}) {
  const asked: string[] = [];
  const step = <T>(name: string, value: T) => async () => {
    asked.push(name);
    if (name in fail) throw fail[name as keyof typeof fail];
    return value;
  };
  const deps: ArchiveSaveDeps<string> = {
    bringBack: step("bringBack", undefined),
    waitToRetry: step("wait", undefined),
    connect: step("connect", "agent"),
    capture: step("capture", manifest),
  };
  return { deps, asked };
}

test("a box that's up, or brought back, has its work saved", async () => {
  const { deps, asked } = box();
  assert.deepEqual(await saveForArchive(deps), { saved: true, manifest });
  assert.deepEqual(asked, ["bringBack", "connect", "capture"]);
});

test("a box that didn't come back is tried once more, then archived without its work, never kept from it", async () => {
  // Daytona couldn't start it (deleted, or broken), twice.
  const unstarted = new Error("failed to resolve container IP after 3 attempts");
  const twice = box({ bringBack: unstarted });
  assert.deepEqual(await saveForArchive(twice.deps), { saved: false, cause: unstarted });
  assert.deepEqual(twice.asked, ["bringBack", "wait", "bringBack"]);
  // A box that came back on the second try has its work saved.
  const once = box();
  let tries = 0;
  const bringBack = once.deps.bringBack;
  once.deps.bringBack = async () => {
    if (tries++ === 0) throw new Error("sandbox not found, it may have been deleted or stopped");
    return bringBack();
  };
  assert.deepEqual(await saveForArchive(once.deps), { saved: true, manifest });
  assert.equal(once.asked[0], "wait", "the retry lets the provider settle first");
  // No computer left to reach.
  assert.equal((await saveForArchive(box({ connect: new Error("Runtime Computer is not available.") }).deps)).saved, false);
  // A box started in place of a deleted one has no record of the session.
  const unknown = new AgentRequestError(404, { code: "NOT_FOUND", message: "unknown workspace" });
  assert.equal((await saveForArchive(box({ capture: unknown }).deps)).saved, false);
  // Its agent never answered, even redeployed.
  assert.equal((await saveForArchive(box({ capture: new DOMException("timed out", "TimeoutError") }).deps)).saved, false);
});

test("a reachable agent's capture or upload error leaves the session available to retry", async () => {
  for (const error of [
    new AgentRequestError(500, { code: "INTERNAL", message: "upload failed: storage unavailable" }),
    new AgentRequestError(500, { code: "INTERNAL", message: "tar failed" }),
    new AgentRequestError(404),
    new AgentRequestError(404, { code: "NOT_FOUND", message: "artifact not found" }),
    new AgentRequestError(403, { code: "UNAUTHORIZED", message: "unauthorized" }),
    new Error("invalid Snapshot manifest"),
  ]) {
    await assert.rejects(saveForArchive(box({ capture: error }).deps), (caught) => caught === error);
  }
});

test("a transport failure after agent recovery can still be archived explicitly without files", async () => {
  for (const error of [new TypeError("fetch failed"), new DOMException("aborted", "AbortError")]) {
    assert.deepEqual(await saveForArchive(box({ capture: error }).deps), { saved: false, cause: error });
  }
});

test("automatic archive requires a Snapshot, even if the box is unreachable or deleted", async () => {
  for (const fail of [
    { bringBack: new Error("box unavailable") },
    { connect: new Error("Runtime Computer is not available.") },
    { capture: new AgentRequestError(404, { code: "NOT_FOUND", message: "unknown workspace" }) },
    { capture: new DOMException("timed out", "TimeoutError") },
  ]) {
    await assert.rejects(saveForArchive(box(fail).deps, { requireSnapshot: true }));
  }
  assert.deepEqual(await saveForArchive(box().deps, { requireSnapshot: true }), { saved: true, manifest });
});

test("the plan refusing the box's start, or a box too old to archive, stop the archive: its files are there to save", async () => {
  const denial = { error: "Your plan's cloud hours are used up.", settingsHref: UPGRADE_HREF } as const;
  const limited = box({ bringBack: new CloudLimitError(denial) });
  await assert.rejects(saveForArchive(limited.deps), CloudLimitError);
  assert.deepEqual(limited.asked, ["bringBack"], "a plan's refusal isn't asked again");
  const capped = Object.assign(new Error("Your plan runs 1 box at a time."), { code: "P4BX1" });
  await assert.rejects(saveForArchive(box({ bringBack: capped }).deps), /1 box at a time/);
  const old = new OutdatedComputerError("This box's agent is too old to archive a session of several repositories.");
  await assert.rejects(saveForArchive(box({ capture: old }).deps), OutdatedComputerError);
  const missing = box({ bringBack: new MissingBoxProjectError("project-1") });
  await assert.rejects(saveForArchive(missing.deps), MissingBoxProjectError);
  assert.deepEqual(missing.asked, ["bringBack"]);
});
