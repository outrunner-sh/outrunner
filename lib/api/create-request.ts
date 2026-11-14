/**
 * A request to start a session through the public API (POST /workspaces),
 * checked, and the prompt the session is sent first. No network here
 * (lib/api/workspaces.ts makes the session).
 */

import { createHash } from "node:crypto";

import { type ImageInput, parseImages } from "@/lib/api/images";
import { pullRequestRef, repoFullName, type PullRequestRef } from "@/lib/api/repo-ref";
import { isUuid } from "@/lib/ids";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/runtime/attachments";
import { isBoxSizeId } from "@/lib/runtime/box-sizes";

/** What a session started with `plan_mode` is told before its prompt. */
export const PLAN_MODE_PREAMBLE =
  "Plan first. Read what you need and reply with a plan for the task below, then stop and wait: don't change any files, commit or push until you're told to go ahead.";

export const MAX_PROMPT = 100_000;

/** What a session asked to open a pull request is told after its prompt. */
export const AUTO_PR_CODA =
  "When the task is done, commit your work, push it, and open a pull request for it.";

/** The longest a session's name may be. */
export const MAX_NAME = 120;

/** A create request, checked. */
export type CreateInput = {
  projectId: string | null;
  environmentId: string | null;
  /** The repository named by its address (`repo_url`, or `pr_url`'s), as a
   *  project's `full_name`, for lib/api/workspaces.ts to find the project of. */
  repoFullName: string | null;
  /** The pull request it works on (`pr_url`): its checkout starts at its head. */
  pullRequest: (PullRequestRef & { url: string }) | null;
  /** It pushes to the branch it starts on (the pull request's head, else
   *  `base_branch`) rather than one of its own. */
  workOnCurrentBranch: boolean;
  /** It opens a pull request once it's done (AUTO_PR_CODA). */
  autoCreatePr: boolean;
  /** Its title, instead of one made from its prompt. */
  name?: string;
  prompt: string;
  planMode: boolean;
  model?: string;
  provider?: string;
  effort?: string;
  agent?: string;
  size?: string;
  branch?: string;
  baseBranch?: string;
  /** Files uploaded with POST /attachments, put on the box with the prompt. */
  attachmentIds: string[];
  /** Images sent inline, kept as uploads beside those (lib/api/images.deps.ts). */
  images: ImageInput[];
  /** Kept for the webhooks (lib/api/webhooks.ts). */
  webhookUrl: string | null;
};

function optionalString(raw: Record<string, unknown>, key: string): string | undefined | null {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `attachment_ids` as posted (none is an empty list), or the reason they're
 *  refused: uploads' ids (POST /attachments), as many as one message takes. */
export function parseAttachmentIds(value: unknown): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && isUuid(id))) {
    return "`attachment_ids` is a list of the ids POST /attachments answered with.";
  }
  const ids = [...new Set(value as string[])];
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) return `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files go with one message.`;
  return ids;
}

/** A create request as posted, or the reason it's refused. */
export function parseCreate(raw: Record<string, unknown>): CreateInput | string {
  const projectId = optionalString(raw, "project_id");
  const environmentId = optionalString(raw, "environment_id");
  if (projectId === null || environmentId === null) return "`project_id` and `environment_id` must be ids.";
  let pullRequest: CreateInput["pullRequest"] = null;
  if (raw.pr_url !== undefined && raw.pr_url !== null) {
    const ref = pullRequestRef(raw.pr_url);
    if (!ref) return "`pr_url` is the address of a pull request on GitHub, or a merge request on GitLab.com.";
    pullRequest = { ...ref, url: String(raw.pr_url).trim() };
  }
  let fullName: string | null = null;
  if (raw.repo_url !== undefined && raw.repo_url !== null) {
    fullName = repoFullName(raw.repo_url);
    if (!fullName) return "`repo_url` is the address of a repository on GitHub or GitLab.com.";
    if (pullRequest && fullName.toLowerCase() !== pullRequest.fullName.toLowerCase()) return "`pr_url` is a pull request of another repository than `repo_url`.";
  }
  fullName ??= pullRequest?.fullName ?? null;
  const named = [projectId, environmentId, fullName].filter(Boolean).length;
  if (named === 0) return "Name the repository to work on (`project_id` or `repo_url`), a project (`environment_id`), or a pull request (`pr_url`).";
  if (named > 1) return "Name one of `project_id`, `environment_id` and `repo_url` (or `pr_url`).";
  if ((projectId && !isUuid(projectId)) || (environmentId && !isUuid(environmentId))) return "That id isn't one.";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return "Say what the session should do (`prompt`).";
  if (prompt.length > MAX_PROMPT) return "The prompt is too long.";
  for (const key of ["plan_mode", "auto_create_pr", "work_on_current_branch"]) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== "boolean") return `\`${key}\` is true or false.`;
  }
  const fields: Record<string, string | undefined> = {};
  for (const key of ["model", "provider", "effort", "agent", "size", "branch", "base_branch", "webhook_url", "name"]) {
    const value = optionalString(raw, key);
    if (value === null) return `\`${key}\` must be text.`;
    fields[key] = value;
  }
  if (fields.size && !isBoxSizeId(fields.size)) return "`size` is x-small, small, medium or large.";
  if (fields.agent && fields.agent !== "claude" && fields.agent !== "codex") return "`agent` is claude or codex.";
  if (fields.agent && !fields.model) return "Name the `model` the agent runs, with `agent`.";
  if (fields.name && fields.name.length > MAX_NAME) return `\`name\` is at most ${MAX_NAME} characters.`;
  const workOnCurrentBranch = raw.work_on_current_branch === true;
  if (pullRequest && fields.base_branch) return "A session on a pull request starts at its head: leave out `base_branch`.";
  if (workOnCurrentBranch && !pullRequest && !fields.base_branch) {
    return "Name the branch to push to with `base_branch` (or a pull request with `pr_url`), with `work_on_current_branch`.";
  }
  if (workOnCurrentBranch && fields.branch) return "`work_on_current_branch` pushes to the branch it starts on: leave out `branch`.";
  const attachmentIds = parseAttachmentIds(raw.attachment_ids);
  if (typeof attachmentIds === "string") return attachmentIds;
  const images = parseImages(raw.images, attachmentIds.length);
  if (typeof images === "string") return images;
  return {
    projectId: projectId ?? null,
    environmentId: environmentId ?? null,
    repoFullName: fullName,
    pullRequest,
    workOnCurrentBranch,
    autoCreatePr: raw.auto_create_pr === true,
    ...(fields.name && { name: fields.name }),
    prompt,
    planMode: raw.plan_mode === true,
    model: fields.model,
    provider: fields.provider,
    effort: fields.effort,
    agent: fields.agent,
    size: fields.size,
    branch: fields.branch,
    baseBranch: fields.base_branch,
    attachmentIds,
    images,
    webhookUrl: fields.webhook_url ?? null,
  };
}

/** The `Idempotency-Key` header as sent, or null for none, or the reason
 *  it's refused: 1 to 255 printable characters. */
export function idempotencyKey(headers: Headers): string | null | { refused: string } {
  const key = headers.get("idempotency-key");
  if (key === null) return null;
  return /^[\x21-\x7e]{1,255}$/.test(key) ? key : { refused: "`Idempotency-Key` is 1 to 255 printable characters, without spaces." };
}

/** The session id a create with `key` makes, the same every time for its
 *  caller (and only theirs): a create sent again with it answers with the
 *  session the first made (createCloudSession's own id, as the new-session
 *  screen sends one). */
export function idempotentId(userId: string, key: string): string {
  const hex = createHash("sha256").update(`api-create:${userId}:${key}`).digest("hex");
  // A version 5 (name-based) UUID's layout, from the hash.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The prompt a session is sent first: plan mode's preamble, then where its
 * work goes (`preamble`: a pull request's, from lib/api/repo-ref.ts; or the
 * branch it pushes to), its prompt, and AUTO_PR_CODA when it's to open one.
 */
export function firstPrompt(
  input: Pick<CreateInput, "prompt" | "planMode"> & Partial<Pick<CreateInput, "autoCreatePr" | "workOnCurrentBranch" | "baseBranch">>,
  preamble?: string,
): string {
  const pushTo = !preamble && input.workOnCurrentBranch && input.baseBranch
    ? `Push your commits to ${input.baseBranch} itself (\`git push origin HEAD:${input.baseBranch}\`), not to a branch of your own.`
    : undefined;
  // Pushing straight to a branch is the pull request's work done already.
  const coda = input.autoCreatePr && !input.workOnCurrentBranch ? AUTO_PR_CODA : undefined;
  return [input.planMode ? PLAN_MODE_PREAMBLE : undefined, preamble ?? pushTo, input.prompt, coda].filter(Boolean).join("\n\n");
}
