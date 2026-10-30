import { getOwner, isOwner, ownerFromUser } from "@/lib/auth/owner";
import { readDesktopCodexTicket } from "@/lib/codex/desktop-ticket";
import { createDesktopCodexHandler } from "@/lib/codex/desktop-handler";
import { manageCodex } from "@/lib/codex/manage";
import { requireEnv } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const connection = createDesktopCodexHandler({
  ticket: (bearer) =>
    readDesktopCodexTicket(
      bearer,
      new URL(requireEnv("RUNTIME_BASE_URL")).origin,
    ),
  async owner(id) {
    const { data, error } =
      await createSupabaseAdminClient().auth.admin.getUserById(id);
    return !error && data.user && isOwner(data.user)
      ? ownerFromUser(data.user)
      : null;
  },
  sessionOwner: async () => (await getOwner())?.id ?? null,
  manage: manageCodex,
});
export const GET = connection;
export const PUT = connection;
export const POST = connection;
