/**
 * The environment the server can't run without, checked once at startup
 * (server.ts) so a deploy missing one fails at once, with the whole list,
 * rather than serving users and failing on the first request that needs it.
 * Optional settings stay optional: each feature checks its own where it's
 * used (lib/env.ts). Imports only zod, so server.ts can load it before Next.
 */
import { z } from "zod";

const present = z.string().trim().min(1, "is not set");

const base = z.object({
  NEXT_PUBLIC_SUPABASE_URL: present.pipe(z.url("is not a URL")),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: present,
  SUPABASE_SERVICE_ROLE_KEY: present,
  // Seals every user's credentials (lib/crypto/secret-box.ts): without it no
  // session can start, while the app otherwise looks healthy.
  CREDENTIALS_ENCRYPTION_KEY: present,
  // lib/env.ts's DEPLOYMENT_PROVIDERS, written out to keep this file's only
  // import zod; test/startup-env.test.ts keeps them the same.
  RUNTIME_PROVIDER: z.enum(["local", "modal", "daytona", "neev", "e2b"]).optional(),
  // Optional, but a malformed DSN would silently drop every error report.
  SENTRY_DSN: z.url("is not a URL").optional(),
});

/** What each provider adds to what's required. */
const byProvider: Record<string, Record<string, z.ZodType>> = {
  daytona: { DAYTONA_API_KEY: present },
  neev: { NEEV_API_KEY: present, NEEV_ORG_ID: present, NEEV_PROJECT_ID: present },
  modal: { MODAL_TOKEN_ID: present, MODAL_TOKEN_SECRET: present },
  // Both URLs too: unset, the SDK would quietly use E2B's cloud.
  e2b: { E2B_API_KEY: present, E2B_API_URL: present, E2B_SANDBOX_URL: present },
};

/** Each problem with `env`, as "NAME is not set"; empty when it's fine. */
export function startupEnvProblems(env: Record<string, string | undefined>): string[] {
  // Blank is unset, as optionalEnv reads it.
  const given = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ""));
  const provider = typeof given.RUNTIME_PROVIDER === "string" ? given.RUNTIME_PROVIDER : "local";
  const schema = base.extend(byProvider[provider] ?? {});
  const parsed = schema.safeParse(given);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const name = issue.path.join(".");
    const message = issue.code === "invalid_type" ? "is not set" : issue.message;
    return `${name} ${message}`;
  });
}

/**
 * Exits the process with every problem listed, in production; elsewhere
 * (`pnpm dev` before setup) only warns, since the app's own pages say what
 * to set (/api/health's nextStep).
 */
export function checkStartupEnv(env: Record<string, string | undefined> = process.env, production = env.NODE_ENV === "production"): void {
  const problems = startupEnvProblems(env);
  if (problems.length === 0) return;
  const list = problems.map((problem) => `  - ${problem}`).join("\n");
  if (!production) {
    console.warn(`> The environment is incomplete; the app will run, but not everything will work:\n${list}`);
    return;
  }
  console.error(`> Refusing to start: the environment is incomplete (see docs/deploy-cloudflare.md):\n${list}`);
  process.exit(1);
}
