/**
 * When things were said, and how long the agent worked on each turn: the
 * timeline's message times and its "Worked for 3m 08s" at the end of a turn.
 * Read from the events' own timestamps (the agent's log), so a reloaded page
 * says the same as the live one.
 */

/** "Worked for 42s", "Worked for 3m 08s", "Worked for 1h 02m". */
export function workedFor(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `Worked for ${total}s`;
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `Worked for ${h}h ${pad(m)}m` : `Worked for ${m}m ${pad(s)}s`;
}

/** How long from `from` to `to` (ISO times), or null where either can't be
 *  read or it runs backwards (clock skew). */
export function between(from: string, to: string): number | null {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** A message's time as the timeline shows it: "14:02" today, "Mon 14:02"
 *  this week, "Oct 3, 14:02" before; null for a time that can't be read. */
export function messageTime(at: string, now: Date = new Date()): string | null {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = (startOfDay(now) - startOfDay(date)) / 86_400_000;
  if (days <= 0) return time;
  if (days < 7) return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
