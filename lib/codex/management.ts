import { z } from "zod";
import {
  codexLogin,
  CodexError,
  metadata,
  scopeKey,
  type CodexScope,
  type CodexStore,
  type CodexAccounts,
} from "@/lib/codex/account";

type ManagementDeps = {
  accounts: CodexAccounts;
  store: CodexStore;
  memberRole(org: string, user: string): Promise<"admin" | "member" | null>;
  fetch: typeof fetch;
};
export function createCodexManagement(deps: ManagementDeps) {
  async function allowedScope(
    user: string,
    org: string | null,
    managing: boolean,
  ): Promise<CodexScope> {
    if (!org) return { kind: "personal", id: user };
    if (!z.uuid().safeParse(org).success)
      throw new CodexError("revoked", "Choose an organization you belong to.");
    const role = await deps.memberRole(org, user);
    if (!role || (managing && role !== "admin"))
      throw new CodexError(
        "revoked",
        "Only this organization's admins can manage its Codex connection.",
      );
    return { kind: "org", id: org.toLowerCase() };
  }
  return async function manageCodex(
    request: Request,
    user: string,
    org: string | null,
    body?: unknown,
  ) {
    try {
      const scope = await allowedScope(user, org, request.method !== "GET");
      const key = scopeKey(scope);
      if (request.method === "GET")
        return Response.json(metadata(await deps.store.read(key), user), {
          headers: { "Cache-Control": "no-store" },
        });
      const data = body as { action?: unknown; attempt?: unknown } | null;
      if (request.method === "POST" && data?.action === "begin") {
        let attempt: string;
        if (data.attempt) {
          const current = await deps.store.read(key);
          if (
            !current ||
            current.pending_id !== data.attempt ||
            current.pending_user !== user ||
            Date.parse(current.pending_until ?? "") <= Date.now()
          ) {
            throw new CodexError(
              "expired",
              "This connection attempt expired or was canceled. Start again in Settings.",
            );
          }
          attempt = current.pending_id!;
        } else attempt = await deps.accounts.begin(key, user);
        return Response.json({
          attempt,
          ...metadata(await deps.store.read(key), user),
        });
      }
      if (
        request.method === "POST" &&
        data?.action === "cancel" &&
        z.uuid().safeParse(data.attempt).success
      ) {
        await deps.store.change(key, "cancel", {
          attempt: data.attempt as string,
          actor: user,
        });
      } else if (request.method === "DELETE") {
        await deps.store.change(key, "disconnect", { actor: user });
      } else if (request.method === "PUT") {
        const parsed = codexLogin.extend({ attempt: z.uuid() }).safeParse(body);
        if (!parsed.success)
          return Response.json(
            {
              error:
                "The CLI did not return a valid Codex login. Update Codex and try again.",
            },
            { status: 400 },
          );
        const pending = await deps.store.read(key);
        if (
          !pending ||
          pending.pending_id !== parsed.data.attempt ||
          pending.pending_user !== user ||
          Date.parse(pending.pending_until ?? "") <= Date.now()
        ) {
          throw new CodexError(
            "expired",
            "This sign-in was canceled or expired. Start a new connection.",
          );
        }
        // Verify the freshly minted native login with the provider before replacing
        // an existing connection. Never trust ID-token claims as authorization.
        let validation: Response;
        try {
          validation = await deps.fetch(
            "https://chatgpt.com/backend-api/codex/models?client_version=0.146.0",
            {
              headers: {
                Authorization: `Bearer ${parsed.data.tokens.access_token}`,
                "ChatGPT-Account-ID": parsed.data.tokens.account_id,
                originator: "codex_cli_rs",
              },
              signal: AbortSignal.timeout(15_000),
              redirect: "error",
            },
          );
        } catch {
          throw new CodexError(
            "unavailable",
            "Couldn't verify the Codex login. Try again.",
          );
        }
        await validation.body?.cancel();
        if (!validation.ok)
          throw new CodexError(
            validation.status === 401 || validation.status === 403
              ? "reconnect"
              : "unavailable",
            "Codex did not accept this login. Try connecting again.",
          );
        await allowedScope(user, org, true); // admin removed during provider call
        return Response.json(
          await deps.accounts.save(
            key,
            user,
            parsed.data.attempt,
            parsed.data.tokens,
          ),
        );
      } else
        return Response.json(
          { error: "Invalid connection operation." },
          { status: 400 },
        );
      return Response.json(metadata(await deps.store.read(key), user));
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof CodexError
              ? error.message
              : "Couldn't update the Codex connection. Try again.",
        },
        {
          status:
            error instanceof CodexError && error.code !== "unavailable"
              ? 403
              : 503,
        },
      );
    }
  };
}
