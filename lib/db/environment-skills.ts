/**
 * A project's skills (20261103130000_environment_skills.sql): skills.sh
 * catalog skills enabled on it, and GitHub repositories kept as its skill
 * registries. Every new session of the project gets them on its box
 * (lib/runtime/session-setup.ts), for Claude Code and Codex.
 *
 * Access is the project's (lib/db/environments.ts): reading needs read on
 * the project, changing it write (else EnvironmentAccessError). A change
 * moves the project's setup on a generation, as a change to its variables
 * does, so its ready boxes are made again. Service role only.
 */

import { bumpGeneration, EnvironmentAccessError } from "@/lib/db/environments";
import { environmentLevel } from "@/lib/db/org-access";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { type CatalogSkill, MAX_REGISTRIES, MAX_SKILLS } from "@/lib/environments/skills";
import { type AccessLevel, allows } from "@/lib/orgs/access";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A catalog skill enabled on a project. */
export type EnvironmentSkill = CatalogSkill & { id: string; createdAt: string; updatedAt: string };

/** A GitHub repository whose skills a project's sessions get. */
export type SkillRegistry = {
  id: string;
  fullName: string;
  /** The branch its skills are read from: its default when added. */
  defaultBranch: string;
  private: boolean;
  createdAt: string;
  updatedAt: string;
};

/** The project has that skill, or that registry, already. */
export class SkillConflictError extends Error {}

/** The project's skills and registries, or null when the user can't read
 *  it. None before the migration that adds them. */
export async function listEnvironmentSkills(
  userId: string,
  environmentId: string,
): Promise<{ orgId: string; access: AccessLevel; skills: EnvironmentSkill[]; registries: SkillRegistry[] } | null> {
  const access = await environmentLevel(userId, environmentId);
  if (!access) return null;
  const supabase = createSupabaseAdminClient();
  const { data: environment, error } = await supabase
    .from("environments")
    .select("org_id")
    .eq("id", environmentId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!environment) return null;
  const [skills, registries] = await Promise.all([
    supabase
      .from("environment_skills")
      .select("id, slug, name, source, skill, created_at, updated_at")
      .eq("environment_id", environmentId)
      .order("created_at", { ascending: true }),
    supabase
      .from("environment_skill_registries")
      .select("id, full_name, default_branch, private, created_at, updated_at")
      .eq("environment_id", environmentId)
      .order("created_at", { ascending: true }),
  ]);
  for (const { error: readError } of [skills, registries]) {
    if (readError && probeStatus(readError) === "missing") return { orgId: environment.org_id, access, skills: [], registries: [] };
    if (readError) throw readError;
  }
  return {
    orgId: environment.org_id,
    access,
    skills: (skills.data ?? []).map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      source: r.source,
      skill: r.skill,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    registries: (registries.data ?? []).map((r) => ({
      id: r.id,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  };
}

/** Throw unless `userId` may change the project. */
async function requireWrite(userId: string, environmentId: string): Promise<void> {
  if (!allows(await environmentLevel(userId, environmentId), "write")) throw new EnvironmentAccessError();
}

/** Enable a catalog skill on the project (already checked by catalogSkill).
 *  Refused past MAX_SKILLS, and as a conflict when it's enabled already. */
export async function enableEnvironmentSkill(userId: string, environmentId: string, skill: CatalogSkill): Promise<EnvironmentSkill> {
  await requireWrite(userId, environmentId);
  const supabase = createSupabaseAdminClient();
  const { count, error: countError } = await supabase
    .from("environment_skills")
    .select("id", { count: "exact", head: true })
    .eq("environment_id", environmentId);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_SKILLS) throw new EnvironmentRuleError(`A project holds at most ${MAX_SKILLS} skills from the catalog.`);
  const { data, error } = await supabase
    .from("environment_skills")
    .insert({ environment_id: environmentId, slug: skill.slug, name: skill.name, source: skill.source, skill: skill.skill, created_by: userId })
    .select("id, created_at, updated_at")
    .single();
  if (error?.code === "23505") throw new SkillConflictError(`${skill.name} is enabled on this project already.`);
  if (error) throw error;
  await bumpGeneration(userId, environmentId);
  return { ...skill, id: data.id, createdAt: data.created_at, updatedAt: data.updated_at };
}

/** Disable one of the project's catalog skills; false when it has none by
 *  that id. */
export async function disableEnvironmentSkill(userId: string, environmentId: string, skillId: string): Promise<boolean> {
  await requireWrite(userId, environmentId);
  const { data, error } = await createSupabaseAdminClient()
    .from("environment_skills")
    .delete()
    .eq("environment_id", environmentId)
    .eq("id", skillId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) return false;
  await bumpGeneration(userId, environmentId);
  return true;
}

/** Keep a GitHub repository as the project's registry (found on GitHub by
 *  the caller first). Refused past MAX_REGISTRIES, and as a conflict when
 *  it's one already. */
export async function addSkillRegistry(
  userId: string,
  environmentId: string,
  repo: { fullName: string; defaultBranch: string; private: boolean },
): Promise<SkillRegistry> {
  await requireWrite(userId, environmentId);
  const supabase = createSupabaseAdminClient();
  const { count, error: countError } = await supabase
    .from("environment_skill_registries")
    .select("id", { count: "exact", head: true })
    .eq("environment_id", environmentId);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_REGISTRIES) throw new EnvironmentRuleError(`A project holds at most ${MAX_REGISTRIES} skill registries.`);
  const { data, error } = await supabase
    .from("environment_skill_registries")
    .insert({
      environment_id: environmentId,
      full_name: repo.fullName,
      default_branch: repo.defaultBranch,
      private: repo.private,
      created_by: userId,
    })
    .select("id, created_at, updated_at")
    .single();
  if (error?.code === "23505") throw new SkillConflictError(`${repo.fullName} is one of this project's registries already.`);
  if (error) throw error;
  await bumpGeneration(userId, environmentId);
  return { ...repo, id: data.id, createdAt: data.created_at, updatedAt: data.updated_at };
}

/** Remove one of the project's registries; false when it has none by that
 *  id. */
export async function removeSkillRegistry(userId: string, environmentId: string, registryId: string): Promise<boolean> {
  await requireWrite(userId, environmentId);
  const { data, error } = await createSupabaseAdminClient()
    .from("environment_skill_registries")
    .delete()
    .eq("environment_id", environmentId)
    .eq("id", registryId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) return false;
  await bumpGeneration(userId, environmentId);
  return true;
}
