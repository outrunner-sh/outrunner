import { QuotaCooldown, quotaExhausted } from "@/lib/agents/quota-fallback";
import { boundedBody } from "@/lib/codex/body";
import {
  ClaudeAccessError,
  type ClaudeGrant,
  type ClaudeRef,
} from "@/lib/claude/access";

type Deps = {
  readGrant(bearer: string): ClaudeGrant;
  authorize(grant: ClaudeGrant, ref: ClaudeRef): Promise<string>;
  fetch: typeof fetch;
};
export function createClaudeProxy(deps: Deps) {
  const cooldown = new QuotaCooldown();
  return async (
    request: Request,
    context: { params: Promise<{ path: string[] }> },
  ) => {
    try {
      const { path } = await context.params;
      if (
        request.method !== "POST" ||
        !["v1/messages", "v1/messages/count_tokens"].includes(path.join("/"))
      )
        return Response.json(
          { error: "Unsupported Claude operation." },
          { status: 404 },
        );
      const bearer =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!bearer || bearer.length > 16384) throw new ClaudeAccessError();
      const grant = deps.readGrant(bearer);
      await deps.authorize(grant, grant.primary);
      const body = await boundedBody(request, 20 * 1024 * 1024);
      if (!body)
        return Response.json({ error: "Request too large." }, { status: 413 });
      const key = `${grant.primary.kind}:${grant.primary.id}:${grant.primary.revision}`;
      const candidates =
        grant.fallback && !cooldown.ready(key)
          ? [grant.fallback]
          : [grant.primary, ...(grant.fallback ? [grant.fallback] : [])];
      for (const ref of candidates) {
        const token = await deps.authorize(grant, ref);
        const headers = new Headers({
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        });
        for (const name of [
          "anthropic-version",
          "anthropic-beta",
          "user-agent",
          "accept",
          "x-app",
          "x-stainless-lang",
          "x-stainless-package-version",
          "x-stainless-os",
          "x-stainless-arch",
          "x-stainless-runtime",
          "x-stainless-runtime-version",
          "x-stainless-retry-count",
          "x-stainless-timeout",
        ]) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        // OAuth inference requires this beta even if an older client omits it.
        const beta = headers.get("anthropic-beta");
        if (
          !beta
            ?.split(",")
            .map((v) => v.trim())
            .includes("oauth-2025-04-20")
        )
          headers.set(
            "anthropic-beta",
            [beta, "oauth-2025-04-20"].filter(Boolean).join(","),
          );
        const url = new URL(`https://api.anthropic.com/${path.join("/")}`);
        if (new URL(request.url).searchParams.get("beta") === "true")
          url.searchParams.set("beta", "true");
        const upstream = await deps.fetch(url, {
          method: "POST",
          headers,
          body: body.buffer as ArrayBuffer,
          signal: request.signal,
          redirect: "error",
        });
        try {
          await deps.authorize(grant, ref);
        } catch (error) {
          await upstream.body?.cancel();
          throw error;
        }
        if (
          ref === grant.primary &&
          grant.fallback &&
          (await quotaExhausted(upstream))
        ) {
          cooldown.exhaust(key, upstream);
          await upstream.body?.cancel();
          continue;
        }
        const outgoing = new Headers({
          "Cache-Control": "no-store",
          "Content-Type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        for (const name of [
          "request-id",
          "retry-after",
          "anthropic-ratelimit-requests-reset",
          "anthropic-ratelimit-tokens-reset",
        ]) {
          const value = upstream.headers.get(name);
          if (value) outgoing.set(name, value);
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers: outgoing,
        });
      }
      throw new Error("No available connection");
    } catch (error) {
      return Response.json(
        {
          type: "error",
          error: {
            type:
              error instanceof ClaudeAccessError
                ? "authentication_error"
                : "api_error",
            message:
              error instanceof ClaudeAccessError
                ? error.message
                : "Couldn't reach Claude. Try again.",
          },
        },
        {
          status: error instanceof ClaudeAccessError ? 403 : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
}
