/**
 * Email, when the deployment has a sender: Resend's API, with RESEND_API_KEY
 * and EMAIL_FROM (e.g. "Outrunner <hello@outrunner.dev>"). Without them
 * nothing is sent and callers carry on: an invite's link is shown to the
 * admin to share, and a request to join waits on the members page.
 */

import { optionalEnv } from "@/lib/env";

export type Email = { to: string[]; subject: string; text: string };

/** Whether the deployment can send email. */
export function canSendEmail(): boolean {
  return Boolean(optionalEnv("RESEND_API_KEY") && optionalEnv("EMAIL_FROM"));
}

/** Send `email`; false when the deployment can't, or Resend refused it. Never
 *  throws: email is never the thing that fails an action. */
export async function sendEmail(email: Email): Promise<boolean> {
  const key = optionalEnv("RESEND_API_KEY");
  const from = optionalEnv("EMAIL_FROM");
  if (!key || !from || email.to.length === 0) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: email.to, subject: email.subject, text: email.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error("Resend refused an email", { status: response.status });
    return response.ok;
  } catch (error) {
    console.error("Could not send an email", error);
    return false;
  }
}
