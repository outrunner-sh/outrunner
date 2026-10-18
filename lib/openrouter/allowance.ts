/**
 * A user's allowance on Outrunner's models, as the sidebar shows it: how much
 * of their key's cap is spent, as a percentage. The cap is dollars on
 * OpenRouter, but users never see dollars, so the view carries none; the
 * server builds it, and only it leaves for the browser. Imports nothing, so
 * the client and the tests use it as is.
 */

export type Allowance = { usedUsd: number; limitUsd: number };

export type AllowanceView = {
  /** "out" once it's spent; "low" from 80%, to warn ahead. */
  state: "ok" | "low" | "out";
  /** How full the bar is, 0 to 100. */
  percent: number;
  /** "24% used". */
  label: string;
};

/** OpenRouter counts in fractions of a cent: within half a cent is spent. */
const SPENT_WITHIN_USD = 0.005;
const LOW_FROM_PERCENT = 80;

/** Nothing of the allowance is left: what the bar shows as "out", and when the
 *  key stops being handed out. */
export function allowanceSpent({ usedUsd, limitUsd }: Allowance): boolean {
  return limitUsd <= 0 || Math.max(0, usedUsd) >= limitUsd - SPENT_WITHIN_USD;
}

export function allowanceView({ usedUsd, limitUsd }: Allowance): AllowanceView {
  const used = Math.max(0, usedUsd);
  const out = allowanceSpent({ usedUsd, limitUsd });
  const percent = out ? 100 : Math.min(100, (used / limitUsd) * 100);
  return {
    state: out ? "out" : percent >= LOW_FROM_PERCENT ? "low" : "ok",
    percent,
    label: `${percentLabel(percent, out)} used`,
  };
}

/** Whole percent, rounded down so 99.6% isn't "100%" while some is left;
 *  "<1%" for a little, so a start isn't "0%". */
function percentLabel(percent: number, out: boolean): string {
  if (out) return "100%";
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.floor(percent)}%`;
}
