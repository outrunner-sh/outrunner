"use server";

import { revalidatePath } from "next/cache";

import { getOwner } from "@/lib/auth/owner";
import { deleteSlackLink } from "@/lib/db/slack-links";
import { deleteTrackerLink } from "@/lib/db/trackers";

/** Unlink one of the signed-in user's Linear or Jira accounts: issues and comments from
 *  it stop being theirs here. */
export async function unlinkTracker(formData: FormData) {
  const owner = await getOwner();
  if (!owner) return;
  const installationId = formData.get("installation")?.toString() ?? "";
  const externalUserId = formData.get("user")?.toString() ?? "";
  if (!installationId || !externalUserId) return;
  await deleteTrackerLink(owner.id, installationId, externalUserId);
  revalidatePath("/settings/integrations");
}

/** Unlink one of the signed-in user's Slack users: what they send stops
 *  landing in this triage. */
export async function unlinkSlack(formData: FormData) {
  const owner = await getOwner();
  if (!owner) return;
  const teamId = formData.get("team")?.toString() ?? "";
  const userId = formData.get("user")?.toString() ?? "";
  if (!teamId || !userId) return;
  await deleteSlackLink(owner.id, teamId, userId);
  revalidatePath("/settings/integrations");
}
