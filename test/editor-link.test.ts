import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Sandbox } from "@daytonaio/sdk";

import { EDITOR_LINK_TTL_SECONDS, keepEditorLink } from "@/lib/runtime/editor-link";
import { box } from "@/lib/runtime/sandbox/daytona";
import type { BrowserLink } from "@/lib/runtime/sandbox/backend";

/** A Daytona sandbox that records its signed links and the ones ended. Each
 *  link gets a token of its own, as Daytona's do. */
function linkSandbox(): { sandbox: Sandbox; log: string[] } {
  const log: string[] = [];
  let seq = 0;
  const sandbox = {
    id: "box-1",
    getSignedPreviewUrl: async (port: number, ttl: number) => {
      seq += 1;
      log.push(`signed ${port} ${ttl}`);
      return { url: `https://${port}-tok${seq}.daytonaproxy01.net`, token: `tok${seq}`, port };
    },
    expireSignedPreviewUrl: async (port: number, token: string) => {
      log.push(`expired ${port} ${token}`);
    },
  } as unknown as Sandbox;
  return { sandbox, log };
}

/** A link that records when it's ended, as a provider's would. */
function link(url: string): BrowserLink & { ended: string[] } {
  const ended: string[] = [];
  return { url, ended, revoke: async () => void ended.push(url) };
}

test("a Daytona box's browser link carries its URL, and ends at its own token", async () => {
  const { sandbox, log } = linkSandbox();
  const browser = box(sandbox).browserUrl;
  assert.ok(browser);
  const first = await browser(13338, 60);
  assert.equal(first.url, "https://13338-tok1.daytonaproxy01.net");
  assert.deepEqual(log, ["signed 13338 60"]);
  await first.revoke();
  assert.deepEqual(log, ["signed 13338 60", "expired 13338 tok1"]);
  // A second link has a token of its own: ending it leaves the first's.
  const second = await browser(13338, 60);
  await second.revoke();
  assert.deepEqual(log.slice(-1), ["expired 13338 tok2"]);
});

test("a session's new editor link ends the last one", async () => {
  const first = link("https://first");
  const second = link("https://second");
  await keepEditorLink("editor-links-1", first);
  assert.deepEqual(first.ended, [], "the first is still good until a newer one");
  await keepEditorLink("editor-links-1", second);
  assert.deepEqual(first.ended, ["https://first"]);
  assert.deepEqual(second.ended, [], "the new one is what the editor opens with");
});

test("one session's mint doesn't end another's link", async () => {
  const mine = link("https://mine");
  const theirs = link("https://theirs");
  await keepEditorLink("editor-links-2", mine);
  await keepEditorLink("editor-links-3", theirs);
  assert.deepEqual([mine.ended, theirs.ended], [[], []]);
});

test("keeping the same link again ends nothing", async () => {
  const same = link("https://same");
  await keepEditorLink("editor-links-4", same);
  await keepEditorLink("editor-links-4", same);
  assert.deepEqual(same.ended, []);
});

test("a revoke that fails is logged, not raised: the new link is what matters", async () => {
  const errors = mock.method(console, "error", () => {});
  try {
    const gone: BrowserLink = {
      url: "https://gone",
      revoke: () => Promise.reject(new Error("box gone")),
    };
    await keepEditorLink("editor-links-5", gone);
    await keepEditorLink("editor-links-5", link("https://next"));
    assert.equal(errors.mock.callCount(), 1);
  } finally {
    errors.mock.restore();
  }
});

test("an editor link is good for half an hour, not a working day", () => {
  assert.equal(EDITOR_LINK_TTL_SECONDS, 30 * 60);
});