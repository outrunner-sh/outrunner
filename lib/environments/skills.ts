/**
 * The rules a project's skills are kept to (20261103130000_environment_skills.sql):
 * a skill picked from the skills.sh catalog, installed from the GitHub
 * repository the catalog names, and a registry, a GitHub repository whose
 * every skill installs. A skill is a folder holding a SKILL.md, as Claude
 * Code and Codex both read them; the box finds them in a repository the same
 * way (runtime-agent/internal/workspace/skills.go), so what the page lists
 * is what a session gets.
 *
 * Pure (no Node, no database), so the page, the routes and the tests share
 * it.
 */

import { EnvironmentRuleError } from "@/lib/environments/rules";
import { isGitHubFullName } from "@/lib/github/listing";
import type { SkillSource } from "@/lib/runtime/agent-protocol";

/** Catalog skills a project holds at most, and registries: each is a
 *  download on every new session's box (the box takes 50 repositories). */
export const MAX_SKILLS = 40;
export const MAX_REGISTRIES = 10;

/** A skill's name, as the box installs it (a folder of ~/.claude/skills). */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** How deep in a repository a skill is looked for, as the box does. */
const MAX_DEPTH = 6;

/** Folders never looked in for a skill: the box skips them too. */
const SKIPPED = new Set([".git", "node_modules", ".next", "dist", "build", "target", ".venv", "__pycache__"]);

/** A catalog skill as a project keeps it. */
export type CatalogSkill = {
  /** The catalog's id: owner/repo/skill. */
  slug: string;
  name: string;
  /** The GitHub repository it installs from, owner/repo. */
  source: string;
  /** Its name in that repository. */
  skill: string;
};

/**
 * A catalog result picked to enable, checked: its slug is its repository and
 * its name in it. The catalog lists skills from places that aren't GitHub
 * (a site's own well-known address); Outrunner installs from GitHub only.
 */
export function catalogSkill(input: { name?: unknown; slug?: unknown; source?: unknown }): CatalogSkill {
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  const source = typeof input.source === "string" ? input.source.trim() : "";
  if (!slug || !source) throw new EnvironmentRuleError("Pick a skill from the catalog: it needs its slug and source.");
  if (!isGitHubFullName(source)) {
    throw new EnvironmentRuleError(`${source} isn't a GitHub repository. Outrunner installs skills from GitHub only.`);
  }
  const skill = slug.startsWith(`${source}/`) ? slug.slice(source.length + 1) : "";
  if (!SKILL_NAME.test(skill)) throw new EnvironmentRuleError(`${slug} isn't a skill of ${source}.`);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 200) : skill;
  return { slug, name, source, skill };
}

/**
 * A GitHub repository given as a registry, as `owner/name`: the name alone,
 * or its address as GitHub's page, a clone URL or SSH shows it.
 */
export function registryRepo(input: unknown): string {
  const text = typeof input === "string" ? input.trim() : "";
  const match =
    /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^\s]*)?\/?$/i.exec(
      text,
    );
  const fullName = match ? `${match[1]}/${match[2]}` : "";
  if (!isGitHubFullName(fullName)) {
    throw new EnvironmentRuleError("Give the registry as a GitHub repository: owner/name, or its github.com address.");
  }
  return fullName;
}

/** A SKILL.md's front matter: its name and description, where it has them.
 *  Top-level keys only (a nested `name:` under another key is that key's),
 *  the last of each where there are several, as the box reads the name
 *  (runtime-agent/internal/workspace/skills.go skillManifestName). */
export function skillFrontMatter(text: string): { name: string | null; description: string | null } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { name: null, description: null };
  let name: string | null = null;
  let description: string | null = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    if (field[1] === "name") name = value || null;
    else description = value && value !== "|" && value !== ">" ? value.slice(0, 500) : null;
  }
  return { name, description };
}

/** A skill's folder in a repository: where its SKILL.md is, and the
 *  folder's own name. */
export type SkillFolder = { path: string; folder: string };

/** The skills in a repository from its files' paths: each folder holding a
 *  SKILL.md, not inside another skill, not in a folder the box skips. */
export function skillFoldersIn(paths: string[]): SkillFolder[] {
  const dirs = paths
    .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
    .map((p) => p.slice(0, -"SKILL.md".length).replace(/\/$/, ""))
    .filter((dir) => {
      const parts = dir ? dir.split("/") : [];
      return parts.length <= MAX_DEPTH && !parts.some((part) => SKIPPED.has(part));
    })
    .sort();
  const found: SkillFolder[] = [];
  for (const dir of dirs) {
    // A skill's own folders aren't looked in; the root's are.
    if (found.some((f) => f.path !== "" && dir.startsWith(`${f.path}/`))) continue;
    found.push({ path: dir, folder: dir.split("/").pop() ?? "" });
  }
  // A repository that is a skill and holds others is taken for a collection
  // of them, as the box does: its root would copy every one of them twice.
  return found.length > 1 && found[0].path === "" ? found.slice(1) : found;
}

/** A skill folder's SKILL.md. */
export function skillManifest(folder: string): string {
  return folder ? `${folder}/SKILL.md` : "SKILL.md";
}

/** The name a skill installs as: its SKILL.md's, else its folder's. Null
 *  when neither can be a folder's name (the box skips it). */
export function installName(frontMatterName: string | null, folder: string): string | null {
  if (frontMatterName && SKILL_NAME.test(frontMatterName)) return frontMatterName;
  return SKILL_NAME.test(folder) ? folder : null;
}

/** What a repository has committed for its agents, as the page lists it. */
export type CommittedKind = "skill" | "agent" | "command";

/** The skills, subagents and commands a repository commits for Claude Code
 *  and Codex, from its files' paths. They come with the checkout: listed,
 *  never installed. */
export function committedItems(paths: string[]): { path: string; kind: CommittedKind; framework: "claude" | "codex" }[] {
  const items: { path: string; kind: CommittedKind; framework: "claude" | "codex" }[] = [];
  for (const path of paths) {
    const parts = path.split("/");
    if (parts.length === 4 && parts[0] === ".claude" && parts[1] === "skills" && parts[3] === "SKILL.md") {
      items.push({ path: parts.slice(0, 3).join("/"), kind: "skill", framework: "claude" });
    } else if (parts.length === 4 && parts[0] === ".agents" && parts[1] === "skills" && parts[3] === "SKILL.md") {
      items.push({ path: parts.slice(0, 3).join("/"), kind: "skill", framework: "codex" });
    } else if (parts.length === 3 && parts[0] === ".claude" && parts[1] === "agents" && path.endsWith(".md")) {
      items.push({ path, kind: "agent", framework: "claude" });
    } else if (parts.length >= 3 && parts[0] === ".claude" && parts[1] === "commands" && path.endsWith(".md")) {
      items.push({ path, kind: "command", framework: "claude" });
    }
  }
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

/** A registry as a session's setup takes it: the token reads a private one. */
export type RegistrySource = { fullName: string; branch: string; token?: string };

/**
 * What a new session's box downloads (POST /skills): a registry's
 * repository whole, and each other repository for the catalog skills picked
 * from it. A catalog skill of a repository that is also a registry comes
 * with the registry's.
 */
export function skillSources(skills: CatalogSkill[], registries: RegistrySource[]): SkillSource[] {
  const sources: SkillSource[] = [];
  const registryRepos = new Set(registries.map((r) => r.fullName.toLowerCase()));
  const picked = new Map<string, SkillSource & { skills: string[] }>();
  for (const skill of skills) {
    const key = skill.source.toLowerCase();
    if (registryRepos.has(key)) continue;
    const source = picked.get(key) ?? { repo: skill.source, skills: [] };
    if (!source.skills.includes(skill.skill)) source.skills.push(skill.skill);
    picked.set(key, source);
  }
  sources.push(...picked.values());
  for (const registry of registries) {
    sources.push({ repo: registry.fullName, ref: registry.branch, ...(registry.token && { token: registry.token }) });
  }
  return sources;
}
