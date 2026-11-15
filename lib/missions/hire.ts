/**
 * Hiring a Mission from a template (docs/missions.md, "Hire"), through the
 * app's own routes, in order: the Mission, its budgets, its name and icon,
 * each default trigger (none unless the budgets were saved). Once the
 * Mission is made it's kept whatever fails after; each step says how it went, so nothing is left half-made unsaid.
 * `fetch` is passed in, so the order and the failures are tested.
 */

import type { HirePlan, MissionBudget } from "@/lib/missions/templates";

export type HireStepKind = "create" | "profile" | "trigger" | "budget";

export type HireStep = {
  kind: HireStepKind;
  label: string;
  status: "done" | "failed" | "skipped";
  /** Why it failed, or was skipped. */
  detail?: string;
  /** A trigger's id, once made. */
  id?: string;
};

export type HireOutcome = {
  /** Null only when the Mission itself wasn't made. */
  missionId: string | null;
  steps: HireStep[];
  /** Whether any step failed. */
  failed: boolean;
  /** What the hire as a whole couldn't do, when a failure stopped a later step. */
  error?: string;
};

/** The hire's failure when its budgets aren't saved: no triggers follow. */
export const BUDGET_FAILED = "Its budgets weren't saved, so no triggers were added. Set a budget, then add triggers.";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const UNREACHABLE = "Couldn't reach Outrunner.";

async function call(fetcher: Fetch, url: string, method: string, body: unknown): Promise<{ response: Response | null; json: Record<string, unknown> | null }> {
  try {
    const response = await fetcher(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { response, json };
  } catch {
    return { response: null, json: null };
  }
}

function why(result: { response: Response | null; json: Record<string, unknown> | null }, fallback: string): string {
  if (!result.response) return UNREACHABLE;
  return typeof result.json?.error === "string" ? result.json.error : fallback;
}

export async function hireMission(plan: HirePlan, fetcher: Fetch, log: (message: string) => void = () => undefined): Promise<HireOutcome> {
  const steps: HireStep[] = [];

  const created = await call(fetcher, "/api/missions", "POST", plan.create);
  const workspace = created.json?.workspace as { id?: unknown } | undefined;
  if (!created.response?.ok || typeof workspace?.id !== "string") {
    steps.push({ kind: "create", label: "Start the Mission", status: "failed", detail: why(created, "The Mission didn't start. Try again.") });
    return { missionId: null, steps, failed: true };
  }
  const id = workspace.id;
  steps.push({ kind: "create", label: "Start the Mission", status: "done" });
  const base = `/api/missions/${encodeURIComponent(id)}`;

  // Budgets first: a Mission with triggers sends itself work unattended, so
  // none are added unless its budgets are saved.
  const budget = await call(fetcher, `${base}/budget`, "PUT", plan.budget);
  const budgetLabel = `Set budgets: ${budgetText(plan.budget)}`;
  let error: string | undefined;
  if (budget.response?.ok) steps.push({ kind: "budget", label: budgetLabel, status: "done" });
  else if (budget.response?.status === 404) {
    // TODO(phase-3): remove once budgets merge
    // Budgets aren't in this deployment at all: not a failed hire, and
    // triggers still go ahead.
    log(`Mission ${id}: budgets aren't available here (404); hired without them.`);
    steps.push({ kind: "budget", label: budgetLabel, status: "skipped", detail: "Budgets aren't available yet." });
  } else {
    error = BUDGET_FAILED;
    steps.push({ kind: "budget", label: budgetLabel, status: "failed", detail: BUDGET_FAILED });
  }

  const named = await call(fetcher, base, "PATCH", plan.profile);
  steps.push(
    named.response?.ok
      ? { kind: "profile", label: `Name it ${plan.profile.title}`, status: "done" }
      : { kind: "profile", label: `Name it ${plan.profile.title}`, status: "failed", detail: why(named, "Its name wasn't saved. Rename it from its header.") },
  );

  for (const trigger of plan.triggers) {
    const label = `Add trigger: ${trigger.name}`;
    if (error) {
      steps.push({ kind: "trigger", label, status: "skipped", detail: "Not added: its budgets weren't saved." });
      continue;
    }
    const made = await call(fetcher, `${base}/triggers`, "POST", trigger);
    steps.push(
      made.response?.ok && typeof made.json?.id === "string"
        ? { kind: "trigger", label, status: "done", id: made.json.id }
        : { kind: "trigger", label, status: "failed", detail: why(made, "The trigger wasn't made. Add it from the Mission's Triggers.") },
    );
  }

  return { missionId: id, steps, failed: steps.some((s) => s.status === "failed"), ...(error && { error }) };
}

/** A budget as the page shows it: "$100/day, $1,000/week", or with no limit. */
export function budgetText(budget: MissionBudget): string {
  const daily = budget.dailyUsd === null ? "no daily limit" : `${usd(budget.dailyUsd)}/day`;
  const weekly = budget.weeklyUsd === null ? "no weekly limit" : `${usd(budget.weeklyUsd)}/week`;
  return `${daily}, ${weekly}`;
}

/** Dollars as the page shows them: $1,000; none, "no limit". */
export function usd(amount: number | null): string {
  return amount === null ? "no limit" : `$${amount.toLocaleString("en-US")}`;
}
