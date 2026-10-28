/**
 * `@outrunner` on GitHub (Replicas' way): a comment on an issue, a pull
 * request or a line of one, read as a request for that issue's or pull
 * request's session. The parts with no I/O: what a mention is, which comments
 * count, and what the session and the thread are told. The webhook's loop
 * (lib/github/loop.ts) acts on them.
 */

/** Said anywhere in a comment, it keeps Outrunner out of it. */
export const SKIP_MARKER = "[skip outrunner]";

/** The names a mention may use: `@outrunner`, and the App's slug and its
 *  bot's login as GitHub has them (`@outrunner-connector`,
 *  `@outrunner-connector[bot]`). */
export function mentionNames(appSlug?: string): string[] {
  const names = new Set(["outrunner"]);
  if (appSlug) {
    names.add(appSlug.toLowerCase());
    names.add(`${appSlug.toLowerCase()}[bot]`);
  }
  // Longest first, so `@outrunner-connector` isn't read as `@outrunner`.
  return [...names].sort((a, b) => b.length - a.length);
}

function mentionPattern(appSlug?: string): RegExp {
  const names = mentionNames(appSlug).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Not inside a word or an email (`a@outrunner.dev`), and the whole login:
  // `@outrunner-bot` is someone else.
  return new RegExp(`(?<![\\w@/.-])@(?:${names.join("|")})(?![\\w-]|\\[bot\\])`, "gi");
}

/** Whether a comment mentions Outrunner, outside quoted lines and code: a
 *  reply that quotes an earlier mention isn't one itself. */
export function mentionsOutrunner(body: string, appSlug?: string): boolean {
  return mentionPattern(appSlug).test(withoutQuotesAndCode(body));
}

/** The comment without its mentions of Outrunner: what was asked. */
export function stripMentions(body: string, appSlug?: string): string {
  return body.replace(mentionPattern(appSlug), "").replace(/[ \t]{2,}/g, " ").trim();
}

function withoutQuotesAndCode(body: string): string {
  return body
    .replace(/```[\s\S]*?(```|$)/g, "")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/** Whether a comment asks Outrunner to keep out. */
export function skipsOutrunner(body: string): boolean {
  return body.toLowerCase().includes(SKIP_MARKER);
}

/** A GitHub account as a webhook names it. */
export type GitHubUser = { id: number; login: string; type: string };

/** Whether an account is a bot's: an App's, or a machine user's by its
 *  login. Bots never steer a session. */
export function isBot(user: Pick<GitHubUser, "login" | "type">): boolean {
  return user.type === "Bot" || /\[bot\]$/i.test(user.login);
}

/** How the commenter stands with the repository on GitHub: only someone it
 *  knows (an owner, a member, a collaborator) is told why Outrunner won't
 *  act; anyone else is ignored quietly, so a public repository's visitors
 *  can't make it talk. */
export function associated(authorAssociation: string | null): boolean {
  return authorAssociation === "OWNER" || authorAssociation === "MEMBER" || authorAssociation === "COLLABORATOR";
}

/** Where a review comment is: its file and lines, and the diff it's on. */
export type LineContext = {
  path: string;
  line: number | null;
  startLine: number | null;
  side: string | null;
  diffHunk: string | null;
};

/** A mention to act on. */
export type Mention = {
  installationId: number;
  /** The repository, `owner/name`. */
  repoFullName: string;
  /** What it's on: an issue, or a pull request (its conversation or a line). */
  target: "issue" | "pull";
  number: number;
  title: string;
  /** The issue's or pull request's own description. */
  description: string;
  url: string;
  /** The comment, and which of GitHub's kinds it is: replies and reactions
   *  go through different routes for each. */
  comment: { id: number; kind: "issue_comment" | "review_comment"; body: string; url: string };
  author: GitHubUser;
  authorAssociation: string | null;
  /** A review comment's place in the change. */
  line: LineContext | null;
  /** The pull request's branches when the event carried them (a review
   *  comment's does; an issue comment's never does). */
  pull: PullBranches | null;
};

/** A pull request's branches, and whether its head is in the repository. */
export type PullBranches = { headRef: string; headSha: string; baseRef: string; fromFork: boolean };

/** Why a comment is left alone; null when it may be a mention. */
export type MentionSkip = "action" | "unreadable" | "bot" | "skip" | "no_mention";

type CommentPayload = {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  issue?: {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    html_url?: unknown;
    pull_request?: unknown;
  } | null;
  pull_request?: {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    html_url?: unknown;
    head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null } | null;
    base?: { ref?: unknown } | null;
  } | null;
  comment?: {
    id?: unknown;
    body?: unknown;
    html_url?: unknown;
    author_association?: unknown;
    user?: { id?: unknown; login?: unknown; type?: unknown } | null;
    path?: unknown;
    line?: unknown;
    original_line?: unknown;
    start_line?: unknown;
    side?: unknown;
    diff_hunk?: unknown;
  } | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The pull request's branches as a webhook gives them; null when it
 *  doesn't. */
export function readPullBranches(
  pr: {
    head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null } | null;
    base?: { ref?: unknown } | null;
  } | null | undefined,
  repoFullName: string,
): PullBranches | null {
  const headRef = text(pr?.head?.ref);
  const headSha = text(pr?.head?.sha);
  const baseRef = text(pr?.base?.ref);
  if (!headRef || !headSha || !baseRef) return null;
  const headRepo = text(pr?.head?.repo?.full_name);
  return { headRef, headSha, baseRef, fromFork: headRepo?.toLowerCase() !== repoFullName.toLowerCase() };
}

/**
 * A new comment as a mention, or why it isn't one: `issue_comment` (on an
 * issue, or on a pull request's conversation) and
 * `pull_request_review_comment` (on a line of one). Only a new comment: an
 * edit that adds a mention isn't a new request. A bot's comment, Outrunner's
 * own replies included, is never one.
 */
export function readMention(event: string | null, payload: unknown, appSlug?: string): Mention | MentionSkip {
  if (event !== "issue_comment" && event !== "pull_request_review_comment") return "action";
  const p = (payload ?? {}) as CommentPayload;
  if (p.action !== "created") return "action";
  const installationId = positive(p.installation?.id);
  const repoFullName = text(p.repository?.full_name);
  const c = p.comment;
  const commentId = positive(c?.id);
  const body = typeof c?.body === "string" ? c.body : null;
  const author = c?.user;
  const authorId = positive(author?.id);
  const login = text(author?.login);
  const subject = event === "issue_comment" ? p.issue : p.pull_request;
  const number = positive(subject?.number);
  if (!installationId || !repoFullName || !commentId || body === null || !authorId || !login || !subject || !number) {
    return "unreadable";
  }
  const user = { id: authorId, login, type: text(author?.type) ?? "User" };
  if (isBot(user)) return "bot";
  if (skipsOutrunner(body)) return "skip";
  if (!mentionsOutrunner(body, appSlug)) return "no_mention";
  const review = event === "pull_request_review_comment";
  const target = review || (p.issue?.pull_request !== undefined && p.issue?.pull_request !== null) ? "pull" : "issue";
  return {
    installationId,
    repoFullName,
    target,
    number,
    title: text(subject.title) ?? "",
    description: typeof subject.body === "string" ? subject.body : "",
    url: text(subject.html_url) ?? `https://github.com/${repoFullName}/${target === "pull" ? "pull" : "issues"}/${number}`,
    comment: {
      id: commentId,
      kind: review ? "review_comment" : "issue_comment",
      body,
      url: text(c?.html_url) ?? "",
    },
    author: user,
    authorAssociation: text(c?.author_association),
    line:
      review && text(c?.path)
        ? {
            path: text(c?.path) as string,
            line: positive(c?.line) ?? positive(c?.original_line),
            startLine: positive(c?.start_line),
            side: text(c?.side),
            diffHunk: text(c?.diff_hunk),
          }
        : null,
    pull: review ? readPullBranches(p.pull_request, repoFullName) : null,
  };
}

/** The idempotency key of acting on a comment: a redelivery, or the same
 *  comment heard twice, acts once. */
export function mentionKey(mention: Pick<Mention, "comment">): string {
  return `mention:${mention.comment.kind}:${mention.comment.id}`;
}

/** At most this much of a diff hunk goes to the session: the lines nearest
 *  the comment, which GitHub puts last. */
const HUNK_LINES = 20;
/** And of an issue's or pull request's description. */
const DESCRIPTION_MAX = 6_000;

function quote(body: string): string {
  return body
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function clip(body: string, max: number): string {
  return body.length > max ? `${body.slice(0, max)}\n…(cut short)` : body;
}

/** Where a review comment is, in words. */
export function lineLabel(line: LineContext): string {
  if (line.line === null) return `\`${line.path}\``;
  const lines = line.startLine && line.startLine !== line.line ? `lines ${line.startLine}-${line.line}` : `line ${line.line}`;
  return `\`${line.path}\`, ${lines}${line.side === "LEFT" ? " of the old version" : ""}`;
}

/** The comment's own part of a prompt: who said it, where, and what. */
export function commentBlock(mention: Pick<Mention, "author" | "comment" | "line">, appSlug?: string): string {
  const asked = stripMentions(mention.comment.body, appSlug) || "(nothing but the mention)";
  const parts = [
    mention.line
      ? `@${mention.author.login} commented on ${lineLabel(mention.line)} (${mention.comment.url}):`
      : `@${mention.author.login} commented (${mention.comment.url}):`,
  ];
  if (mention.line?.diffHunk) {
    const hunk = mention.line.diffHunk.split("\n").slice(-HUNK_LINES).join("\n");
    parts.push("", "The diff they commented on (their line last):", "```diff", hunk, "```");
  }
  parts.push("", quote(asked));
  return parts.join("\n");
}

/**
 * What a session that already works on the issue or pull request is told:
 * the comment, with its place in the change for a line's.
 */
export function followUpPrompt(mention: Mention, appSlug?: string): string {
  const where = mention.target === "pull" ? "pull request" : "issue";
  return [
    `New on GitHub, on the ${where} this session works on (${mention.repoFullName}#${mention.number}):`,
    "",
    commentBlock(mention, appSlug),
    "",
    replyHint(mention),
  ].join("\n");
}

/**
 * What a session started by the mention is told: the comment, the issue or
 * pull request it's on, and where its work goes. A pull request's session
 * works on the pull request's head and pushes there; an issue's on a new
 * branch, ending in a pull request that closes it.
 */
export function startPrompt(mention: Mention, appSlug?: string): string {
  const pull = mention.target === "pull";
  const lines = [
    `@${mention.author.login} asked for you on GitHub, on ${pull ? "pull request" : "issue"} ${mention.repoFullName}#${mention.number}${mention.title ? ` "${mention.title}"` : ""}: ${mention.url}`,
    "",
    commentBlock(mention, appSlug),
    "",
    `The ${pull ? "pull request's" : "issue's"} description:`,
    "",
    mention.description.trim() ? quote(clip(mention.description, DESCRIPTION_MAX)) : "> (none)",
    "",
  ];
  if (pull && mention.pull) {
    lines.push(
      `This session's working tree starts at the pull request's head branch, \`${mention.pull.headRef}\`. Read the change with \`gh pr diff ${mention.number}\` and \`gh pr view ${mention.number} --comments\`. If they asked for changes, commit them and push to that branch (\`git push origin HEAD:${mention.pull.headRef}\`); don't open another pull request.`,
    );
  } else {
    lines.push(
      `Read the issue with \`gh issue view ${mention.number} --comments\`. If they asked for a change, make it on this session's branch, push it, and open a pull request whose description starts with \`Closes #${mention.number}\`.`,
    );
  }
  lines.push(replyHint(mention));
  return lines.join("\n");
}

function replyHint(mention: Pick<Mention, "target" | "number">): string {
  const command = mention.target === "pull" ? `gh pr comment ${mention.number}` : `gh issue comment ${mention.number}`;
  // What the session posts may be as its owner, not the App's bot: a
  // mention in it would be read as theirs, and start the loop again.
  return `When you're done, or if you need something from them, say so in a comment there (\`${command}\`), short, and never write "@outrunner" in it.`;
}

/** A session's title, from what it was started on. */
export function mentionTitle(mention: Pick<Mention, "repoFullName" | "number" | "title" | "target">): string {
  const repo = mention.repoFullName.split("/")[1] ?? mention.repoFullName;
  const title = `${repo}#${mention.number}${mention.title ? `: ${mention.title}` : ""}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

/** What Outrunner replies on GitHub once it has the comment. */
export type MentionReply =
  | { kind: "sent"; url: string }
  | { kind: "started"; url: string }
  | { kind: "failed"; reason: string }
  | { kind: "fork" }
  | { kind: "not_member" }
  | { kind: "no_access"; repoFullName: string };

/** The reply's text: a link to the session, or why there's none. */
export function replyText(reply: MentionReply): string {
  switch (reply.kind) {
    case "sent":
      return `Sent to the session working on this: [open it in Outrunner](${reply.url}).`;
    case "started":
      return `On it: [follow the session in Outrunner](${reply.url}).`;
    case "failed":
      return `I couldn't start a session for this: ${reply.reason.replace(/\.?$/, ".")}`;
    case "fork":
      return "This pull request's branch is in a fork, which Outrunner can't push to, so I didn't start a session.";
    case "not_member":
      return "I only take requests from members of the Outrunner org this repository is connected to, with GitHub linked to their account (Outrunner → Settings → Account).";
    case "no_access":
      return `Your Outrunner account can't start sessions on ${reply.repoFullName}: an admin of its org can give you access under Settings → Org → Roles & access.`;
  }
}
