import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwner } from "@/lib/auth/owner";
import { getPreferences, savePreferences } from "@/lib/db/notification-preferences";
import { listSlackLinks } from "@/lib/db/slack-links";
import { canSendEmail } from "@/lib/email/send";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { NOTIFICATION_KINDS } from "@/lib/notifications/events";

const Change = z
  .object({
    browser: z.boolean().optional(),
    email: z.enum(["off", "instant", "digest"]).optional(),
    slack: z.boolean().optional(),
    kinds: z.array(z.enum(NOTIFICATION_KINDS)).max(NOTIFICATION_KINDS.length).optional(),
  })
  .refine((change) => Object.keys(change).length > 0, "Say what to change.");

/**
 * The user's notification preferences (Settings → Account): GET them, with
 * whether this deployment can send email and whether their Slack is linked
 * (each a channel that can't be turned on otherwise); PUT a change.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const [preferences, links] = await Promise.all([getPreferences(owner.id), listSlackLinks(owner.id).catch(() => [])]);
  return NextResponse.json({ preferences, emailAvailable: canSendEmail(), slackLinked: links.length > 0 });
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const parsed = Change.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That isn't a notification setting." }, { status: 400 });
  // What the page offers, held here too: what's saved never says more than
  // can be sent (and Slack doesn't start the moment it's linked).
  if (parsed.data.email && parsed.data.email !== "off" && !canSendEmail()) {
    return NextResponse.json({ error: "This deployment doesn't send email." }, { status: 400 });
  }
  if (parsed.data.slack) {
    // A failed read isn't "not linked": the user is told to try again.
    const links = await listSlackLinks(owner.id).catch(() => null);
    if (links === null) {
      return NextResponse.json({ error: "Couldn't check your Slack link. Try again." }, { status: 503 });
    }
    if (links.length === 0) {
      return NextResponse.json({ error: "Link your Slack account in Connections first." }, { status: 400 });
    }
  }
  return savingSettings("notification preferences", async () => {
    const { kinds, ...rest } = parsed.data;
    const preferences = await savePreferences(owner.id, { ...rest, ...(kinds && { kinds: [...new Set(kinds)] }) });
    return NextResponse.json({ preferences });
  });
}
