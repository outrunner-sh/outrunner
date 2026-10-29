import { NextResponse } from "next/server";
import { getOwner } from "@/lib/auth/owner";
import { getEnvironment } from "@/lib/db/environments";
import { getWorkspace, getWorkspaceComputer } from "@/lib/db/repositories";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { resolveProvider } from "@/lib/runtime/resolve";
import { visibleSessionInfo } from "@/lib/session/session-info";

/** Read access is exactly the session page's getWorkspace RLS. No admin reads,
 * token minting, session attach, restore, or raw environment values. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const owner = await getOwner();
  const result = await visibleSessionInfo((await params).id, {
    signedIn: async () => owner !== null,
    visibleWorkspace: getWorkspace,
    computer: getWorkspaceComputer,
    environment: async (id) =>
      (await getEnvironment(owner!.id, id).catch(() => null))?.name ?? null,
    inspect: async (session, sandboxId) => {
      const resolved = resolveProvider(session);
      if (!resolved.ok || !isComputerProvider(resolved.provider)) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          resolved.provider.inspectComputer(sandboxId),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return NextResponse.json(
    result.status === 200
      ? result.info
      : {
          error:
            result.status === 401 ? "Sign in first." : "Session not found.",
        },
    {
      status: result.status,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
