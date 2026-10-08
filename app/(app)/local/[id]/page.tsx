import { redirect } from "next/navigation";

import { LocalWorkspaceView } from "@/components/local-workspace-view";
import { getOwnerSafe } from "@/lib/auth/owner";

export const dynamic = "force-dynamic";

/**
 * A local session: Claude Code running on this Mac. The server holds no record
 * of it: the session itself is read from the Mac by the Outrunner app.
 */
export default async function LocalWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ prompt?: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");
  const { id } = await params;
  const { prompt } = await searchParams;
  return (
    <LocalWorkspaceView
      workspaceId={id}
      initialPrompt={prompt}
    />
  );
}
