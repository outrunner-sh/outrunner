/**
 * Syncing a project's Doppler and Infisical secrets into a session as it
 * starts (docs/secret-sync.md): each link's secrets fetched now, so a
 * session always has what the provider holds, never a copy kept here; the
 * project's own variables winning a name; and each link's outcome recorded
 * for the project's page, by name.
 *
 * A provider that's down, or a token revoked, never stops the session: it
 * starts with the rest, and the page says why the link's secrets are
 * missing. Nothing here logs a value, nor an error that could hold one.
 *
 * The database and the providers come in as {@link SyncDeps}, so the rules
 * are tested without either (lib/secret-sync/sync.deps.ts wires them).
 */

import { MAX_SCRIPT_BYTES, utf8Bytes } from "@/lib/environments/rules";
import { withInfisicalCli } from "@/lib/secret-sync/infisical-cli";
import { SyncError, SYNC_TIMEOUT_MS } from "@/lib/secret-sync/providers";
import { mergeSyncedEnv, PROVIDER_LABELS, type SecretProvider, type SyncedSecrets } from "@/lib/secret-sync/rules";

/** A link, as far as the sync goes: its provider; the fetching is `fetch`'s. */
export type SyncDeps<L extends { provider: SecretProvider }> = {
  links(): Promise<L[]>;
  /** The link's secrets, and for Infisical its CLI's sign-in. */
  fetch(link: L, signal: AbortSignal): Promise<{ env: Record<string, string>; cli: Record<string, string> | null }>;
  record(provider: SecretProvider, result: SyncOutcome): Promise<void>;
  timeoutMs?: number;
};

/** What a sync gives a session: its variables, the project's own over the
 *  synced, and its start hook (with the Infisical CLI's install first, for a
 *  project linked to Infisical); and what each link brought, by name. */
export type SyncResult = {
  env: Record<string, string>;
  startHook: string | null;
  outcomes: Array<{ provider: SecretProvider } & SyncOutcome>;
};

/** What a link's sync brought: why it brought nothing (`error`), or what it
 *  couldn't do beside bringing its secrets (`warning`), each a sentence for
 *  the page; and the names it set, and those a session can't take. */
export type SyncOutcome = { error: string | null; warning: string | null; names: string[]; skipped: string[] };

/** Why a link brought nothing, as the page says it; never the error's own
 *  text unless it's one of ours (a provider's could quote what it was sent). */
function failure(provider: SecretProvider, error: unknown): string {
  if (error instanceof SyncError) return error.message;
  return `Couldn't sync ${PROVIDER_LABELS[provider]}. Sessions start without its secrets until it can be.`;
}

/** The project's variables and start hook for a new session, with its links'
 *  secrets. Never throws: what fails is said in `outcomes`, and recorded. */
export async function syncSecrets<L extends { provider: SecretProvider }>(
  deps: SyncDeps<L>,
  own: { env: Record<string, string>; startHook: string | null },
): Promise<SyncResult> {
  let links: L[];
  try {
    links = await deps.links();
  } catch (error) {
    // A database error: it holds no secret.
    console.error("Couldn't read the project's secret sync links", error);
    return { env: own.env, startHook: own.startHook, outcomes: [] };
  }
  if (links.length === 0) return { env: own.env, startHook: own.startHook, outcomes: [] };

  const fetched = await Promise.all(
    links.map(async (link) => {
      try {
        const got = await deps.fetch(link, AbortSignal.timeout(deps.timeoutMs ?? SYNC_TIMEOUT_MS));
        return { provider: link.provider, ...got, error: null };
      } catch (error) {
        return { provider: link.provider, env: {}, cli: null, error: failure(link.provider, error) };
      }
    }),
  );

  // The CLI's sign-in is Infisical's too, beneath its secrets: a secret of
  // the same name (an INFISICAL_TOKEN of the project's) wins over it.
  const synced: SyncedSecrets[] = fetched
    .filter((f) => f.error === null)
    .map((f) => ({ provider: f.provider, env: { ...(f.cli ?? {}), ...f.env } }));
  const { env, outcomes: merged } = mergeSyncedEnv(own.env, synced);

  // The CLI's install goes before the project's start hook, unless the two
  // would be more than the agent takes: it would refuse the whole
  // environment, and the session start without its secrets.
  const tooLarge = merged.get("infisical")?.tooLarge ?? false;
  const wantsCli = !tooLarge && fetched.some((f) => f.cli !== null && f.error === null);
  const withCli = wantsCli ? withInfisicalCli(own.startHook) : null;
  const cliSkipped = withCli !== null && utf8Bytes(withCli) > MAX_SCRIPT_BYTES;

  const outcomes = fetched.map((f) => {
    const m = merged.get(f.provider);
    const cliNames = new Set(Object.keys(f.cli ?? {}));
    const names = (m?.names ?? []).filter((n) => !cliNames.has(n) || n in f.env);
    const error =
      f.error ??
      (m?.tooLarge
        ? `${PROVIDER_LABELS[f.provider]}'s secrets were left out: with them a session's variables are over 256 KB.`
        : null);
    const warning =
      f.provider === "infisical" && cliSkipped && !error
        ? "The infisical CLI wasn't installed: with its install, the environment's start hook is over 64 KB. Its sign-in is in the environment."
        : null;
    return { provider: f.provider, error, warning, names: m?.tooLarge ? [] : names, skipped: m?.skipped ?? [] };
  });

  await Promise.all(
    outcomes.map((o) =>
      deps.record(o.provider, { error: o.error, warning: o.warning, names: o.names, skipped: o.skipped }).catch((error: unknown) => {
        console.error(`Couldn't record the ${o.provider} sync`, error);
      }),
    ),
  );
  return { env, startHook: withCli !== null && !cliSkipped ? withCli : own.startHook, outcomes };
}
