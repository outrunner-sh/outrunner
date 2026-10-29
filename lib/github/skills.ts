/**
 * Reading skills where they are kept: the skills.sh catalog's search, and a
 * GitHub repository's tree and SKILL.md files, for the project page's lists
 * (lib/environments/skills.ts has the rules). Nothing here installs one: a
 * session's box downloads the repositories itself
 * (runtime-agent/internal/workspace/skills.go).
 *
 * Takes its fetch, so tests pass their own; no server imports.
 */

import { mapWithConcurrency } from "@/lib/concurrency";
import {
  committedItems,
  type CommittedKind,
  installName,
  skillFoldersIn,
  skillFrontMatter,
  skillManifest,
} from "@/lib/environments/skills";

type Fetch = typeof fetch;

const CATALOG = "https://skills.sh/api/search";
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** How many SKILL.md files a listing reads for their names and
 *  descriptions; a repository of more lists the rest by folder. */
const MAX_DESCRIBED = 60;

/** A catalog result. `github` is false for one from elsewhere, which
 *  Outrunner can't install. */
export type CatalogResult = { name: string; slug: string; source: string; installs: number; github: boolean };

/** skills.sh couldn't be searched just now. */
export class SkillCatalogError extends Error {
  constructor() {
    super("The skills.sh catalog couldn't be searched just now. Try again.");
  }
}

/** Search skills.sh for `query`, most installed first as it ranks them. */
export async function searchSkillCatalog(query: string, limit = 20, doFetch: Fetch = fetch): Promise<CatalogResult[]> {
  const url = `${CATALOG}?${new URLSearchParams({ q: query, limit: String(limit) })}`;
  let data: { skills?: unknown };
  try {
    const response = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new SkillCatalogError();
    data = (await response.json()) as { skills?: unknown };
  } catch {
    throw new SkillCatalogError();
  }
  if (!Array.isArray(data.skills)) return [];
  return data.skills.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.source !== "string") return [];
    const name = typeof r.name === "string" && r.name ? r.name : typeof r.skillId === "string" ? r.skillId : r.id;
    const installs = typeof r.installs === "number" && Number.isFinite(r.installs) ? r.installs : 0;
    return [{ name, slug: r.id, source: r.source, installs, github: /^[^/.]+\/[^/]+$/.test(r.source) }];
  });
}

function headers(token: string | null | undefined): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

/** A repository's files' paths on `ref`, or null when GitHub won't say
 *  (gone, or not readable with the token). GitHub cuts a tree of very many
 *  files short; what it gave is listed. */
export async function repositoryPaths(
  token: string | null | undefined,
  fullName: string,
  ref: string,
  doFetch: Fetch = fetch,
): Promise<string[] | null> {
  try {
    const response = await doFetch(`${API}/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: headers(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const tree = (await response.json()) as { tree?: { path?: unknown; type?: unknown }[] };
    return (tree.tree ?? []).flatMap((e) => (e.type === "blob" && typeof e.path === "string" ? [e.path] : []));
  } catch {
    return null;
  }
}

/** A file's text on `ref`, or null. Without a token, from GitHub's raw
 *  files rather than its API, whose limit for a caller without one (60 an
 *  hour, for the whole server) a registry's listing would spend at once. */
async function fileText(token: string | null | undefined, fullName: string, ref: string, path: string, doFetch: Fetch): Promise<string | null> {
  try {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const url = token
      ? `${API}/repos/${fullName}/contents/${encoded}?ref=${encodeURIComponent(ref)}`
      : `${RAW}/${fullName}/${encodeURIComponent(ref)}/${encoded}`;
    const response = await doFetch(url, {
      headers: token ? { ...headers(token), Accept: "application/vnd.github.raw+json" } : {},
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? (await response.text()).slice(0, 64 * 1024) : null;
  } catch {
    return null;
  }
}

/** A skill found in a repository, as the page lists it. */
export type ListedSkill = {
  /** What it installs as. */
  name: string;
  description: string | null;
  /** Its folder in the repository ("" for a repository that is one). */
  path: string;
  htmlUrl: string;
};

function treeUrl(fullName: string, ref: string, path: string): string {
  return `https://github.com/${fullName}/tree/${ref}${path ? `/${path}` : ""}`;
}

/** The skills a registry's repository holds on `ref`, as its box would
 *  install them; null when GitHub won't list it. */
export async function registrySkills(
  token: string | null | undefined,
  fullName: string,
  ref: string,
  doFetch: Fetch = fetch,
): Promise<ListedSkill[] | null> {
  const paths = await repositoryPaths(token, fullName, ref, doFetch);
  if (!paths) return null;
  const folders = skillFoldersIn(paths);
  const listed = await mapWithConcurrency(folders, 6, async (folder) => {
    const text = folders.indexOf(folder) < MAX_DESCRIBED ? await fileText(token, fullName, ref, skillManifest(folder.path), doFetch) : null;
    const front = text ? skillFrontMatter(text) : { name: null, description: null };
    const name = installName(front.name, folder.folder);
    return name ? [{ name, description: front.description, path: folder.path, htmlUrl: treeUrl(fullName, ref, folder.path) }] : [];
  });
  return listed.flat();
}

/** A skill, subagent or command a repository commits for its agents. */
export type CommittedItem = {
  name: string;
  description: string | null;
  path: string;
  kind: CommittedKind;
  framework: "claude" | "codex";
  htmlUrl: string;
};

/** What a repository commits for Claude Code and Codex on `ref`; null when
 *  GitHub won't list it. */
export async function committedSkills(
  token: string | null | undefined,
  fullName: string,
  ref: string,
  doFetch: Fetch = fetch,
): Promise<CommittedItem[] | null> {
  const paths = await repositoryPaths(token, fullName, ref, doFetch);
  if (!paths) return null;
  const items = committedItems(paths);
  return mapWithConcurrency(items, 6, async (item) => {
    const file = item.kind === "skill" ? skillManifest(item.path) : item.path;
    const text = items.indexOf(item) < MAX_DESCRIBED ? await fileText(token, fullName, ref, file, doFetch) : null;
    const front = text ? skillFrontMatter(text) : { name: null, description: null };
    const base = item.path.split("/").pop() ?? item.path;
    return {
      ...item,
      name: front.name ?? (item.kind === "skill" ? base : base.replace(/\.md$/, "")),
      description: front.description,
      htmlUrl: `https://github.com/${fullName}/${item.kind === "skill" ? "tree" : "blob"}/${ref}/${item.path}`,
    };
  });
}

/** A public repository as GitHub shows anyone, or null: for a registry when
 *  the org has no way of its own to GitHub. */
export async function publicRepository(
  fullName: string,
  doFetch: Fetch = fetch,
): Promise<{ fullName: string; defaultBranch: string; private: boolean } | null> {
  try {
    const response = await doFetch(`${API}/repos/${fullName}`, { headers: headers(null), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const repo = (await response.json()) as { full_name?: unknown; default_branch?: unknown; private?: unknown };
    if (typeof repo.full_name !== "string" || typeof repo.default_branch !== "string") return null;
    return { fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private === true };
  } catch {
    return null;
  }
}
