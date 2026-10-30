import { boundedBody } from "@/lib/codex/body";
import {
  CodexError,
  revoked,
  unavailable,
  type CodexAccounts,
} from "@/lib/codex/account";
import type { CodexGrant } from "@/lib/codex/grant";

type ProxyDeps = {
  readGrant(value: string): CodexGrant;
  authorize(grant: CodexGrant): Promise<unknown>;
  accounts: Pick<CodexAccounts, "access">;
  fetch: typeof fetch;
  brokerOrigin?: string;
};
export function createCodexProxy(deps: ProxyDeps) {
  // Inference and local account routing only: no remote login, files, arbitrary
  // URLs, or OAuth refresh. The native CLI's base_url points here over HTTPS.
  const allowed = new Map([
    ["GET models", "models"],
    ["GET api/codex/accounts/check", "accounts/check"],
    ["POST responses", "responses"],
    ["POST responses/compact", "responses/compact"],
  ]);
  return async function proxy(
    request: Request,
    context: { params: Promise<{ path: string[] }> },
  ) {
    try {
      const { path } = await context.params;
      const target = allowed.get(`${request.method} ${path.join("/")}`);
      if (!target)
        return Response.json(
          { error: "Unsupported Codex operation." },
          { status: 404 },
        );
      const bearer =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (bearer.length > 16384) throw revoked();
      const grant = deps.readGrant(bearer);
      const check = () => deps.authorize(grant);
      await check();
      let access = await deps.accounts.access(grant.key, grant.generation);
      if (target === "accounts/check") {
        // Newer CLIs discover workspace routing during account/read. Their
        // local identity is "outrunner" (AccountConfig); keep them on this
        // broker, which alone owns the real account and provider routing.
        await check();
        return Response.json({ accounts: [{
          id: "outrunner",
          workspace_backend_origin: new URL(deps.brokerOrigin ?? request.url).origin,
          account_routing_override: "NO_CONSTRAINT",
        }] }, { headers: { "Cache-Control": "no-store" } });
      }
      let body: ArrayBuffer | undefined;
      if (request.method === "POST") {
        const bounded = await boundedBody(request, 20 * 1024 * 1024);
        if (!bounded)
          return Response.json(
            { error: "Request too large." },
            { status: 413 },
          );
        body = bounded.buffer as ArrayBuffer;
      }
      const url = new URL(`https://chatgpt.com/backend-api/codex/${target}`);
      // Only CLI version for the native model catalog; never arbitrary query args.
      const version = new URL(request.url).searchParams.get("client_version");
      if (version && /^\d+\.\d+\.\d+$/.test(version))
        url.searchParams.set("client_version", version);
      for (let attempt = 0; attempt < 2; attempt++) {
        await check();
        const headers = new Headers({
          Authorization: `Bearer ${access.tokens.access_token}`,
          "ChatGPT-Account-ID": access.tokens.account_id,
          "Content-Type": "application/json",
          originator: "codex_cli_rs",
        });
        for (const name of [
          "user-agent",
          "version",
          "x-client-request-id",
          "content-encoding",
          "accept",
          "openai-beta",
          "session_id",
          "conversation_id",
          "x-codex-turn-state",
          "x-codex-turn-metadata",
          "x-codex-beta-features",
        ]) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        let upstream: Response;
        try {
          upstream = await deps.fetch(url, {
            method: request.method,
            headers,
            body,
            signal: request.signal,
            redirect: "error",
          });
        } catch {
          throw unavailable();
        }
        if (upstream.status === 401 && attempt === 0) {
          await upstream.body?.cancel();
          await check();
          access = await deps.accounts.access(
            grant.key,
            grant.generation,
            access.revision,
          );
          continue;
        }
        try {
          await check();
        } catch (error) {
          await upstream.body?.cancel();
          throw error;
        }
        if (upstream.status === 401) {
          await upstream.body?.cancel();
          // Access denial need not mean a rejected refresh; don't erase a working
          // refresh token for rate limits, account entitlements or network errors.
          throw new CodexError(
            "reconnect",
            "Codex rejected this account. Reconnect in Settings → Coding agents.",
          );
        }
        const outgoing = new Headers({
          "Cache-Control": "no-store",
          "Content-Type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        for (const name of [
          "x-request-id",
          "x-codex-turn-state",
          "retry-after",
        ]) {
          const value = upstream.headers.get(name);
          if (value) outgoing.set(name, value);
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers: outgoing,
        });
      }
      throw unavailable();
    } catch (error) {
      const known = error instanceof CodexError;
      return Response.json(
        { error: known ? error.message : "Couldn't reach Codex. Try again." },
        {
          status: known && error.code !== "unavailable" ? 403 : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
}
