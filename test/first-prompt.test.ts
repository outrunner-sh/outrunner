import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimFirstPrompt,
  firstPromptQuery,
  forgetFirstPrompt,
  rememberedFirstPrompt,
  rememberFirstPrompt,
  releaseFirstPrompt,
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

test("a first prompt is sent by one session page at a time, and again only after a failure", () => {
  assert.equal(claimFirstPrompt("claim-1"), true);
  // The session opened again while the first send is still going.
  assert.equal(claimFirstPrompt("claim-1"), false);
  assert.equal(claimFirstPrompt("claim-2"), true);
  releaseFirstPrompt("claim-1");
  assert.equal(claimFirstPrompt("claim-1"), true);
});
