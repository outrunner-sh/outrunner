/**
 * Composer attachments: naming, limits, and how they reach Claude.
 *
 * Pure helpers — no Supabase, no Next — so the rules are unit-testable without
 * env or network. The IO lives in lib/db/attachments.ts and the API routes.
 *
 * Claude runs on the box with ordinary filesystem access, so an attachment only
 * has to *arrive* somewhere it can read. Files land in `.attachments/` inside
 * the worktree and the prompt names their paths; Claude opens them with its own
 * tools, and images it can see directly.
 */

/** Where attachments live inside a workspace's worktree. */
export const ATTACHMENT_DIR = ".attachments";

/**
 * Per-file ceiling. Generous enough for screenshots and logs, small enough that
 * one paste cannot fill a 3 GiB box or stall a provision while it downloads.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How many files may ride along with a single prompt. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Whether Claude can see this file as an image rather than read it as text.
 * Only affects how the prompt refers to it — everything is uploaded either way.
 */
export function isImage(contentType: string): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/i.test(contentType);
}

/**
 * Make a user's filename safe to use as a path segment on the box.
 *
 * The name reaches a shell-free upload API, but it still becomes a real path
 * and is interpolated into a prompt, so traversal, separators, leading dashes
 * (which read as flags to anything that later globs the directory) and control
 * characters all have to go. Empty results fall back rather than producing a
 * dotfile or an empty segment.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // Escaped, not literal: raw control bytes in the source are silently
    // stripped by editors and formatters, which would leave this sanitizer
    // passing them straight through into a filename.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 120);
  return cleaned || "attachment";
}

/**
 * Where an attachment row's bytes are, when its `storage_path` is where
 * createAttachment (lib/db/attachments.ts) put them,
 * `uploads/<owner>/<id>/<name>`; null for any other path. The row is its
 * owner's to update under RLS, the bytes are read and removed with the
 * service role: a path rewritten to another user's object must not be.
 */
export function attachmentObjectPath(row: { id: string; owner_id: string; storage_path: string }): string | null {
  const prefix = `uploads/${row.owner_id}/${row.id}/`;
  if (!row.storage_path.startsWith(prefix)) return null;
  const name = row.storage_path.slice(prefix.length);
  return name !== "" && name === safeFilename(name) ? row.storage_path : null;
}

/**
 * Keep names unique within one message, so two files both called
 * `screenshot.png` do not overwrite each other on the box.
 */
export function uniqueFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = safeFilename(raw);
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0
      ? `${name.slice(0, dot)}-${count}${name.slice(dot)}`
      : `${name}-${count}`;
  });
}

/**
 * The names attachments are written under on the box: each led by a short
 * form of its id, so a file from a later message cannot overwrite one from an
 * earlier (browsers name every pasted image `image.png`), then kept unique
 * within the message too.
 */
export function attachmentFilenames(attachments: Array<{ id: string; filename: string }>): string[] {
  return uniqueFilenames(
    attachments.map((a) => {
      const short = attachmentShortId(a.id);
      const name = safeFilename(a.filename);
      return short ? `${short}-${name}` : name;
    }),
  );
}

/** The short form of an attachment's id its name on the box leads with
 *  (attachmentFilenames): an id's first 8 letters and digits. */
export function attachmentShortId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
}

/** The short id a name on the box leads with, or null for a name that
 *  doesn't lead with one (an attachment named before ids were). */
export function shortIdOfName(name: string): string | null {
  return /^([0-9a-f]{8})-/i.exec(name)?.[1]?.toLowerCase() ?? null;
}

/** Whether a file on the box, by its name, is an image the model can see:
 *  the names keep their extension (safeFilename), so this reads it. */
export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/** One attachment as the prompt names it: its name on the box, and whether
 *  it's an image (else read from its extension, isImageName). */
export type AttachedName = string | { name: string; image: boolean };

/**
 * Prefix a prompt with the attachment paths so Claude knows what arrived and
 * where. Paths are relative to the worktree, which is Claude's working
 * directory, so they resolve with no further context.
 *
 * An image is named as an `@` mention: Claude Code reads a mentioned image
 * into the prompt it sends, so the model sees it with the words rather than
 * only if it thinks to open the file. Other files stay plain paths, as a
 * mention would paste a whole log into the prompt.
 *
 * Returns the prompt unchanged when there are no attachments — an empty header
 * would just be noise in the conversation log.
 */
export function promptWithAttachments(prompt: string, files: AttachedName[]): string {
  if (files.length === 0) return prompt;
  const lines = files.map((file) => {
    const { name, image } = typeof file === "string" ? { name: file, image: isImageName(file) } : file;
    return `- ${image ? "@" : ""}${ATTACHMENT_DIR}/${name}`;
  });
  const header =
    files.length === 1
      ? "I've attached a file:"
      : `I've attached ${files.length} files:`;
  return `${header}\n${lines.join("\n")}\n\n${prompt}`.trim();
}

/**
 * A prompt as Claude logged it, split into what the user typed and the files
 * promptWithAttachments listed ahead of it (`.attachments/…`, without any
 * `@`). A prompt that does not start with that exact header is all text, so
 * ordinary text that happens to mention an attachment is never cut.
 */
export function promptAttachments(prompt: string): { text: string; files: string[] } {
  const header = /^I've attached (?:a file|\d+ files):\n(?:- [^\n]*\n?)+/;
  const match = header.exec(prompt);
  if (!match) return { text: prompt, files: [] };
  const listed = match[0].split("\n").slice(1).filter((line) => line.length > 0);
  const files: string[] = [];
  for (const line of listed) {
    const path = line.replace(/^- @?/, "");
    if (!path.startsWith(`${ATTACHMENT_DIR}/`)) return { text: prompt, files: [] };
    files.push(path);
  }
  return { text: prompt.slice(match[0].length).trim(), files };
}

/** The prompt the user typed, from one as Claude logged it: without the
 *  header promptWithAttachments put in front (promptAttachments). */
export function promptWithoutAttachments(prompt: string): string {
  return promptAttachments(prompt).text;
}

/** What the composer says about files it was handed, or null when it took
 *  them all: they cannot go to a local session (the server delivers them), or
 *  not yet (no session to send them to), or only some fit in one message. */
export function attachNotice(input: { allowed: boolean; canSend: boolean; skipped: number }): string | null {
  if (!input.allowed) return "Files can't be attached to a session on this Mac.";
  if (!input.canSend) return "Files can be attached once the session is connected.";
  if (input.skipped > 0) {
    const were = input.skipped === 1 ? "was" : "were";
    return `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message: ${input.skipped} ${were} left out.`;
  }
  return null;
}

/** The composer's text after a send fails: the failed prompt back, ahead of
 *  anything typed while it was in flight (which is kept, not overwritten). */
export function restoreDraft(failed: string, typedSince: string): string {
  if (!failed) return typedSince;
  if (!typedSince.trim()) return failed;
  return `${failed}\n\n${typedSince}`;
}
