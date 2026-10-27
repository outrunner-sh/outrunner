"use server";

import { redirect } from "next/navigation";

import { getOwner } from "@/lib/auth/owner";
import { saveSlackLink } from "@/lib/db/slack-links";
import { optionalEnv } from "@/lib/env";
import { verifyLinkToken } from "@/lib/slack/slack";

/**
 * The user confirmed on /slack/link: their Slack user is them from now on.
 * The token is checked again here, since the form is the browser's to change.
 */
export async function confirmSlackLink(formData: FormData) {
  const token = formData.get("t")?.toString() ?? "";
  const identity = verifyLinkToken(token, optionalEnv("SLACK_SIGNING_SECRET") ?? "");
  if (!identity) redirect(`/slack/link?t=${encodeURIComponent(token)}`);
  const owner = await getOwner();
  if (!owner) redirect("/signin");
  await saveSlackLink(identity, owner.id);
  redirect("/settings/integrations?slack=linked");
}
