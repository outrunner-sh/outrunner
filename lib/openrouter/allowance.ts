/**
 * A user's allowance on Outrunner's models, as the sidebar shows it: what
 * their own key has spent of its cap ($5 in total). Imports nothing, so the
 * client and the tests use it as is.
 */

export type Allowance = { usedUsd: number; limitUsd: number };

export type AllowanceView = {
  /** "out" once it's spent; "low" from 80%, to warn ahead. */
  state: "ok" | "low" | "out";
  /** How full the bar is, 0 to 100. */
  percent: number;
  /** "$1.20 of $5 used". */
  label: string;
  /** The cap, "$5". */
  limit: string;
};

/** OpenRouter counts in fractions of a cent: within half a cent is spent. */
const SPENT_WITHIN_USD = 0.005;
const LOW_FROM_PERCENT = 80;

export function allowanceView({ usedUsd, limitUsd }: Allowance): AllowanceView {
  const used = Math.max(0, usedUsd);
  const out = limitUsd <= 0 || used >= limitUsd - SPENT_WITHIN_USD;
  const percent = out ? 100 : Math.min(100, (used / limitUsd) * 100);
  return {
    state: out ? "out" : percent >= LOW_FROM_PERCENT ? "low" : "ok",
    percent,
    label: `${dollars(Math.min(used, limitUsd))} of ${dollars(limitUsd)} used`,
    limit: dollars(limitUsd),
  };
}

/** "$5" for whole dollars, "$1.20" otherwise. */
function dollars(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}
