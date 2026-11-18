/**
 * Cursor's Projects API (api.cursor.com/v1/projects, beta), answered by
 * Outrunner's Missions (docs/missions.md). The part with no network:
 * Cursor's requests read, and a Mission said in Cursor's words.
 * lib/api/cursor-projects.deps.ts makes and reads the Missions.
 *
 * A project is a Mission: its id the Mission's session's, and its
 * coordinator agent that same session (GET /api/v1/agents/{id} reads it, and
 * POST /api/v1/agents/{id}/runs talks to it). The agents Cursor's project
 * runs for it are the Mission's Ships.
 */

import { createFromCursor, sessionIdOf } from "@/lib/api/cursor";
import { MAX_NAME, MAX_PROMPT, parseAttachmentIds } from "@/lib/api/create-request";
import { type ImageInput, parseImages } from "@/lib/api/images";
import { repoFullName } from "@/lib/api/repo-ref";
import { isUuid } from "@/lib/ids";
import { missionName } from "@/lib/missions/rules";
import { type BoxSizeId, isBoxSizeId } from "@/lib/runtime/box-sizes";
import { isObject } from "@/lib/is-object";

export type CursorProjectStatus = "ACTIVE" | "ARCHIVED";

/** The colors Cursor's `appearance.color` takes. A Mission has none of its
 *  own: one asked for is checked, and every project answers `default`. */
export const PROJECT_COLORS = ["default", "green", "cyan", "blue", "purple", "magenta", "orange", "yellow", "red", "brand"] as const;

export type ProjectAppearance = { icon?: string; color?: (typeof PROJECT_COLORS)[number] };

/** Where a project works: a project of Outrunner's by name (Cursor's
 *  `env.name`) or id, a repository's own project (by its id or address). */
export type ProjectPlace = { envName: string } | { environmentId: string } | { projectId: string } | { repoFullName: string };

/** A create in Cursor's words (POST /v1/projects), checked. */
export type ProjectCreate = {
  /** Its first message; empty for none (it waits for one, as the app's does). */
  prompt: string;
  images: ImageInput[];
  attachmentIds: string[];
  /** Its title, instead of one made from the prompt. */
  name?: string;
  model?: string;
  effort?: string;
  provider?: string;
  agent?: string;
  size?: BoxSizeId;
  branch?: string;
  /** The branch its repository starts from (`repos[0].startingRef`). */
  startingRef?: string;
  place: ProjectPlace;
  /** `projectId` (or `Idempotency-Key`): sent again, the same Mission. */
  key: string | null;
  appearance: ProjectAppearance;
};

/** A project's status: archived with its session, else at work. */
export function cursorProjectStatus(sessionStatus: string): CursorProjectStatus {
  return ["archiving", "archived", "destroying", "destroyed"].includes(sessionStatus) ? "ARCHIVED" : "ACTIVE";
}

/** The Mission a project's id names: its own id, or `bc-` and it. */
export function missionIdOf(projectId: string): string {
  return sessionIdOf(projectId);
}

/** A project's name: the one given, else one from its prompt. */
export function projectTitle(create: Pick<ProjectCreate, "name" | "prompt">): string | undefined {
  if (create.name) return create.name;
  return create.prompt.trim() ? missionName(create.prompt) : undefined;
}

/** Cursor's `appearance` (`{ icon?, color? }`), its icon one of `icons`
 *  (a Mission's, lib/missions/icons.ts), or the reason it's refused. */
export function appearanceFrom(value: unknown, icons: readonly string[]): ProjectAppearance | string {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return "`appearance` is `{ icon?, color? }`.";
  const appearance: ProjectAppearance = {};
  if (value.icon !== undefined && value.icon !== null) {
    if (typeof value.icon !== "string" || !icons.includes(value.icon)) return `\`appearance.icon\` is one of ${icons.join(", ")}.`;
    appearance.icon = value.icon;
  }
  if (value.color !== undefined && value.color !== null) {
    if (typeof value.color !== "string" || !(PROJECT_COLORS as readonly string[]).includes(value.color)) {
      return `\`appearance.color\` is one of ${PROJECT_COLORS.join(", ")}.`;
    }
    appearance.color = value.color as ProjectAppearance["color"];
  }
  return appearance;
}

function textField(raw: Record<string, unknown>, key: string): string | undefined | { refused: string } {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && value.trim() ? value.trim() : { refused: `\`${key}\` must be text.` };
}

/**
 * A create in Cursor's words (POST /v1/projects) as a Mission's, or the
 * reason it's refused. Its prompt, model, name, `env` and `repos` are read
 * as POST /v1/agents reads them (createFromCursor); a Mission works in one
 * project, so of one repository, or of a project of Outrunner's named by
 * `env.name` (or Outrunner's own `environment_id`, `project_id`).
 */
export function projectFromCursor(raw: Record<string, unknown>, icons: readonly string[]): ProjectCreate | string {
  if (Array.isArray(raw.repos) && raw.repos.length > 1) {
    return "A project works in one repository here, or in a project of several: make one in Outrunner and name it with `env: { type: \"cloud\", name }` (or send its `environment_id`) instead of `repos`.";
  }
  const read = createFromCursor({ prompt: raw.prompt ?? "", model: raw.model, name: raw.name, env: raw.env, repos: raw.repos });
  if (typeof read === "string") return read;
  const { body } = read;
  if (body.pr_url !== undefined) return "A project starts on a branch: send `repos[0].startingRef`, not `prUrl`.";

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length > MAX_PROMPT) return "The prompt is too long.";
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) return "`name` is text.";
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : undefined;
  if (name && name.length > MAX_NAME) return `\`name\` is at most ${MAX_NAME} characters.`;

  const fields: Record<string, string | undefined> = {};
  for (const key of ["environment_id", "project_id", "provider", "agent", "size", "branch"]) {
    const value = textField(raw, key);
    if (typeof value === "object") return value.refused;
    fields[key] = value;
  }
  if (fields.agent && fields.agent !== "claude") return "Projects run on Claude Code here: they're Missions, whose tools reach their agent through Claude Code.";
  if (fields.provider === "codex") return "Projects run on Claude Code here: they're Missions, whose tools reach their agent through Claude Code.";
  if (fields.size && !isBoxSizeId(fields.size)) return "`size` is x-small, small, medium or large.";

  let fullName: string | null = null;
  if (body.repo_url !== undefined) {
    fullName = repoFullName(body.repo_url);
    if (!fullName) return "`repos[0].url` is the address of a repository on GitHub or GitLab.com.";
  }
  if (body.base_branch !== undefined && (typeof body.base_branch !== "string" || !body.base_branch.trim())) return "`repos[0].startingRef` is a branch's name.";
  const places: ProjectPlace[] = [
    ...(read.envName ? [{ envName: read.envName }] : []),
    ...(fields.environment_id ? [{ environmentId: fields.environment_id }] : []),
    ...(fields.project_id ? [{ projectId: fields.project_id }] : []),
    ...(fullName ? [{ repoFullName: fullName }] : []),
  ];
  if (places.length === 0) return "Say where the project works: a repository (`repos: [{ url }]`), or a project of Outrunner's by name (`env: { type: \"cloud\", name }`).";
  if (places.length > 1) return "Name one place for the project: `repos`, `env.name`, `environment_id` or `project_id`.";
  const place = places[0];
  if (("environmentId" in place && !isUuid(place.environmentId)) || ("projectId" in place && !isUuid(place.projectId))) return "That id isn't one.";
  if (body.base_branch !== undefined && !("repoFullName" in place)) return "`startingRef` goes with a repository's `url`.";

  const attachmentIds = parseAttachmentIds(raw.attachment_ids);
  if (typeof attachmentIds === "string") return attachmentIds;
  const images = parseImages(body.images, attachmentIds.length);
  if (typeof images === "string") return images;
  if (!prompt && (images.length || attachmentIds.length)) return "Images and files go with a prompt (`prompt.text`).";

  let key: string | null = null;
  if (raw.projectId !== undefined && raw.projectId !== null) {
    if (typeof raw.projectId !== "string" || !/^[\x21-\x7e]{1,255}$/.test(raw.projectId)) return "`projectId` is 1 to 255 printable characters.";
    key = raw.projectId;
  }
  const appearance = appearanceFrom(raw.appearance, icons);
  if (typeof appearance === "string") return appearance;

  return {
    prompt,
    images,
    attachmentIds,
    ...(name && { name }),
    ...(typeof body.model === "string" && { model: body.model }),
    ...(typeof body.effort === "string" && { effort: body.effort }),
    ...(fields.provider && { provider: fields.provider }),
    ...(fields.agent && { agent: fields.agent }),
    ...(fields.size && { size: fields.size as BoxSizeId }),
    ...(fields.branch && { branch: fields.branch }),
    ...(typeof body.base_branch === "string" && { startingRef: body.base_branch.trim() }),
    place,
    key,
    appearance,
  };
}

/** PATCH /v1/projects/{id} (`name`, `appearance`) as the Mission's rename
 *  (PATCH /api/missions/{id}: `title`, `icon`), or the reason it's refused.
 *  A color alone changes nothing: it's checked, and not kept. */
export function projectPatchFromCursor(raw: Record<string, unknown>, icons: readonly string[]): { title?: string; icon?: string } | string {
  if (raw.name === undefined && raw.appearance === undefined) return "Send `name`, `appearance`, or both.";
  const patch: { title?: string; icon?: string } = {};
  if (raw.name !== undefined && raw.name !== null) {
    const title = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
    if (!title || title.length > MAX_NAME) return `\`name\` is 1 to ${MAX_NAME} characters.`;
    patch.title = title;
  }
  const appearance = appearanceFrom(raw.appearance, icons);
  if (typeof appearance === "string") return appearance;
  if (appearance.icon) patch.icon = appearance.icon;
  return patch;
}

/** A Mission as Cursor's projects are answered. `icon` is its icon's key
 *  (the one picked, else the one it's shown with). */
export function cursorProjectJson(
  mission: { id: string; title: string | null; status: string; createdAt: string; updatedAt: string },
  extra: { icon: string | null; url: string },
): Record<string, unknown> {
  return {
    id: mission.id,
    name: mission.title ?? "New Mission",
    status: cursorProjectStatus(mission.status),
    appearance: { icon: extra.icon, color: "default" },
    coordinatorAgentId: mission.id,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    url: extra.url,
  };
}

/** `includeArchived` (true unless asked otherwise, as Cursor's is), or the
 *  reason it's refused. */
export function includeArchived(params: URLSearchParams): boolean | string {
  const value = params.get("includeArchived");
  if (value === null || value === "") return true;
  if (value !== "true" && value !== "false") return "`includeArchived` is true or false.";
  return value === "true";
}
