import { optionalEnv } from "@/lib/env";

/** The cookie holding the sign-in's nonce: the browser that started it must
 *  be the one that comes back. */
export const SLACK_SIGNIN_COOKIE = "outrunner_slack_signin";
export const SLACK_SIGNIN_PATH = "/api/integrations/slack/oauth";

/** What Sign in with Slack needs from the deployment; null when any is unset. */
export function slackSignInConfig(): { clientId: string; clientSecret: string; secret: string; redirectUri: string } | null {
  const clientId = optionalEnv("SLACK_CLIENT_ID");
  const clientSecret = optionalEnv("SLACK_CLIENT_SECRET");
  const secret = optionalEnv("SLACK_SIGNING_SECRET");
  const base = optionalEnv("RUNTIME_BASE_URL");
  if (!clientId || !clientSecret || !secret || !base) return null;
  try {
    return { clientId, clientSecret, secret, redirectUri: new URL(SLACK_SIGNIN_PATH, base).toString() };
  } catch {
    return null;
  }
}
