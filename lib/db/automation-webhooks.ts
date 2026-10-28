/**
 * Automations' webhook tokens (supabase/migrations/20261102195000_automation_webhooks.sql):
 * found by their hash when a request comes in, read again (unsealed) for the
 * org's admins to copy, and rotated. The table is the server's alone.
 */

import { newWebhookToken, webhookPath, webhookTokenHash } from "@/lib/automations/webhook";
import { open, seal } from "@/lib/crypto/secret-box";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A new token as it's saved: hashed, to find it by, and sealed. */
export function webhookTokenSettings(token = newWebhookToken()): { hash: string; sealed: string } {
  return { hash: webhookTokenHash(token), sealed: seal(token) };
}

/** The automation a token is, whether it takes webhooks now, and whether
 *  its org is a personal one (whose runs' sessions are its owner's to open);
 *  null for a token that's no automation's. */
export async function webhookAutomation(
  token: string,
): Promise<{ automationId: string; orgId: string; live: boolean; personal: boolean } | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("automations")
    .select("id, org_id, enabled, triggers")
    .eq("webhook_token_hash", webhookTokenHash(token))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("personal_owner_id")
    .eq("id", data.org_id)
    .maybeSingle();
  if (orgError) throw orgError;
  return {
    automationId: data.id,
    orgId: data.org_id,
    live: data.enabled && data.triggers.includes("webhook"),
    personal: Boolean(org?.personal_owner_id),
  };
}

/** Where an automation of the org's takes webhooks: its path; or none yet;
 *  or a token kept that can't be unsealed (CREDENTIALS_ENCRYPTION_KEY
 *  changed), which only a new one fixes. */
export type WebhookUrl = { path: string } | { path: null; unreadable: boolean };

export async function webhookPathOf(orgId: string, automationId: string): Promise<WebhookUrl> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automations")
    .select("webhook_token_sealed")
    .eq("org_id", orgId)
    .eq("id", automationId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.webhook_token_sealed) return { path: null, unreadable: false };
  try {
    return { path: webhookPath(open(data.webhook_token_sealed)) };
  } catch (cause) {
    console.error(`Automation ${automationId}: its webhook token can't be unsealed`, cause);
    return { path: null, unreadable: true };
  }
}

/** Give an automation of the org's a new token: the old URL stops working at
 *  once. The new path; null when the org has no such automation. */
export async function rotateWebhookToken(orgId: string, automationId: string): Promise<string | null> {
  const token = newWebhookToken();
  const { hash, sealed } = webhookTokenSettings(token);
  const { data, error } = await createSupabaseAdminClient()
    .from("automations")
    .update({ webhook_token_hash: hash, webhook_token_sealed: sealed })
    .eq("org_id", orgId)
    .eq("id", automationId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0 ? webhookPath(token) : null;
}

/** The runs a key recorded for an automation: a retried request's, to
 *  answer as the first was answered. */
export async function runsByKey(
  automationId: string,
  dedupeKey: string,
): Promise<{ runId: string; projectId: string; workspaceId: string | null; status: string; reason: string | null }[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .select("id, project_id, workspace_id, status, reason")
    .eq("automation_id", automationId)
    .eq("dedupe_key", dedupeKey);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    runId: r.id,
    projectId: r.project_id,
    workspaceId: r.workspace_id,
    status: r.status,
    reason: r.reason,
  }));
}
