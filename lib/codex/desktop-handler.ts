import type { Owner } from "@/lib/auth/owner";
import type { DesktopCodexTicket } from "@/lib/codex/desktop-ticket";
import { boundedBody } from "@/lib/codex/body";

type Dependencies = {
  ticket(bearer: string): DesktopCodexTicket;
  owner(id: string): Promise<Owner | null>;
  sessionOwner(): Promise<string | null>;
  manage(
    request: Request,
    owner: Owner,
    org: string | null,
    body?: unknown,
  ): Promise<Response>;
};

export function createDesktopCodexHandler(deps: Dependencies) {
  return async function connection(request: Request) {
    try {
      if (!["GET", "PUT", "POST"].includes(request.method))
        return Response.json(
          { error: "Invalid connection operation." },
          { status: 405 },
        );
      const bearer = /^Bearer (\S+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!bearer)
        return Response.json(
          { error: "Connection authorization required." },
          { status: 401 },
        );
      const grant = deps.ticket(bearer);
      const owner = await deps.owner(grant.user);
      if (!owner)
        return Response.json({ error: "Sign in again." }, { status: 401 });
      if (
        request.headers.has("cookie") &&
        (await deps.sessionOwner()) !== grant.user
      ) {
        return Response.json({ error: "Account changed." }, { status: 403 });
      }
      let body: unknown;
      if (request.method === "PUT") {
        const raw = await boundedBody(request, 64 * 1024);
        if (!raw)
          return Response.json({ error: "Login too large." }, { status: 413 });
        const input = JSON.parse(new TextDecoder().decode(raw));
        body = { attempt: grant.attempt, tokens: input?.tokens };
      } else if (request.method === "POST") {
        body = { action: "cancel", attempt: grant.attempt };
      }
      const response = await deps.manage(request, owner, grant.org, body);
      if (request.method === "GET" && response.ok) {
        const meta = await response.json();
        if (
          meta.pending?.id !== grant.attempt ||
          meta.pending?.mine === false
        ) {
          return Response.json(
            { error: "Connection canceled or expired." },
            { status: 403 },
          );
        }
        return Response.json(
          { pending: true },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return response;
    } catch {
      return Response.json(
        {
          error: "Connection authorization expired or unavailable. Try again.",
        },
        { status: 403 },
      );
    }
  };
}
