import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ATTACHMENT_DIR,
  isImage,
  promptWithAttachments,
  safeFilename,
  uniqueFilenames,
} from "@/lib/runtime/attachments";

test("safeFilename strips directories so a name cannot escape the attachment dir", () => {
  assert.equal(safeFilename("../../etc/passwd"), "passwd");
  assert.equal(safeFilename("/absolute/path/notes.txt"), "notes.txt");
  assert.equal(safeFilename("C:\\Users\\me\\shot.png"), "shot.png");
});

test("safeFilename drops leading dashes and dots", () => {
  // A leading dash reads as a flag to anything that later globs the directory;
  // a leading dot would hide the file.
  assert.equal(safeFilename("--rf"), "rf");
  assert.equal(safeFilename(".hidden"), "hidden");
});

test("safeFilename removes control characters and exotic punctuation", () => {
  assert.equal(safeFilename("a\u0000b\nc.png"), "abc.png");
  assert.equal(safeFilename("my photo (1).png"), "my-photo--1-.png");
});

test("safeFilename never returns empty", () => {
  assert.equal(safeFilename(""), "attachment");
  assert.equal(safeFilename("..."), "attachment");
  assert.equal(safeFilename("///"), "attachment");
});

test("safeFilename bounds the length", () => {
  assert.ok(safeFilename("x".repeat(500)).length <= 120);
});

test("uniqueFilenames disambiguates collisions instead of overwriting", () => {
  assert.deepEqual(
    uniqueFilenames(["shot.png", "shot.png", "shot.png"]),
    ["shot.png", "shot-1.png", "shot-2.png"],
  );
});

test("uniqueFilenames handles extensionless names", () => {
  assert.deepEqual(uniqueFilenames(["LICENSE", "LICENSE"]), ["LICENSE", "LICENSE-1"]);
});

test("uniqueFilenames collides only after sanitizing", () => {
  // Both sanitize to the same thing, so the second must still be renamed.
  assert.deepEqual(uniqueFilenames(["a b.png", "a/b.png"]), ["a-b.png", "b.png"]);
});

test("isImage recognizes what Claude can see, not every image type", () => {
  for (const t of ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]) {
    assert.ok(isImage(t), t);
  }
  assert.ok(isImage("IMAGE/PNG"));
  assert.ok(!isImage("image/svg+xml"));
  assert.ok(!isImage("text/plain"));
  assert.ok(!isImage("application/pdf"));
});

test("promptWithAttachments leaves a prompt alone when nothing is attached", () => {
  assert.equal(promptWithAttachments("fix the bug", []), "fix the bug");
});

test("promptWithAttachments names paths relative to the worktree", () => {
  const out = promptWithAttachments("what is wrong here?", ["shot.png"]);
  assert.ok(out.includes(`${ATTACHMENT_DIR}/shot.png`));
  assert.ok(out.includes("I've attached a file:"));
  assert.ok(out.endsWith("what is wrong here?"));
});

test("promptWithAttachments pluralizes and lists every file", () => {
  const out = promptWithAttachments("compare these", ["a.png", "b.png"]);
  assert.ok(out.includes("I've attached 2 files:"));
  assert.ok(out.includes(`${ATTACHMENT_DIR}/a.png`));
  assert.ok(out.includes(`${ATTACHMENT_DIR}/b.png`));
});

test("promptWithAttachments tolerates an empty prompt", () => {
  // Sending just a screenshot with no words is a real thing to do.
  const out = promptWithAttachments("", ["shot.png"]);
  assert.ok(out.includes(`${ATTACHMENT_DIR}/shot.png`));
  assert.ok(!out.endsWith("\n"));
});
