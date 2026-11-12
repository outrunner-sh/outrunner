import {
  claimE2bTemplateBuild,
  getSandboxSettings,
  getStoredE2b,
  setE2bTemplate,
  type SandboxSettings,
  type StoredE2b,
} from "@/lib/db/credentials";
import {
  deleteOtherUserE2bTemplates,
  E2B_TEMPLATE_TAG,
  e2bTemplateBuildStatus,
  startE2bTemplateBuild,
  userE2bTemplateName,
} from "@/lib/runtime/e2b-template";

/**
 * Outrunner's box template in a user's own E2B (Settings → Sandbox): built in
 * their account when they connect, rebuilt when Outrunner's box image moves
 * on, and followed to ready or failed whenever their settings are read. Each
 * build is claimed first, so only one runs at a time in their paid account.
 */

/** E2B's API for the user's account. */
function targetOf(stored: StoredE2b) {
  return { apiKey: stored.apiKey, apiUrl: stored.apiUrl ?? undefined, user: true };
}

/**
 * Build the template in the user's E2B, if this caller wins the claim: none
 * there, one at an older image, a claim gone stale, or (`retryFailed`, an
 * explicit rebuild) a failed one. Its start is recorded under the claim; a
 * build E2B refuses is recorded as failed, with E2B's reason. Returns whether
 * this caller started one.
 */
export async function buildUserE2bTemplate(
  userId: string,
  stored: StoredE2b,
  { retryFailed = false }: { retryFailed?: boolean } = {},
): Promise<boolean> {
  const claimedAt = await claimE2bTemplateBuild(userId, E2B_TEMPLATE_TAG, { retryFailed });
  if (!claimedAt) return false;
  try {
    const build = await startE2bTemplateBuild(targetOf(stored), userE2bTemplateName(userId, E2B_TEMPLATE_TAG));
    await setE2bTemplate(userId, { state: "building", claimedAt, templateId: build.templateId, buildId: build.buildId });
  } catch (error) {
    console.error(`Could not start an E2B template build for user ${userId}`, error);
    await setE2bTemplate(userId, {
      state: "failed",
      claimedAt,
      error: error instanceof Error ? error.message : "E2B refused the build.",
    });
  }
  return true;
}

/**
 * Move the user's template along: a build under way is asked after (ready or
 * failed, written only onto that build), and none, one at an older image, or
 * a stale claim is built. Once ready, older templates are deleted from their
 * account. Best effort: a build E2B can't be asked about now is asked again
 * on the next read. A failed one waits for the user to rebuild it.
 */
export async function refreshUserE2bTemplate(userId: string): Promise<void> {
  const stored = await getStoredE2b(userId);
  if (!stored) return;
  if (stored.template === "none" || stored.template === "outdated" || (stored.template === "building" && !stored.templateBuildId)) {
    await buildUserE2bTemplate(userId, stored);
    return;
  }
  if (stored.template !== "building" || !stored.templateId || !stored.templateBuildId) return;
  const build = { templateId: stored.templateId, buildId: stored.templateBuildId, tag: E2B_TEMPLATE_TAG };
  try {
    const status = await e2bTemplateBuildStatus(targetOf(stored), build);
    if (status.state === "building") return;
    const landed = await setE2bTemplate(
      userId,
      status.state === "ready"
        ? { state: "ready", buildId: build.buildId, templateId: build.templateId }
        : { ...status, buildId: build.buildId },
    );
    if (landed && status.state === "ready") await deleteOtherUserE2bTemplates(targetOf(stored), userId, build.templateId);
  } catch (error) {
    console.warn(`Could not check user ${userId}'s E2B template build`, error);
  }
}

/** The user's sandbox settings, their E2B template moved along first when
 *  that's where their sessions run and it isn't ready: what to read before
 *  starting a session there. */
export async function currentSandboxSettings(userId: string): Promise<SandboxSettings> {
  const settings = await getSandboxSettings(userId);
  if (settings.sandbox !== "e2b" || !settings.e2b?.connected || settings.e2b.template === "ready") return settings;
  // A rebuild under way (or failed) while an earlier template is served is
  // still moved along: the build is checked on, and an image bump started.
  await refreshUserE2bTemplate(userId);
  return getSandboxSettings(userId);
}
