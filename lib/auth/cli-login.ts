import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing in from the terminal, the parts with no database: what the CLI asks
 * /cli-login for, where the page sends the browser back to, and the PKCE check
 * the token route makes. The flow:
 *
 *   1. `outrunner login` listens on 127.0.0.1 and opens
 *      /cli-login?port=…&state=…&challenge=…&name=… in the browser.
 *   2. The signed-in user approves; the page stores a one-time code (hashed,
 *      with the challenge) and sends the browser to
 *      http://127.0.0.1:<port>/callback?code=…&state=….
 *   3. The CLI posts the code and its verifier to /api/cli/token, which checks
 *      sha256(verifier) against the challenge and answers with a token.
 *
 * The browser only ever carries the one-time code, never the token, and the
 * code is worthless without the verifier the CLI never sent anywhere.
 */

/** How long a code waits for the CLI to trade it. */
export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;

/** What the CLI asked to be signed in as, checked. */
export type CliLoginRequest = {
  port: number;
  state: string;
  challenge: string;
  deviceName: string;
};

const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** base64url of a sha256: 43 characters, no padding. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_DEVICE_NAME = 64;

/**
 * The request in /cli-login's query, or null when any part is missing or
 * malformed. The port is the only part that shapes where the browser goes, so
 * it is a plain number above the privileged range: the callback is always
 * 127.0.0.1, never a host from the query.
 */
export function parseCliLoginRequest(query: Record<string, string | string[] | undefined>): CliLoginRequest | null {
  const one = (key: string) => {
    const value = query[key];
    return typeof value === "string" ? value : null;
  };
  const portText = one("port");
  const state = one("state");
  const challenge = one("challenge");
  if (!portText || !/^\d{1,5}$/.test(portText) || !state || !challenge) return null;
  const port = Number(portText);
  if (port < 1024 || port > 65535) return null;
  if (!STATE_PATTERN.test(state) || !CHALLENGE_PATTERN.test(challenge)) return null;
  return { port, state, challenge, deviceName: deviceName(one("name")) };
}

/** The CLI's name for the computer, cut to what's stored, printable only. */
export function deviceName(raw: string | null): string {
  const name = (raw ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, MAX_DEVICE_NAME).trim();
  return name || "Terminal";
}

/** Where the browser goes once the user approves: the CLI, on this computer. */
export function cliCallbackUrl(request: Pick<CliLoginRequest, "port" | "state">, code: string): string {
  const url = new URL(`http://127.0.0.1:${request.port}/callback`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", request.state);
  return url.toString();
}

/** A random secret, base64url: a one-time code or a token's body. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A CLI token. The prefix says what it is wherever one turns up. */
export function newCliToken(): string {
  return `or_cli_${randomSecret()}`;
}

/** How codes and tokens are stored and looked up: sha256, hex. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Whether the verifier is the one the challenge was made from (PKCE S256). */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return false;
  const made = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const asked = Buffer.from(challenge);
  return made.length === asked.length && timingSafeEqual(made, asked);
}

/** The token in an `Authorization: Bearer …` header, or null. */
export function bearerToken(headers: Headers): string | null {
  const match = /^Bearer\s+(or_cli_[A-Za-z0-9_-]{43})$/.exec(headers.get("authorization")?.trim() ?? "");
  return match ? match[1] : null;
}

export type CliTokenExchange =
  | { ok: true; token: string; userId: string; deviceName: string }
  | { ok: false; error: string };

export type CliTokenExchangeDeps = {
  takeCode: (codeHash: string) => Promise<{ userId: string; challenge: string; deviceName: string; expiresAt: string } | null>;
  saveToken: (userId: string, tokenHash: string, deviceName: string) => Promise<void>;
  now?: () => number;
};

/**
 * Trade a one-time code and its verifier for a token. The code is gone after
 * one try whatever the answer, so a wrong verifier can't be retried against it.
 * Every refusal reads the same to the caller: which part was wrong is no help
 * to anyone but someone guessing.
 */
export async function exchangeCliLoginCode(
  input: { code?: unknown; verifier?: unknown },
  deps: CliTokenExchangeDeps,
): Promise<CliTokenExchange> {
  const refused: CliTokenExchange = { ok: false, error: "That sign-in has expired or was already used. Run `outrunner login` again." };
  const { code, verifier } = input;
  if (typeof code !== "string" || typeof verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return refused;

  const stored = await deps.takeCode(hashSecret(code));
  if (!stored) return refused;
  if (Date.parse(stored.expiresAt) <= (deps.now ?? Date.now)()) return refused;
  if (!verifierMatches(verifier, stored.challenge)) return refused;

  const token = newCliToken();
  await deps.saveToken(stored.userId, hashSecret(token), stored.deviceName);
  return { ok: true, token, userId: stored.userId, deviceName: stored.deviceName };
}
