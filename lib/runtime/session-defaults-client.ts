import { NO_DEFAULTS, parseSessionDefaults, type SessionDefaults } from "@/lib/runtime/session-defaults";

/** The signed-in user's defaults for new sessions; none when they can't be read. */
export async function fetchSessionDefaults(): Promise<SessionDefaults> {
  const res = await fetch("/api/settings/defaults").catch(() => null);
  if (!res?.ok) return NO_DEFAULTS;
  return parseSessionDefaults(await res.json().catch(() => null));
}

/** Save them; resolves with what was saved. */
export async function saveSessionDefaults(defaults: SessionDefaults): Promise<SessionDefaults> {
  const res = await fetch("/api/settings/defaults", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaults),
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? "Could not save that. Please try again.");
  return parseSessionDefaults(body);
}
