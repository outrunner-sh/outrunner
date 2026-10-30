/** Native Codex CLI credentials. Provider tokens stay in the control plane;
 * computers receive only a scoped, revocable Outrunner inference grant. */
import { randomUUID } from "node:crypto";
import { z } from "zod";

export type CodexScope = { kind: "personal" | "org"; id: string };
export const scopeKey = (scope: CodexScope) => `${scope.kind}:${scope.id}`;
const opaque = z
  .string()
  .min(10)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/);
export const codexLogin = z.object({
  tokens: z.object({
    id_token: opaque,
    access_token: opaque,
    refresh_token: opaque,
    account_id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
  }),
});
export type CodexTokens = z.infer<typeof codexLogin>["tokens"];
export type Connection = {
  key: string;
  generation: string;
  revision: number;
  status: "connected" | "reconnect" | "disconnected";
  retry_until?: string | null;
  ciphertext: string | null;
  updated_at: string;
  pending_id: string | null;
  pending_user: string | null;
  pending_until: string | null;
};
export type Operation =
  | "begin"
  | "cancel"
  | "save"
  | "disconnect"
  | "lease"
  | "finish"
  | "reject"
  | "release";
export interface CodexStore {
  read(key: string): Promise<Connection | null>;
  change(
    key: string,
    op: Operation,
    args?: Record<string, string | number>,
  ): Promise<{ row: Connection; claimed: boolean }>;
}
export type CodexCrypto = {
  seal(value: string): string;
  open(value: string): string;
};
export class CodexError extends Error {
  readonly code: "reconnect" | "unavailable" | "revoked" | "expired";
  constructor(code: CodexError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
export const unavailable = () =>
  new CodexError(
    "unavailable",
    "Codex is temporarily unavailable. Try again shortly.",
  );
export const revoked = () =>
  new CodexError(
    "revoked",
    "This Codex connection is no longer available. Check Settings → Coding agents.",
  );
export function expiresAt(token: string): number {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    return typeof claims.exp === "number" ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}
export function metadata(row: Connection | null, actor?: string) {
  return {
    connected: row?.status === "connected",
    reconnect: row?.status === "reconnect",
    updatedAt: row?.updated_at ?? null,
    pending:
      row?.pending_id && Date.parse(row.pending_until ?? "") > Date.now()
        ? {
            id: row.pending_id,
            expiresAt: row.pending_until!,
            mine: row.pending_user === actor,
          }
        : null,
  };
}
// These are the native CLI's public client id and refresh contract, pinned to
// openai/codex rust-v0.146.0, login/src/auth/manager.rs. No SIWC client assumed.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PERMANENT = new Set([
  "invalid_grant",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);
export async function renewCodex(
  tokens: CodexTokens,
  request: typeof fetch = fetch,
): Promise<CodexTokens> {
  let response: Response;
  try {
    response = await request("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: tokens.refresh_token,
      }),
    });
  } catch {
    throw unavailable();
  }
  // Never put the response body (or request) into an error/log.
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      typeof data?.error === "string" ? data.error : data?.error?.code;
    if (
      response.status === 401 ||
      (response.status === 400 && PERMANENT.has(code))
    ) {
      throw new CodexError(
        "reconnect",
        "Codex needs you to sign in again. Reconnect in Settings → Coding agents.",
      );
    }
    throw unavailable();
  }
  const parsed = codexLogin.safeParse({
    tokens: {
      ...tokens,
      ...Object.fromEntries(
        ["access_token", "refresh_token", "id_token"].flatMap((k) =>
          typeof data?.[k] === "string" ? [[k, data[k]]] : [],
        ),
      ),
    },
  });
  if (!parsed.success || typeof data?.access_token !== "string")
    throw unavailable();
  return parsed.data.tokens;
}

export class CodexAccounts {
  readonly store: CodexStore;
  readonly crypto: CodexCrypto;
  readonly renew: (tokens: CodexTokens) => Promise<CodexTokens>;
  readonly wait: () => Promise<void>;
  constructor(
    store: CodexStore,
    crypto: CodexCrypto,
    renew: (tokens: CodexTokens) => Promise<CodexTokens> = renewCodex,
    wait: () => Promise<void> = () =>
      new Promise((resolve) => setTimeout(resolve, 100)),
  ) {
    this.store = store;
    this.crypto = crypto;
    this.renew = renew;
    this.wait = wait;
  }
  encrypt(key: string, tokens: CodexTokens) {
    return this.crypto.seal(JSON.stringify({ key, tokens }));
  }
  decrypt(row: Connection): CodexTokens {
    try {
      const value = JSON.parse(this.crypto.open(row.ciphertext!));
      if (value.key !== row.key) throw revoked();
      return codexLogin.parse(value).tokens;
    } catch {
      throw revoked();
    }
  }
  async begin(key: string, actor: string) {
    const attempt = randomUUID();
    await this.store.change(key, "begin", { attempt, actor });
    return attempt;
  }
  async save(key: string, actor: string, attempt: string, tokens: CodexTokens) {
    const result = await this.store.change(key, "save", {
      attempt,
      actor,
      ciphertext: this.encrypt(key, tokens),
    });
    if (!result.claimed)
      throw new CodexError(
        "expired",
        "This sign-in was canceled or expired. Start a new connection.",
      );
    return metadata(result.row);
  }
  /** A generation identifies a connection, a revision a renewal. Disconnect or
   * replacement fences in-flight refreshes; a DB lease serializes all replicas.
   * A 401 forces one renewal for the revision actually rejected by the provider. */
  async access(
    key: string,
    generation: string,
    rejectedRevision?: number,
  ): Promise<{ tokens: CodexTokens; revision: number }> {
    for (let i = 0; i < 200; i++) {
      const row = await this.store.read(key);
      if (
        !row ||
        row.generation !== generation ||
        row.status === "disconnected"
      )
        throw revoked();
      if (row.status === "reconnect")
        throw new CodexError(
          "reconnect",
          "Reconnect Codex in Settings → Coding agents.",
        );
      if (Date.parse(row.retry_until ?? "") > Date.now()) throw unavailable();
      const tokens = this.decrypt(row);
      if (
        expiresAt(tokens.access_token) > Date.now() + 60_000 &&
        rejectedRevision !== row.revision
      )
        return { tokens, revision: row.revision };
      const lease = randomUUID();
      const lock = await this.store.change(key, "lease", {
        generation,
        revision: row.revision,
        lease,
      });
      if (!lock.claimed) {
        await this.wait();
        continue;
      }
      try {
        const renewed = await this.renew(tokens);
        const result = await this.store.change(key, "finish", {
          generation,
          lease,
          ciphertext: this.encrypt(key, renewed),
        });
        if (!result.claimed) throw revoked();
        return { tokens: renewed, revision: result.row.revision };
      } catch (error) {
        await this.store.change(
          key,
          error instanceof CodexError && error.code === "reconnect"
            ? "reject"
            : "release",
          { generation, lease },
        );
        throw error instanceof CodexError ? error : unavailable();
      }
    }
    throw unavailable();
  }
}
