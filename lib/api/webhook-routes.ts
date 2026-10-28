/**
 * The webhook settings routes' shared part (app/api/orgs/[id]/webhooks,
 * app/api/settings/webhooks): what the page is shown, and a change to it.
 */

import { NextResponse } from "next/server";

import { webhookUrl } from "@/lib/api/webhooks";
import { recordAudit } from "@/lib/audit/record";
import type { Owner } from "@/lib/auth/owner";
import {
  recentDeliveries,
  rotateWebhookSecret,
  setWebhookEndpoint,
  webhookSettings,
  type DeliveryView,
  type WebhookScope,
} from "@/lib/db/api-webhooks";
import { savingSettings } from "@/lib/http/settings-save";

export type WebhookSettingsView = { url: string | null; secret: string; deliveries: DeliveryView[] };

export async function webhookView(who: WebhookScope): Promise<WebhookSettingsView> {
  const [settings, deliveries] = await Promise.all([webhookSettings(who), recentDeliveries(who)]);
  return { url: settings.url, secret: settings.secret, deliveries };
}

/** PUT: `{ url }` sets the endpoint (null clears it); `{ rotate: true }`
 *  replaces the signing secret. An org's changes are in its audit log. */
export async function changeWebhooks(request: Request, who: WebhookScope, by: Owner): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { url?: unknown; rotate?: unknown } | null;
  const audit = async (action: "webhook.changed" | "webhook.secret_rotated", details: Record<string, unknown> = {}) => {
    if (who.scope === "org") await recordAudit({ orgId: who.scopeId, actor: by, action, resource: { type: "webhook" }, details });
  };
  if (body?.rotate === true) {
    return savingSettings("webhooks", async () => {
      await rotateWebhookSecret(who, by.id);
      await audit("webhook.secret_rotated");
      return NextResponse.json(await webhookView(who));
    });
  }
  const url = webhookUrl(body?.url);
  if (url === undefined) {
    return NextResponse.json({ error: "Use an https URL on the public internet." }, { status: 400 });
  }
  return savingSettings("webhooks", async () => {
    await setWebhookEndpoint(who, url, by.id);
    await audit("webhook.changed", { url });
    return NextResponse.json(await webhookView(who));
  });
}
