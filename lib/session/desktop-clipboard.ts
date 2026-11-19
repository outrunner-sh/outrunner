/**
 * Copy and paste between the user's computer and the session's desktop, for
 * the Desktop tab (components/workspace-desktop.tsx) while Interact is on.
 * noVNC hands the desktop the keys as they're pressed: a Mac's Cmd arrives as
 * Alt, and Ctrl+V pastes the desktop's own clipboard, not the user's. So the
 * clipboard shortcuts are caught before noVNC sees them. A paste puts the
 * user's text on the desktop's clipboard, then presses Ctrl+V there; a copy
 * or cut presses Ctrl+C or Ctrl+X there, then puts what the desktop copied on
 * the user's clipboard.
 *
 * Pure (no DOM), so it is unit-tested in Node.
 */

export type ClipboardAction = "copy" | "cut" | "paste";

const BY_LETTER: Record<string, ClipboardAction> = { c: "copy", x: "cut", v: "paste" };
const BY_PLACE: Record<string, ClipboardAction> = { KeyC: "copy", KeyX: "cut", KeyV: "paste" };

/**
 * The clipboard action a key press asks for: Cmd or Ctrl (not both, nor
 * with Alt) and C, X or V, Shift or not (a terminal's copy and paste are
 * Ctrl+Shift+C and V). By the letter it types, so a Dvorak V is V; where it
 * types no Latin letter (a Cyrillic layout), by the key's place. null for
 * any other key.
 */
export function clipboardAction(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">): ClipboardAction | null {
  if (e.altKey || e.ctrlKey === e.metaKey) return null;
  const letter = e.key.toLowerCase();
  if (/^[a-z]$/.test(letter)) return BY_LETTER[letter] ?? null;
  return BY_PLACE[e.code] ?? null;
}

/** The X keysyms the desktop is sent (noVNC's core/input/keysym.js). */
export const KEYSYM = { Control_L: 0xffe3, Alt_L: 0xffe9, Super_L: 0xffeb, c: 0x63, v: 0x76, x: 0x78 } as const;

const LETTER: Record<ClipboardAction, number> = { copy: KEYSYM.c, cut: KEYSYM.x, paste: KEYSYM.v };

export type KeyPress = { keysym: number; down: boolean };

/**
 * The keys to send the desktop for `action`, its shortcut pressed with Cmd
 * (`metaKey`) or Ctrl. noVNC sent the modifiers as they went down, Shift
 * included: Ctrl as itself, still held, so the letter alone makes the chord;
 * but Cmd as Alt (the right one as Super), which is let go of first, then
 * Ctrl pressed and let go around the letter.
 */
export function remoteKeys(action: ClipboardAction, metaKey: boolean): KeyPress[] {
  const letter = LETTER[action];
  const press = [
    { keysym: letter, down: true },
    { keysym: letter, down: false },
  ];
  if (!metaKey) return press;
  return [
    { keysym: KEYSYM.Alt_L, down: false },
    { keysym: KEYSYM.Super_L, down: false },
    { keysym: KEYSYM.Control_L, down: true },
    ...press,
    { keysym: KEYSYM.Control_L, down: false },
  ];
}

/** How long a paste waits for the browser's paste event, which comes at
 *  once where it comes at all, before pasting the desktop's own clipboard. */
export const PASTE_WAIT_MS = 300;

/** How long a copy waits for the desktop to say what it copied before taking
 *  the text it last said: copying what's already selected changes nothing
 *  it would say again. */
export const COPY_WAIT_MS = 1_000;

/** The desktop's clipboard as the desktop tells it (noVNC's clipboard
 *  event): the last text it said, and the next. */
export class DesktopClipboard {
  private last: string | null = null;
  private waiting: ((text: string) => void)[] = [];

  /** The desktop says its clipboard is `text` now. */
  told(text: string): void {
    this.last = text;
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve(text);
  }

  /** The next text the desktop says, or, if it says none within `ms`, the
   *  last it said: null if it never has. */
  next(ms = COPY_WAIT_MS): Promise<string | null> {
    return new Promise((resolve) => {
      const done = (text: string | null) => {
        clearTimeout(timer);
        this.waiting = this.waiting.filter((w) => w !== done);
        resolve(text);
      };
      const timer = setTimeout(() => done(this.last), ms);
      this.waiting.push(done);
    });
  }
}

/**
 * Put `text`, once it's known, on the user's clipboard. Called in the key
 * press, as browsers let only a page the user just acted on write to it: a
 * ClipboardItem whose text comes later where there is one (Safari and the Mac
 * app's WebKit refuse a write made after the press), writeText where there
 * isn't. Nothing copied (an empty clipboard: a copy with nothing selected),
 * or a browser that refuses, leaves it as it was.
 */
export function writeToClipboard(
  text: Promise<string | null>,
  clipboard: Pick<Clipboard, "write" | "writeText"> | undefined,
  Item: typeof ClipboardItem | undefined = globalThis.ClipboardItem,
): void {
  if (!clipboard) return;
  if (Item && clipboard.write) {
    const blob = text.then((t) => {
      if (!t) throw new Error("the desktop copied nothing");
      return new Blob([t], { type: "text/plain" });
    });
    clipboard.write([new Item({ "text/plain": blob })]).catch(() => {});
    return;
  }
  text.then((t) => (t ? clipboard.writeText(t) : undefined)).catch(() => {});
}
