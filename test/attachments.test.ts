import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ATTACHMENT_DIR,
  attachmentFilenames,
  attachNotice,
  restoreDraft,
  MAX_ATTACHMENTS_PER_MESSAGE,
  isImage,
  isImageName,
  promptAttachments,
  promptWithAttachments,
  promptWithoutAttachments,
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

test("attachmentFilenames keeps a later paste from overwriting an earlier one", () => {
  // Browsers name every pasted image image.png; each message is named alone.
  const [first] = attachmentFilenames([{ id: "3f2a9c1b-0000-4000-8000-000000000001", filename: "image.png" }]);
  const [later] = attachmentFilenames([{ id: "8d41e7a0-0000-4000-8000-000000000002", filename: "image.png" }]);
  assert.equal(first, "3f2a9c1b-image.png");
  assert.equal(later, "8d41e7a0-image.png");
  assert.notEqual(first, later);
});

test("attachmentFilenames still sanitizes and keeps names unique within a message", () => {
  assert.deepEqual(
    attachmentFilenames([
      { id: "aaaaaaaa-1", filename: "../my shot.png" },
      { id: "aaaaaaaa-2", filename: "my shot.png" },
      { id: "", filename: "notes.txt" },
    ]),
    ["aaaaaaaa-my-shot.png", "aaaaaaaa-my-shot-1.png", "notes.txt"],
  );
  // Still under the folder the prompt header names, so a failed send's draft
  // comes back without it.
  const prompt = promptWithAttachments("look", attachmentFilenames([{ id: "3f2a9c1b-x", filename: "image.png" }]));
  assert.equal(promptWithoutAttachments(prompt), "look");
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

test("promptWithoutAttachments recovers the typed prompt from one with a single file", () => {
  assert.equal(promptWithoutAttachments(promptWithAttachments("what is wrong here?", ["shot.png"])), "what is wrong here?");
});

test("promptWithoutAttachments recovers the typed prompt from one with several files", () => {
  const sent = promptWithAttachments("compare these\nsecond line", ["a.png", "b.png", "c.pdf"]);
  assert.equal(promptWithoutAttachments(sent), "compare these\nsecond line");
});

test("promptWithoutAttachments leaves only nothing when only files were sent", () => {
  assert.equal(promptWithoutAttachments(promptWithAttachments("", ["shot.png"])), "");
});

test("promptWithoutAttachments leaves a prompt with no header alone", () => {
  assert.equal(promptWithoutAttachments("fix the bug"), "fix the bug");
});

test("promptWithoutAttachments leaves alone text that only looks like the header", () => {
  const typed = "I've attached a file:\n- notes.md\n\nplease read it";
  assert.equal(promptWithoutAttachments(typed), typed);
  const later = `fix this\nI've attached a file:\n- ${ATTACHMENT_DIR}/x.png`;
  assert.equal(promptWithoutAttachments(later), later);
});

test("promptWithAttachments mentions images, so Claude Code puts them in front of the model", () => {
  const out = promptWithAttachments("what is this?", ["shot.png", "log.txt", { name: "photo", image: true }]);
  assert.ok(out.includes(`- @${ATTACHMENT_DIR}/shot.png`));
  assert.ok(out.includes(`- ${ATTACHMENT_DIR}/log.txt`));
  assert.ok(!out.includes(`@${ATTACHMENT_DIR}/log.txt`));
  assert.ok(out.includes(`- @${ATTACHMENT_DIR}/photo`));
});

test("promptAttachments splits a logged prompt into its words and its files", () => {
  const sent = promptWithAttachments("compare\nthese", ["a.png", "notes.md"]);
  assert.deepEqual(promptAttachments(sent), {
    text: "compare\nthese",
    files: [`${ATTACHMENT_DIR}/a.png`, `${ATTACHMENT_DIR}/notes.md`],
  });
  // As sessions from before the mentions logged it.
  assert.deepEqual(promptAttachments(`I've attached a file:\n- ${ATTACHMENT_DIR}/old.png\n\nhi`), {
    text: "hi",
    files: [`${ATTACHMENT_DIR}/old.png`],
  });
  assert.deepEqual(promptAttachments("just words"), { text: "just words", files: [] });
});

test("isImageName reads the images the model can see from their names", () => {
  for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp"]) assert.ok(isImageName(name), name);
  for (const name of ["a.svg", "b.pdf", "png", "c.png.txt"]) assert.ok(!isImageName(name), name);
});

test("attachNotice says files cannot go to a session on this Mac", () => {
  assert.match(attachNotice({ allowed: false, canSend: true, skipped: 0 }) ?? "", /this Mac/);
});

test("attachNotice says files wait for the session to connect", () => {
  assert.match(attachNotice({ allowed: true, canSend: false, skipped: 0 }) ?? "", /once the session is connected/);
});

test("attachNotice counts the files left out, in the right number", () => {
  assert.equal(
    attachNotice({ allowed: true, canSend: true, skipped: 1 }),
    `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message: 1 was left out.`,
  );
  assert.match(attachNotice({ allowed: true, canSend: true, skipped: 3 }) ?? "", /3 were left out/);
});

test("attachNotice says nothing when every file was taken", () => {
  assert.equal(attachNotice({ allowed: true, canSend: true, skipped: 0 }), null);
});

test("a failed send gives its prompt back to an empty composer", () => {
  assert.equal(restoreDraft("fix the bug", ""), "fix the bug");
  assert.equal(restoreDraft("fix the bug", "   "), "fix the bug");
});

test("a failed send keeps what was typed since, after its own prompt", () => {
  assert.equal(restoreDraft("fix the bug", "and add a test"), "fix the bug\n\nand add a test");
});

test("a failed send of files only leaves the new draft as it is", () => {
  assert.equal(restoreDraft("", "and add a test"), "and add a test");
});
