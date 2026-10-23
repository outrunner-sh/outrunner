/**
 * The check a Claude subscription token gets before it's saved, wherever it
 * comes from (Settings → Claude, the Mac app, `outrunner claude`).
 *
 * setup-token output is an opaque OAuth token; the check is permissive so a
 * format change upstream never blocks a valid token — it only guards obvious
 * junk. An invalid token surfaces at sandbox launch, not here.
 */

const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 500;

/** The token, trimmed, or what's wrong with it, for the user to read. */
export function checkClaudeToken(raw: unknown): { token: string } | { error: string } {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    return { error: "That doesn't look like a Claude token. Paste the value from `claude setup-token`." };
  }
  // An API key is the Anthropic provider's (lib/providers/claude-slot.ts).
  if (token.startsWith("sk-ant-api")) {
    return {
      error: "That's an Anthropic API key. Add it in Settings → Providers → Anthropic; this is for your Claude subscription.",
    };
  }
  return { token };
}
