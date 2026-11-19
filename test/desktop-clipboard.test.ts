import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  clipboardAction,
  COPY_WAIT_MS,
  DesktopClipboard,
  KEYSYM,
  remoteKeys,
  writeToClipboard,
} from "@/lib/session/desktop-clipboard";

const press = (key: string, code: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

test("the clipboard shortcuts are Cmd or Ctrl with C, X or V, Shift or not", () => {
  assert.equal(clipboardAction(press("v", "KeyV", { meta: true })), "paste");
  assert.equal(clipboardAction(press("v", "KeyV", { ctrl: true })), "paste");
  assert.equal(clipboardAction(press("c", "KeyC", { meta: true })), "copy");
  assert.equal(clipboardAction(press("x", "KeyX", { ctrl: true })), "cut");
  // A terminal's copy and paste.
  assert.equal(clipboardAction(press("C", "KeyC", { ctrl: true, shift: true })), "copy");
  assert.equal(clipboardAction(press("V", "KeyV", { ctrl: true, shift: true })), "paste");

  for (const other of [
    press("v", "KeyV"),
    press("v", "KeyV", { shift: true }),
    press("v", "KeyV", { ctrl: true, meta: true }),
    press("v", "KeyV", { meta: true, alt: true }),
    press("a", "KeyA", { ctrl: true }),
    press("Enter", "Enter", { meta: true }),
  ]) {
    assert.equal(clipboardAction(other), null, JSON.stringify(other));
  }
});

test("a shortcut is the letter typed, or the key's place where it types no Latin letter", () => {
  // Dvorak: V is where Latin layouts have the full stop.
  assert.equal(clipboardAction(press("v", "Period", { meta: true })), "paste");
  assert.equal(clipboardAction(press("j", "KeyC", { meta: true })), null);
  // Russian: the V key types м.
  assert.equal(clipboardAction(press("м", "KeyV", { ctrl: true })), "paste");
  assert.equal(clipboardAction(press("ы", "KeyS", { ctrl: true })), null);
});

test("with Ctrl held on the desktop, the letter alone makes the chord", () => {
  assert.deepEqual(remoteKeys("paste", false), [
    { keysym: KEYSYM.v, down: true },
    { keysym: KEYSYM.v, down: false },
  ]);
});

test("with Cmd, which reached the desktop as Alt, Alt is let go of and Ctrl pressed around the letter", () => {
  assert.deepEqual(remoteKeys("copy", true), [
    { keysym: KEYSYM.Alt_L, down: false },
    { keysym: KEYSYM.Super_L, down: false },
    { keysym: KEYSYM.Control_L, down: true },
    { keysym: KEYSYM.c, down: true },
    { keysym: KEYSYM.c, down: false },
    { keysym: KEYSYM.Control_L, down: false },
  ]);
  assert.equal(remoteKeys("cut", true)[3].keysym, KEYSYM.x);
});

test("a copy takes the next text the desktop says, else the last, else nothing", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const clipboard = new DesktopClipboard();

    // Never told: nothing.
    const never = clipboard.next();
    mock.timers.tick(COPY_WAIT_MS);
    assert.equal(await never, null);

    // Told while waiting: that text, at once.
    const next = clipboard.next();
    clipboard.told("copied");
    assert.equal(await next, "copied");

    // The selection was said as it was made, and the copy changed nothing
    // the desktop says again: the last text, once the wait is over.
    clipboard.told("selected");
    let settled: string | null | undefined;
    const last = clipboard.next().then((text) => (settled = text));
    mock.timers.tick(COPY_WAIT_MS - 1);
    await Promise.resolve();
    assert.equal(settled, undefined);
    mock.timers.tick(1);
    await last;
    assert.equal(settled, "selected");
  } finally {
    mock.timers.reset();
  }
});

/** A browser clipboard that records what's written to it. */
function fakeClipboard() {
  const written: string[] = [];
  let writes = 0;
  const clipboard = {
    write: async (items: ClipboardItem[]) => {
      writes++;
      const blob = await (items[0] as unknown as { data: Record<string, Promise<Blob>> }).data["text/plain"];
      written.push(await blob.text());
    },
    writeText: async (text: string) => {
      written.push(text);
    },
  };
  return { clipboard, written, writes: () => writes };
}

class FakeItem {
  readonly data: Record<string, Promise<Blob>>;
  constructor(data: Record<string, Promise<Blob>>) {
    this.data = data;
  }
}

test("what the desktop copied is written in the key press, its text to come", async () => {
  const { clipboard, written, writes } = fakeClipboard();
  let copied!: (text: string | null) => void;
  writeToClipboard(new Promise((resolve) => (copied = resolve)), clipboard, FakeItem as unknown as typeof ClipboardItem);
  // Asked for at once, before the desktop has said anything.
  assert.equal(writes(), 1);
  copied("from the desktop");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ["from the desktop"]);
});

test("nothing copied writes nothing, and a browser without ClipboardItem writes the text", async () => {
  const { clipboard, written } = fakeClipboard();
  writeToClipboard(Promise.resolve(null), clipboard, FakeItem as unknown as typeof ClipboardItem);
  writeToClipboard(Promise.resolve(null), clipboard, undefined);
  // A copy with nothing selected: the desktop's clipboard is empty, and the
  // user's keeps what it had.
  writeToClipboard(Promise.resolve(""), clipboard, FakeItem as unknown as typeof ClipboardItem);
  writeToClipboard(Promise.resolve(""), clipboard, undefined);
  writeToClipboard(Promise.resolve("plain"), clipboard, undefined);
  writeToClipboard(Promise.resolve("ignored"), undefined, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ["plain"]);
});
