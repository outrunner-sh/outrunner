import { open, seal } from "@/lib/crypto/secret-box";
import {
  CodexAccounts,
  type CodexStore,
  type Connection,
} from "@/lib/codex/account";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const codexStore: CodexStore = {
  async read(key) {
    const { data, error } = await createSupabaseAdminClient()
      .from("codex_connections")
      .select("*")
      .eq("key", key)
      .maybeSingle();
    if (error && probeStatus(error) === "missing") return null;
    if (error) throw new Error("Could not read Codex connection");
    return data;
  },
  async change(key, op, args = {}) {
    const { data, error } = await createSupabaseAdminClient().rpc(
      "codex_connection_change",
      { k: key, op, a: args },
    );
    if (error) throw new Error("Could not update Codex connection");
    return data as unknown as { row: Connection; claimed: boolean };
  },
};
export const codexAccounts = new CodexAccounts(codexStore, { open, seal });
