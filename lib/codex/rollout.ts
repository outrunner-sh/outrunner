import { probeStatus, type ProbeClient, type TableProbeStatus } from "@/lib/supabase/probe";

/** Public, immutable release configured at build time, never a dist-tag. */
export function codexCliVersion(value = process.env.NEXT_PUBLIC_CODEX_CLI_VERSION): string | null {
  return value && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
}

type CodexProbeClient = ProbeClient & {
  rpc(name: string, args: Record<string, string | null>): PromiseLike<{ error: { code?: string } | null }>;
};

/** Zero-row read and denied synthetic grant: never reads provider credentials
 * or an actual member's grant. Checks the table AND the broker's required RPC. */
export async function probeCodexSchema(client?: CodexProbeClient): Promise<TableProbeStatus> {
  try {
    const db = client ?? (await (await import("@/lib/supabase/server")).createSupabaseAdminClient());
    const { error } = await db.from("codex_connections").select("key").limit(0);
    if (error) return probeStatus(error);
    const { error: rpcError } = await db.rpc("codex_connection_use", {
      k: "personal:00000000-0000-0000-0000-000000000000",
      actor: "00000000-0000-0000-0000-000000000000",
      requested_org: null,
      gen: "00000000-0000-0000-0000-000000000000",
    });
    if (["PGRST202", "42883"].includes(rpcError?.code ?? "")) return "missing";
    return probeStatus(rpcError);
  } catch {
    return "unreachable";
  }
}
