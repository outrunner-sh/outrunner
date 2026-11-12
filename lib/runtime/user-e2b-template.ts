import {
  getSandboxSettings,
  getStoredE2b,
  setE2bTemplate,
  type SandboxSettings,
  type StoredE2b,
} from "@/lib/db/credentials";
import { BOX_IMAGE_TAG } from "@/lib/runtime/box-image";
import { e2bTemplateBuildStatus, startE2bTemplateBuild, userE2bTemplateName } from "@/lib/runtime/e2b-template";

/**
 * Outrunner's box template in a user's own E2B (Settings → Sandbox): built in
 * their account when they connect, rebuilt when Outrunner's box image moves
 * on, and followed to ready or failed whenever their settings are read.
 */

/** Start building the template in the user's E2B and record it as building;
 *  a build E2B refuses is recorded as failed, with E2B's reason. */
export async function buildUserE2bTemplate(userId: string, stored: StoredE2b): Promise<void> {
  try {
    const build = await startE2bTemplateBuild(
      { apiKey: stored.apiKey, apiUrl: stored.apiUrl ?? undefined },
      userE2bTemplateName(userId, BOX_IMAGE_TAG),
    );
    await setE2bTemplate(userId, { state: "building", ...build });
  } catch (error) {
    console.error(`Could not start an E2B template build for user ${userId}`, error);
    await setE2bTemplate(userId, { state: "failed", error: error instanceof Error ? error.message : "E2B refused the build." });
  }
}

/**
 * Move the user's template along: a build under way is asked after (ready or
 * failed), and none, or one at an older box image, is built. Best effort: a
 * build E2B can't be asked about now is asked again on the next read. A
 * failed one waits for the user to rebuild it, rather than retry forever.
 */
export async function refreshUserE2bTemplate(userId: string): Promise<void> {
  const stored = await getStoredE2b(userId);
  if (!stored) return;
  if (stored.template === "none" || stored.template === "outdated") return buildUserE2bTemplate(userId, stored);
  if (stored.template !== "building" || !stored.templateId || !stored.templateBuildId) return;
  try {
    const status = await e2bTemplateBuildStatus(
      { apiKey: stored.apiKey, apiUrl: stored.apiUrl ?? undefined },
      { templateId: stored.templateId, buildId: stored.templateBuildId, tag: BOX_IMAGE_TAG },
    );
    if (status.state !== "building") await setE2bTemplate(userId, status);
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
  await refreshUserE2bTemplate(userId);
  return getSandboxSettings(userId);
}
