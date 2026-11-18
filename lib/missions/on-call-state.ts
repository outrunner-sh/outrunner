/**
 * Where a Mission stands on call (docs/missions.md, "On call in Slack"), for
 * the sidebar's badge and Settings' list of bound channels: one state, the
 * one that most needs someone first.
 *
 *   budget_paused  its budget is spent (a `mission_budgets` row paused until
 *                  later): nothing runs, however it's asked, and resuming in
 *                  Slack doesn't help. The Mission's, bound or not.
 *   idle_paused    no one replied to it in Slack for long, so it paused
 *                  itself (`mission_channels.idle_paused`).
 *   paused         someone paused it (`mission_channels.paused`).
 *   on_call        bound and taking requests.
 */

export type OnCallState = "on_call" | "paused" | "idle_paused" | "budget_paused";

/** What the list API carries per Mission: enough to name its state. */
export type OnCallFacts = {
  /** On call in a channel. */
  bound: boolean;
  paused: boolean;
  idlePaused: boolean;
  /** `mission_budgets.paused_until`, whatever it is (past ones count for nothing). */
  budgetPausedUntil: string | null;
  budgetPausedPeriod: "day" | "week" | null;
};

export function budgetPaused(facts: Pick<OnCallFacts, "budgetPausedUntil">, now: number): boolean {
  if (!facts.budgetPausedUntil) return false;
  const until = Date.parse(facts.budgetPausedUntil);
  return Number.isFinite(until) && until > now;
}

/** Its state, or null when it isn't on call and its budget isn't spent. */
export function onCallState(facts: OnCallFacts, now: number): OnCallState | null {
  if (budgetPaused(facts, now)) return "budget_paused";
  if (!facts.bound) return null;
  // An idle pause sets `paused` too; it's named for why.
  if (facts.idlePaused) return "idle_paused";
  if (facts.paused) return "paused";
  return "on_call";
}

/** Whether the state wants a badge: anything that stops it taking work. */
export function needsAttention(state: OnCallState | null): state is Exclude<OnCallState, "on_call"> {
  return state === "paused" || state === "idle_paused" || state === "budget_paused";
}

export const ON_CALL_STATE_LABEL: Record<OnCallState, string> = {
  on_call: "On call",
  paused: "Paused",
  idle_paused: "Idle-paused",
  budget_paused: "Budget-paused",
};

function untilLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** The badge's tooltip: which pause, and what lifts it. */
export function onCallTooltip(state: OnCallState, facts: Pick<OnCallFacts, "budgetPausedUntil" | "budgetPausedPeriod">): string {
  switch (state) {
    case "budget_paused": {
      const which = facts.budgetPausedPeriod === "week" ? "weekly" : facts.budgetPausedPeriod === "day" ? "daily" : "";
      const until = facts.budgetPausedUntil ? ` until ${untilLabel(facts.budgetPausedUntil)}` : "";
      return `Budget-paused: its ${which ? `${which} ` : ""}budget is spent. Nothing runs${until}, or until the budget is raised.`;
    }
    case "idle_paused":
      return "Idle-paused: no one replied to it in Slack for a while. Resume it to take requests again.";
    case "paused":
      return "Paused in Slack: it takes nothing from its channel until resumed.";
    case "on_call":
      return "On call in Slack";
  }
}

/** The sidebar's mark for a Mission: its state and tooltip, or null when
 *  it isn't on call and its budget isn't spent. */
export function onCallBadge(facts: OnCallFacts | undefined, now: number = Date.now()): { state: OnCallState; tooltip: string; attention: boolean } | null {
  if (!facts) return null;
  const state = onCallState(facts, now);
  return state ? { state, tooltip: onCallTooltip(state, facts), attention: needsAttention(state) } : null;
}
