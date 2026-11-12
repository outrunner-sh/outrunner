/**
 * The Outrunner GitHub App on a user's own GitHub account, for their personal
 * org: what connecting GitHub in Settings → Connections sets up beside the
 * App's user authorization. Installing it is where GitHub has them pick All
 * or Selected repositories; linking it to their personal org (the same
 * org_github_installations link an admin's install makes, claimInstallation)
 * gives that org the App's own tokens too, for boxes' per-repository reads and
 * for working as the App.
 */

import {
  ClaimError,
  claimInstallation,
  installationHolder,
  recordInstalled,
} from "@/lib/db/github-installations";
import { personalOrgId } from "@/lib/db/orgs";
import { listUserInstallations, ownInstallation, type UserInstallation } from "@/lib/github/user-auth";

/** What's left to do: install the App on their account, or nothing. */
export type OwnInstallationOutcome = { next: "install"; orgId: string } | { next: "done"; installation: UserInstallation | null };

/**
 * Link the App's installation on the user's own account to their personal
 * org, if they have one and it isn't linked yet; or say it's to be installed.
 * As the account's owner (its installer, with their verified GitHub id) the
 * database links it as their own even when another org already has it.
 * Best-effort past that: a link the database refuses leaves the connection
 * working as it is.
 */
export async function linkOwnInstallation(
  user: { id: string },
  github: { id: number; login: string },
  token: string,
): Promise<OwnInstallationOutcome> {
  const orgId = await personalOrgId(user.id);
  const installations = await listUserInstallations(token).catch((error: unknown) => {
    console.warn(`Couldn't list user ${user.id}'s GitHub App installations`, error instanceof Error ? error.message : error);
    return null;
  });
  if (!installations) return { next: "done", installation: null };
  const own = ownInstallation(installations, github.id);
  if (!own) return orgId ? { next: "install", orgId } : { next: "done", installation: null };
  if (!orgId) return { next: "done", installation: own };

  let holder = await installationHolder(own.id);
  if (!holder) {
    // Its webhook missed or still on its way. Only an account's owner can
    // install an App on a user account, so they're its installer.
    await recordInstalled(own, github);
    holder = await installationHolder(own.id);
  }
  if (!holder || holder.orgIds.includes(orgId)) return { next: "done", installation: own };
  try {
    await claimInstallation({ orgId, installation: own, githubId: github.id, userId: user.id });
  } catch (error) {
    if (!(error instanceof ClaimError)) throw error;
    console.warn(`Not linking installation ${own.id} to user ${user.id}'s personal org: ${error.reason}`);
  }
  return { next: "done", installation: own };
}
