import assert from "node:assert/strict";
import { test } from "node:test";

import {
  firstPromptCutOff,
  firstPromptFromUrl,
  firstPromptQuery,
  forgetFirstPrompt,
  handOverFirstPrompt,
  keepFirstPromptFromUrl,
  markFirstPromptGoing,
  newFirstPrompt,
  rememberedFirstPrompt,
  rememberFirstPrompt,
  sendFirstPromptOnce,
  withoutFirstPrompt,
} from "@/lib/session/first-prompt";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const refusing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

test("the session page's query carries the trimmed prompt and every attachment", () => {
  assert.equal(firstPromptQuery({ prompt: "  fix the build \n", attachmentIds: [] }), "?prompt=fix+the+build");
  assert.equal(firstPromptQuery({ prompt: "", attachmentIds: ["a", "b"] }), "?attachment=a&attachment=b");
  assert.equal(firstPromptQuery({ prompt: "   ", attachmentIds: [] }), "");
});

test("once sent, the first prompt leaves the URL, attachments too, and nothing else does", () => {
  const url = new URL("https://app.test/workspaces/w1?prompt=hi&attachment=a&attachment=b&tab=env#end");
  assert.equal(withoutFirstPrompt(url), "/workspaces/w1?tab=env#end");
  assert.equal(withoutFirstPrompt(new URL("https://app.test/workspaces/w1?prompt=hi")), "/workspaces/w1");
});

test("a kept first prompt waits for its session alone, until forgotten", () => {
  const storage = memoryStorage();
  rememberFirstPrompt(storage, "w1", { prompt: " hello ", attachmentIds: ["a"] });
  assert.deepEqual(rememberedFirstPrompt(storage, "w1"), { prompt: "hello", attachmentIds: ["a"] });
  assert.equal(rememberedFirstPrompt(storage, "w2"), null);
  forgetFirstPrompt(storage, "w1");
  assert.equal(rememberedFirstPrompt(storage, "w1"), null);
});

test("nothing to send keeps nothing", () => {
  const storage = memoryStorage();
  rememberFirstPrompt(storage, "w1", { prompt: "  ", attachmentIds: [] });
  assert.equal(storage.items.size, 0);
});

test("a kept copy that can't be read sends nothing", () => {
  const storage = memoryStorage();
  storage.setItem("outrunner:first-prompt:w1", "{not json");
  assert.equal(rememberedFirstPrompt(storage, "w1"), null);
  storage.setItem("outrunner:first-prompt:w1", JSON.stringify({ prompt: 3, attachmentIds: [1, "a"] }));
  assert.deepEqual(rememberedFirstPrompt(storage, "w1"), { prompt: "", attachmentIds: ["a"] });
  storage.setItem("outrunner:first-prompt:w1", JSON.stringify({ prompt: "", attachmentIds: [] }));
  assert.equal(rememberedFirstPrompt(storage, "w1"), null);
});

test("storage refusing, or missing outright, never breaks creating or opening a session", () => {
  for (const storage of [refusing, null]) {
    assert.doesNotThrow(() => rememberFirstPrompt(storage, "w1", { prompt: "hi", attachmentIds: [] }));
    assert.equal(rememberedFirstPrompt(storage, "w1"), null);
    assert.doesNotThrow(() => forgetFirstPrompt(storage, "w1"));
  }
});

test("start over hands the waiting prompt to the fresh session, and only to it", () => {
  const storage = memoryStorage();
  rememberFirstPrompt(storage, "old", { prompt: "fix the build", attachmentIds: ["a"] });
  assert.deepEqual(handOverFirstPrompt(storage, "old", "new"), { prompt: "fix the build", attachmentIds: ["a"] });
  assert.equal(rememberedFirstPrompt(storage, "old"), null);
  assert.deepEqual(rememberedFirstPrompt(storage, "new"), { prompt: "fix the build", attachmentIds: ["a"] });
});

test("a prompt only in the URL is read back from it, for a tab without the kept copy", () => {
  const url = new URL("https://outrunner.test/workspaces/ws-1?prompt=fix+it&attachment=a1&attachment=a2");
  assert.deepEqual(firstPromptFromUrl(url), { prompt: "fix it", attachmentIds: ["a1", "a2"] });
  assert.equal(firstPromptFromUrl(new URL("https://outrunner.test/workspaces/ws-1")), null);
});

test("a prompt the URL carries moves into the kept copy, and out of the URL", () => {
  const storage = memoryStorage();
  const url = new URL("https://outrunner.test/workspaces/ws-1?prompt=fix+it&attachment=a1&tab=env");
  assert.equal(keepFirstPromptFromUrl(storage, "ws-1", url), "/workspaces/ws-1?tab=env");
  // A reload of that page sends it from the copy, once.
  assert.deepEqual(rememberedFirstPrompt(storage, "ws-1"), { prompt: "fix it", attachmentIds: ["a1"] });
});

test("with nothing in the URL, nothing is kept and the URL stays", () => {
  const storage = memoryStorage();
  assert.equal(keepFirstPromptFromUrl(storage, "ws-1", new URL("https://outrunner.test/workspaces/ws-1?tab=env")), null);
  assert.equal(storage.items.size, 0);
});

test("storage refusing, or missing outright, leaves the prompt in the URL until it goes", () => {
  const url = new URL("https://outrunner.test/workspaces/ws-1?prompt=fix+it");
  for (const storage of [refusing, null]) {
    assert.equal(keepFirstPromptFromUrl(storage, "ws-1", url), null);
  }
});

test("a send a reload cut off is let go, and one that failed waits to go again", () => {
  const storage = memoryStorage();
  rememberFirstPrompt(storage, "cut-1", { prompt: "fix it", attachmentIds: ["a"] });
  assert.equal(firstPromptCutOff(storage, "cut-1"), false);
  // Marked as its POST leaves; the page then reloads, so no send of this page
  // load has it.
  markFirstPromptGoing(storage, "cut-1", true);
  assert.equal(firstPromptCutOff(storage, "cut-1"), true);
  assert.deepEqual(rememberedFirstPrompt(storage, "cut-1"), { prompt: "fix it", attachmentIds: ["a"] });
  markFirstPromptGoing(storage, "cut-1", false);
  assert.equal(firstPromptCutOff(storage, "cut-1"), false);
  assert.deepEqual(rememberedFirstPrompt(storage, "cut-1"), { prompt: "fix it", attachmentIds: ["a"] });
});

test("a send still going in this page load isn't cut off: a page mounted again waits on it", async () => {
  const storage = memoryStorage();
  rememberFirstPrompt(storage, "cut-2", { prompt: "fix it", attachmentIds: [] });
  const going = controlledSend();
  const firstMount = sendFirstPromptOnce("cut-2", () => {
    markFirstPromptGoing(storage, "cut-2", true);
    return going.send();
  });
  assert.equal(firstPromptCutOff(storage, "cut-2"), false);
  going.calls[0](true);
  assert.equal(await firstMount, "sent");
});

test("moving the URL's prompt keeps a copy already kept, and its mark", () => {
  const storage = memoryStorage();
  rememberFirstPrompt(storage, "cut-3", { prompt: "fix it", attachmentIds: [] });
  markFirstPromptGoing(storage, "cut-3", true);
  const url = new URL("https://outrunner.test/workspaces/cut-3?prompt=fix+it");
  assert.equal(keepFirstPromptFromUrl(storage, "cut-3", url), "/workspaces/cut-3");
  assert.equal(firstPromptCutOff(storage, "cut-3"), true);
});

test("storage refusing, or missing outright, marks nothing and cuts nothing off", () => {
  for (const storage of [refusing, null]) {
    assert.doesNotThrow(() => markFirstPromptGoing(storage, "cut-4", true));
    assert.equal(firstPromptCutOff(storage, "cut-4"), false);
  }
});

test("start over with no prompt waiting hands over nothing", () => {
  const storage = memoryStorage();
  assert.equal(handOverFirstPrompt(storage, "old", "new"), null);
  assert.equal(rememberedFirstPrompt(storage, "new"), null);
});

test("storage refusing, or missing outright, still starts over without a prompt", () => {
  for (const storage of [refusing, null]) {
    assert.equal(handOverFirstPrompt(storage, "old", "new"), null);
  }
});

/** A send that settles when the test says, counting its calls. */
function controlledSend() {
  const calls: Array<(delivered: boolean) => void> = [];
  return {
    calls,
    send: () => new Promise<boolean>((resolve) => calls.push(resolve)),
  };
}

test("a session page mounted again mid-send waits on that send rather than sending twice", async () => {
  const first = controlledSend();
  const again = controlledSend();
  const firstMount = sendFirstPromptOnce("once-1", first.send);
  const secondMount = sendFirstPromptOnce("once-1", again.send);
  first.calls[0](true);
  assert.equal(await firstMount, "sent");
  assert.equal(await secondMount, "already");
  assert.equal(again.calls.length, 0);
  // Sent: a later mount (back to the old ?prompt= URL) sends nothing either.
  assert.equal(await sendFirstPromptOnce("once-1", again.send), "already");
});

test("when the earlier send fails, the page on screen sends it itself", async () => {
  const gone = controlledSend();
  const shown = controlledSend();
  const leftPage = sendFirstPromptOnce("once-2", gone.send);
  const pageOnScreen = sendFirstPromptOnce("once-2", shown.send);
  gone.calls[0](false);
  assert.equal(await leftPage, "failed");
  // Its own send, so its own error shows if this one fails too.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown.calls.length, 1);
  shown.calls[0](true);
  assert.equal(await pageOnScreen, "sent");
});

test("a send that throws counts as failed, and leaves the prompt to send again", async () => {
  assert.equal(await sendFirstPromptOnce("once-3", () => Promise.reject(new Error("offline"))), "failed");
  assert.equal(await sendFirstPromptOnce("once-3", () => Promise.resolve(true)), "sent");
});

test("a first prompt's key goes everywhere the prompt does: URL, kept copy, its mark, start over", () => {
  const first = newFirstPrompt("fix it", ["a"]);
  assert.match(first.key ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(newFirstPrompt("fix it", ["a"]).key, first.key);

  const url = new URL(`https://outrunner.test/workspaces/ws-k${firstPromptQuery(first)}`);
  assert.deepEqual(firstPromptFromUrl(url), first);
  assert.equal(withoutFirstPrompt(url), "/workspaces/ws-k");

  // Kept from the URL alone (a tab the new-session screen didn't keep it in).
  const storage = memoryStorage();
  keepFirstPromptFromUrl(storage, "ws-k", url);
  assert.deepEqual(rememberedFirstPrompt(storage, "ws-k"), first);
  markFirstPromptGoing(storage, "ws-k", true);
  markFirstPromptGoing(storage, "ws-k", false);
  assert.deepEqual(rememberedFirstPrompt(storage, "ws-k"), first);
  assert.deepEqual(handOverFirstPrompt(storage, "ws-k", "ws-k2"), first);
  assert.deepEqual(rememberedFirstPrompt(storage, "ws-k2"), first);
});

test("no key, or nothing to send, puts no key in the URL", () => {
  assert.equal(firstPromptQuery({ prompt: " ", attachmentIds: [], key: "k1" }), "");
  assert.equal(
    firstPromptFromUrl(new URL("https://outrunner.test/workspaces/w?prompt=hi"))?.key,
    undefined,
  );
  const storage = memoryStorage();
  storage.setItem("outrunner:first-prompt:w1", JSON.stringify({ prompt: "hi", attachmentIds: [], key: 7 }));
  assert.deepEqual(rememberedFirstPrompt(storage, "w1"), { prompt: "hi", attachmentIds: [] });
});

test("a cut-off first prompt is still offered after a second reload, until it's settled", () => {
  const storage = memoryStorage();
  rememberFirstPrompt(storage, "ws-cut", { prompt: "fix the login bug", attachmentIds: [], key: "k-1" });
  // The send left, the page reloaded, and the server's send then failed,
  // letting go of its claim: the prompt never reached Claude.
  markFirstPromptGoing(storage, "ws-cut", true);
  // Reload #1 offers it (Send it again) and, as the session page now does,
  // keeps it; reload #2, before the user acts, still finds it.
  for (const reload of [1, 2]) {
    assert.equal(firstPromptCutOff(storage, "ws-cut"), true, `reload #${reload}`);
    assert.equal(rememberedFirstPrompt(storage, "ws-cut")?.prompt, "fix the login bug", `reload #${reload}`);
  }
  // Settled (sent again and landed, dismissed, or shown by the conversation):
  // forgotten, and not offered again.
  forgetFirstPrompt(storage, "ws-cut");
  assert.equal(firstPromptCutOff(storage, "ws-cut"), false);
});
