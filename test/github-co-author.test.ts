import assert from "node:assert/strict";
import { test } from "node:test";

import { githubCoAuthor } from "@/lib/github/co-author";

test("a GitHub identity becomes its stable noreply co-author trailer", () => {
  assert.equal(
    githubCoAuthor({ githubId: 84772210, githubLogin: "immadsahin", name: "immad sahin" }),
    "immad sahin <84772210+immadsahin@users.noreply.github.com>",
  );
});

test("a co-author cannot forge another commit trailer", () => {
  assert.equal(
    githubCoAuthor({ githubId: 7, githubLogin: "ada", name: "Ada\nCo-Authored-By: Mallory <mallory@example.com>" }),
    "Ada Co-Authored-By: Mallory mallory@example.com <7+ada@users.noreply.github.com>",
  );
});

test("an absent or malformed GitHub identity has no invented attribution", () => {
  assert.equal(githubCoAuthor({ githubId: null, githubLogin: "ada", name: "Ada" }), null);
  assert.equal(githubCoAuthor({ githubId: 7, githubLogin: "not/a/login", name: "Ada" }), null);
});
