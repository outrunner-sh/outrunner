"use server";

import { revalidatePath } from "next/cache";

import { getOwner } from "@/lib/auth/owner";
import { deleteSlackLink } from "@/lib/db/slack-links";

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
