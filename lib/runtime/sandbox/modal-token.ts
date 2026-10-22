/**
 * A Modal token's two parts, as Modal → Settings → API Tokens shows them. Kept
 * apart from the Modal backend so the settings page can use it in the browser.
 */

export type ModalToken = { tokenId: string; tokenSecret: string };

const TOKEN_ID = /^ak-[A-Za-z0-9]{8,100}$/;
const TOKEN_SECRET = /^as-[A-Za-z0-9]{8,100}$/;

/** The token in a save's `modalToken`, or what's wrong with it. */
export function checkModalToken(value: unknown): { token: ModalToken } | { error: string } {
  const { tokenId, tokenSecret } = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const id = typeof tokenId === "string" ? tokenId.trim() : "";
  const secret = typeof tokenSecret === "string" ? tokenSecret.trim() : "";
  if (TOKEN_ID.test(secret) && TOKEN_SECRET.test(id)) {
    return { error: "The token id and secret are the wrong way round: the id starts ak-, the secret as-." };
  }
  if (!TOKEN_ID.test(id)) {
    return { error: "That token id doesn't look right: it starts ak-, from Modal → Settings → API Tokens." };
  }
  if (!TOKEN_SECRET.test(secret)) {
    return { error: "That token secret doesn't look right: it starts as-, from Modal → Settings → API Tokens." };
  }
  return { token: { tokenId: id, tokenSecret: secret } };
}

/**
 * The parts of a token in pasted text that's more than a bare value: Modal's
 * "Token created" dialog only copies the whole `modal token set --token-id ak-…
 * --token-secret as-… --profile=…` command, and `.env` lines are
 * `MODAL_TOKEN_ID=ak-…`. Null for a single bare value (or something being
 * typed), which goes in the field as it is.
 */
export function modalTokenInText(text: string): Partial<ModalToken> | null {
  if (!/[\s=]/.test(text.trim())) return null;
  const tokenId = text.match(/(?<![A-Za-z0-9-])ak-[A-Za-z0-9]+/)?.[0];
  const tokenSecret = text.match(/(?<![A-Za-z0-9-])as-[A-Za-z0-9]+/)?.[0];
  if (!tokenId && !tokenSecret) return null;
  return { ...(tokenId ? { tokenId } : {}), ...(tokenSecret ? { tokenSecret } : {}) };
}
