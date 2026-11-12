import { optionalEnv } from "@/lib/env";

/** Every application table required for Runtime's initial control plane. */
export const RUNTIME_TABLES = ["projects", "workspaces", "jobs", "pull_requests"] as const;

export type RuntimeTable = (typeof RUNTIME_TABLES)[number];
/** `outdated`: the table is there, but a later migration that adds a column
 *  the app reads has not been run. */
export type TableProbeStatus = "ok" | "missing" | "outdated" | "unreachable";
export type DatabaseProbe = Record<RuntimeTable, TableProbeStatus>;

/**
 * The columns each table is probed for: its id, plus every column a migration
 * added after the table was created. Probing only the id once reported a
 * database without `workspaces.title` as migrated, and every session title
 * then failed to save, quietly. Add a column here when a migration adds one.
 */
export const RUNTIME_COLUMNS: Record<RuntimeTable, readonly string[]> = {
  projects: ["id"],
  workspaces: ["id", "computer_id", "tmux_session", "agent_workspace_id", "title", "agent", "main_chat_name"],
  jobs: ["id", "result_path", "execution_handle", "agent"],
  pull_requests: ["id"],
};

/** What a probe's error means: Postgres and PostgREST codes for a missing
 *  table or column; anything else is a failure to reach the database. */
export function probeStatus(error: { code?: string } | null): TableProbeStatus {
  if (!error) return "ok";
  if (error.code === "PGRST205" || error.code === "42P01") return "missing";
  if (error.code === "42703" || error.code === "PGRST204") return "outdated";
  return "unreachable";
}

/** The slice of the Supabase client the probe uses, so tests can stand one in. */
export type ProbeClient = {
  from(table: string): {
    select(columns: string): { limit(count: number): PromiseLike<{ error: { code?: string } | null }> };
  };
};

/**
 * Verify that the schema required by Runtime is reachable.
 *
 * Responses deliberately use stable diagnostic labels. The underlying
 * Supabase/network error is logged only on the server, so public endpoints do
 * not disclose connection details or provider error messages.
 */
export async function probeRuntimeDatabase(client?: ProbeClient): Promise<DatabaseProbe> {
  const result = Object.fromEntries(
    RUNTIME_TABLES.map((table) => [table, "unreachable"]),
  ) as DatabaseProbe;

  let supabase: ProbeClient;
  try {
    // Loaded here, not imported at the top: it needs Next's request scope
    // (next/headers), which tests that pass their own client do not have.
    // The service role when there is one: this checks the schema is there,
    // and a table only the server reads (pull_requests, since
    // 20261112110000) is denied to the anonymous caller /api/health has.
    // Without the service role, pull_requests always reads as unreachable;
    // startup-env requires the key, so that's only `next dev` or tests.
    if (client) {
      supabase = client;
    } else {
      const server = await import("@/lib/supabase/server");
      supabase = optionalEnv("SUPABASE_SERVICE_ROLE_KEY")
        ? server.createSupabaseAdminClient()
        : await server.createSupabaseServerClient();
    }
  } catch (error) {
    console.error("Runtime database probe could not create a Supabase client", error);
    return result;
  }

  for (const table of RUNTIME_TABLES) {
    try {
      // Do not use a HEAD request: PostgREST can omit the useful error body,
      // which made an absent migration look healthy in earlier checks.
      const { error } = await supabase.from(table).select(RUNTIME_COLUMNS[table].join(",")).limit(1);
      result[table] = probeStatus(error);
      if (result[table] === "unreachable") {
        console.error(`Runtime database probe failed for ${table}`, error);
      }
    } catch (error) {
      console.error(`Runtime database probe threw for ${table}`, error);
    }
  }

  return result;
}
