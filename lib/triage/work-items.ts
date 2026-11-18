/**
 * Triage, the parts with no database: what a work item is, how a capture
 * (from the app, Slack, the CLI) becomes one, and the prompt a session started
 * from one begins with. lib/db/work-items.ts stores them.
 */

export type WorkItemStatus = "triage" | "todo" | "in_progress" | "done" | "declined" | "duplicate";
export type WorkItemSource = "app" | "slack" | "cli" | "api" | "linear" | "jira";

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "triage",
  "todo",
  "in_progress",
  "done",
  "declined",
  "duplicate",
];
export const WORK_ITEM_SOURCES: readonly WorkItemSource[] = ["app", "slack", "cli", "api", "linear", "jira"];

export const STATUS_LABELS: Record<WorkItemStatus, string> = {
  triage: "Triage",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
  duplicate: "Duplicate",
};

export const SOURCE_LABELS: Record<WorkItemSource, string> = {
  app: "Outrunner",
  slack: "Slack",
  cli: "CLI",
  api: "API",
  linear: "Linear",
  jira: "Jira",
};

export type WorkItem = {
  id: string;
  /** Per owner; shown as {@link itemKey}. */
  number: number;
  /** The workspace (a projects row) it belongs to; null is Unsorted. */
  projectId: string | null;
  title: string;
  /** Markdown. */
  body: string;
  status: WorkItemStatus;
  source: WorkItemSource;
  sourceUrl: string | null;
  sourceRef: string | null;
  /** Who wrote it where it came from ("Ana"); null when that's its capturer.
   *  Only a tracker's items have one. */
  sourceAuthor: string | null;
  duplicateOf: string | null;
  /** The session started from it. */
  workspaceId: string | null;
  /** The prompt it was filed with (the Slack agent writes one); Start session
   *  uses it as written. */
  prompt: string | null;
  triagedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** An item as the triage routes answer with it: what the asker may do with
 *  it (lib/triage/access.ts), and whether its session is theirs to open. */
export type TriageItem = WorkItem & {
  can: { triage: boolean; contribute: boolean };
  ownSession?: boolean;
};

export type WorkItemNote = {
  id: string;
  itemId: string;
  /** Markdown. */
  body: string;
  source: WorkItemSource;
  sourceUrl: string | null;
  /** Who wrote it where it came from; null is the owner. */
  author: string | null;
  createdAt: string;
};

export const MAX_TITLE = 200;
export const MAX_BODY = 100_000;
const MAX_SOURCE_REF = 300;

/** OR-42. */
export function itemKey(item: Pick<WorkItem, "number">): string {
  return `OR-${item.number}`;
}

/** The app's page for an item. */
export function itemHref(item: Pick<WorkItem, "id">): string {
  return `/triage?item=${item.id}`;
}

/**
 * The app's page for capturing an item: the dialog over the list. `item` is
 * the item left open behind it, and `project` the workspace the dialog
 * starts in. Made in one place because ⌘I and the page's own buttons both
 * need it, and the page's is what keeps the item open (app-frame.tsx).
 */
export function captureHref({ item, project }: { item?: string | null; project?: string | null } = {}): string {
  const params = new URLSearchParams();
  if (item) params.set("item", item);
  params.set("new", "1");
  if (project) params.set("project", project);
  return `/triage?${params}`;
}

/** Whether an item's title and body are its tracker's (Linear, Jira), which
 *  owns them: Outrunner follows them, rather than editing a copy. */
export function trackerOwned(item: Pick<WorkItem, "source" | "sourceRef">): boolean {
  return (item.source === "linear" || item.source === "jira") && item.sourceRef !== null;
}

/** Statuses still waiting on someone: triage and active work. */
export function isOpen(status: WorkItemStatus): boolean {
  return status === "triage" || status === "todo" || status === "in_progress";
}

/** By character, so a cut never splits an emoji's surrogate pair. */
export function cutText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * A title from free text: its first non-empty line, without Markdown's
 * heading/quote/list marks, emphasis, or link wrapping (Markdown's or
 * Slack's), cut to fit.
 * Empty text has none.
 */
export function titleFromText(text: string, max = 80): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  const plain = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/<(?:[^|>]+)\|([^>]+)>/g, "$1")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  return cutText(plain || line, Math.min(max, MAX_TITLE));
}

/** A new item as asked for, checked; a string is why it's refused. */
export type NewWorkItem = {
  title: string;
  body: string;
  /** `owner/name`, or a projects id; resolved by the caller. */
  project: string | null;
  source: WorkItemSource;
  sourceUrl: string | null;
  sourceRef: string | null;
};

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) return undefined;
  return trimmed || null;
}

/** Only http(s) links are kept as a way back: no javascript: in an href. */
export function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A request body for a new item (the app's form, the ingest API). The title
 * may be left out when the body says it (its first line); `allowed` is the
 * sources this caller may claim (the app is "app"; a token is "cli"/"api").
 */
export function parseNewWorkItem(
  input: unknown,
  allowed: readonly WorkItemSource[],
): NewWorkItem | string {
  if (!input || typeof input !== "object") return "Invalid request body.";
  const raw = input as Record<string, unknown>;
  const body = raw.body === undefined || raw.body === null ? "" : raw.body;
  if (typeof body !== "string") return "The body must be text.";
  if (body.length > MAX_BODY) return "The body is too long.";
  const givenTitle = optionalText(raw.title, 10_000);
  if (givenTitle === undefined) return "The title must be text.";
  const title = givenTitle ? cutText(givenTitle.replace(/\s+/g, " "), MAX_TITLE) : titleFromText(body);
  if (!title) return "A title or a body is required.";
  const project = optionalText(raw.project, 200);
  if (project === undefined) return "The repository must be text.";
  const source = raw.source === undefined ? allowed[0] : raw.source;
  if (typeof source !== "string" || !(allowed as readonly string[]).includes(source)) {
    return `The source must be one of: ${allowed.join(", ")}.`;
  }
  const sourceUrl = optionalText(raw.source_url ?? raw.sourceUrl, 2000);
  if (sourceUrl === undefined) return "The source URL must be text.";
  const sourceRef = optionalText(raw.source_ref ?? raw.sourceRef, MAX_SOURCE_REF);
  if (sourceRef === undefined) return `The source ref must be text of at most ${MAX_SOURCE_REF} characters.`;
  // They're how a tracker finds its issue's item: one made here first would hold its place, and
  // the issue would never be filed or written back to.
  if (sourceRef && /^(linear|jira):/i.test(sourceRef)) return "A source ref can't start with linear: or jira:.";
  return {
    title,
    body: body.trim(),
    project,
    source: source as WorkItemSource,
    sourceUrl: safeUrl(sourceUrl),
    sourceRef,
  };
}

/** What may be changed on an item from the app. */
export type WorkItemPatch = {
  title?: string;
  body?: string;
  status?: WorkItemStatus;
  projectId?: string | null;
  duplicateOf?: string | null;
};

export function parseWorkItemPatch(input: unknown): WorkItemPatch | string {
  if (!input || typeof input !== "object") return "Invalid request body.";
  const raw = input as Record<string, unknown>;
  const patch: WorkItemPatch = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || !raw.title.trim()) return "The title can't be empty.";
    patch.title = cutText(raw.title.trim().replace(/\s+/g, " "), MAX_TITLE);
  }
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string") return "The body must be text.";
    if (raw.body.length > MAX_BODY) return "The body is too long.";
    patch.body = raw.body;
  }
  if (raw.status !== undefined) {
    if (typeof raw.status !== "string" || !(WORK_ITEM_STATUSES as readonly string[]).includes(raw.status)) {
      return "Unknown status.";
    }
    patch.status = raw.status as WorkItemStatus;
  }
  if (raw.projectId !== undefined) {
    if (raw.projectId !== null && typeof raw.projectId !== "string") return "Invalid workspace.";
    patch.projectId = raw.projectId;
  }
  if (raw.duplicateOf !== undefined) {
    if (raw.duplicateOf !== null && typeof raw.duplicateOf !== "string") return "Invalid duplicate.";
    patch.duplicateOf = raw.duplicateOf;
  }
  if (patch.status === "duplicate" && !patch.duplicateOf) return "Pick the item this duplicates.";
  if (patch.duplicateOf && patch.status !== undefined && patch.status !== "duplicate") {
    return "Only a duplicate names the item it duplicates.";
  }
  if (Object.keys(patch).length === 0) return "Nothing to change.";
  return patch;
}

/** A note's text, checked. */
export function parseNoteBody(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const body = input.trim();
  return body && body.length <= MAX_BODY ? body : null;
}

/**
 * The prompt a session started from an item begins with: its key and title,
 * its body, and its notes, oldest first, with where they came from. Editable
 * in the composer before it is sent.
 */
export function workItemPrompt(item: WorkItem, notes: WorkItemNote[], url?: string): string {
  const parts = [`Work on ${itemKey(item)}: ${item.title}`];
  if (url) parts.push(`(${url})`);
  if (item.body.trim()) parts.push(item.body.trim());
  const written = notes.filter((n) => n.body.trim());
  if (written.length > 0) {
    parts.push(
      [
        "Notes:",
        ...written.map((n) => {
          const by = n.author ? ` (${n.author})` : "";
          return `- ${n.body.trim().replace(/\n/g, "\n  ")}${by}`;
        }),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}
