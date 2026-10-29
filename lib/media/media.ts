/**
 * Media a session's agent uploads to show its work in a pull request: what
 * may be uploaded, how a file is named and linked, and the caps on an org.
 *
 * Pure helpers, no Supabase, Next or Node, so the rules are unit-tested
 * without env or network and the pages can share them. The IO is lib/db/media.ts and the routes: app/api/runtime/media
 * (a box's uploads), app/m/[file] (the public link) and app/api/media (the
 * uploader's own view and delete).
 */

/** The largest file a box may upload: a minute of screen recording, or a
 *  long GIF. The bucket and the table hold the same limit. */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** How many files an org may upload in a day, and keep in all. A session
 *  proving a change uploads a handful; these stop a loop, not a person. */
export const MAX_MEDIA_PER_DAY = 500;
export const MAX_MEDIA_BYTES_PER_ORG = 10 * 1024 * 1024 * 1024;

/** How often one org's boxes may start an upload (lib/api/rate-limit.ts). */
export const MEDIA_RATE_LIMIT = { perMinute: 30 };

/** What may be uploaded, by content type, and the extension its link ends
 *  in. GitHub shows the images inline; an mp4 is a link to play. */
export const MEDIA_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
} as const;

export type MediaContentType = keyof typeof MEDIA_TYPES;

export function isMediaContentType(value: unknown): value is MediaContentType {
  return typeof value === "string" && Object.hasOwn(MEDIA_TYPES, value);
}

/**
 * The type a file's first bytes say it is, or null for anything else. The
 * link serves a file as this type, so what is stored is checked, not taken
 * from the box's word: nothing but an image or a video is ever served from
 * the app's own origin.
 */
export function sniffMediaType(head: Uint8Array): MediaContentType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 8) === "PNG\r\n\x1a\n") return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  // An ISO media file opens with a box whose type is `ftyp`.
  if (head.length >= 12 && ascii(4, 8) === "ftyp") return "video/mp4";
  return null;
}

/** How many leading bytes {@link sniffMediaType} needs. */
export const SNIFF_BYTES = 16;

/** A file's public id: 32 random bytes, so a link can't be guessed. */
export function isPublicId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** The path of a file's public link: its id and its type's extension, so a
 *  reader of the markdown sees what it is. */
export function publicMediaPath(publicId: string, contentType: MediaContentType): string {
  return `/m/${publicId}.${MEDIA_TYPES[contentType]}`;
}

/** The public id in a link's last segment (`{id}.{ext}`, or the id alone),
 *  or null when it isn't one. The extension is only for show. */
export function publicIdFromFile(file: string): string | null {
  const id = file.replace(/\.[a-z0-9]{2,4}$/i, "");
  return isPublicId(id) ? id : null;
}

/** The uploader's page for a file: view it, copy its markdown, delete it. */
export function mediaPagePath(id: string): string {
  return `/media/${id}`;
}

/**
 * A file's name as shown, and as the markdown's alt text: one line, no
 * characters that would end the alt text early (`[`, `]`) or break the line,
 * at most 200 characters. Empty falls back to the file's own name.
 */
export function cleanMediaName(name: unknown, fallback = "Screenshot"): string {
  const raw = typeof name === "string" ? name : "";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    .trim();
  return cleaned || fallback;
}

/** The line to paste in a pull request, an issue or a chat: an image for
 *  an image, a link for a video (GitHub doesn't play one from a link). */
export function mediaMarkdown(name: string, url: string, contentType?: MediaContentType): string {
  return contentType?.startsWith("video/") ? `[${cleanMediaName(name)}](${url})` : `![${cleanMediaName(name)}](${url})`;
}

/** Who a file's link opens for: anyone, or its uploader alone (signed in). */
export type MediaAccess = "public" | "private";

/**
 * Who a file's link opens for when the upload doesn't say: an image's is
 * public, to show in a pull request; a video's is private, since a recording
 * shows more than a screenshot does, until it's uploaded as public on
 * purpose. A pull request shows a video as a GIF that links to it.
 */
export function defaultAccess(contentType: MediaContentType): MediaAccess {
  return contentType.startsWith("video/") ? "private" : "public";
}

export type UploadRequest = {
  workspaceId: string;
  name: string;
  contentType: MediaContentType;
  sizeBytes: number;
  access: MediaAccess;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A box's request to upload a file, checked; a message for the agent when
 *  it can't be. */
export function parseUploadRequest(body: unknown): UploadRequest | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(b.workspaceId)) return { error: "Name the session the file is from." };
  if (!isMediaContentType(b.contentType)) {
    return { error: "Only PNG, JPEG, GIF, WebP and MP4 files can be uploaded." };
  }
  const size = b.sizeBytes;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return { error: "The file is empty." };
  }
  if (size > MAX_MEDIA_BYTES) {
    return { error: `Files are limited to ${MAX_MEDIA_BYTES / (1024 * 1024)} MB. Make it smaller (a GIF: fewer frames per second, or narrower).` };
  }
  if (b.access !== undefined && b.access !== null && b.access !== "public" && b.access !== "private") {
    return { error: 'Access is "public" or "private".' };
  }
  return {
    workspaceId: b.workspaceId,
    name: cleanMediaName(b.name),
    contentType: b.contentType,
    sizeBytes: size,
    access: b.access ?? defaultAccess(b.contentType),
  };
}

/** What to tell the agent when its org is over a cap. */
export function capMessage(refused: "daily" | "storage"): string {
  return refused === "daily"
    ? `Your org has uploaded ${MAX_MEDIA_PER_DAY} files in the last day, its limit. Try again later.`
    : `Your org's uploads are at their ${MAX_MEDIA_BYTES_PER_ORG / 1024 ** 3} GB limit. Delete some you no longer need first.`;
}

/** A size for people: "820 KB", "4.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
