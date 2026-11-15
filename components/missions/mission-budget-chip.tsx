"use client";

/**
 * A Mission's budget in its header (docs/missions.md, "Budgets"): spent today
 * against its daily limit (else this week against its weekly one), "budget
 * reached" while it's budget-paused, and a dialog to see both periods and
 * change the limits. Changing them needs write on the Mission's project;
 * without it, the dialog only shows.
 */

import { Wallet } from "lucide-react";
import { useEffect, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/loaders";
import type { MissionBudgetView } from "@/lib/missions/budget";
import { cn } from "@/lib/utils";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** A limit typed in: dollars, or blank for none. */
function readLimit(text: string): number | null | "bad" {
  const clean = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : "bad";
}

function spentLine(spent: MissionBudgetView["day"], limit: number | null, period: string): string {
  if (!spent) return `Spent ${period}: not known right now`;
  const amount = `${usd(spent.spentUsd)}${spent.partlyUnknown ? "+" : ""}`;
  return `Spent ${period}: ${amount}${limit !== null ? ` of ${usd(limit)}` : ""}${spent.partlyUnknown ? " (partly unknown)" : ""}`;
}

export function MissionBudgetChip({ missionId }: { missionId: string }) {
  const [view, setView] = useState<MissionBudgetView | null>(null);
  const [open, setOpen] = useState(false);
  const [look, setLook] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/missions/${missionId}/budget`, { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<MissionBudgetView>) : null))
      .then((answer) => {
        if (live && answer) setView(answer);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [missionId, look]);

  if (!view) return null;
  const { limits, paused } = view;
  const none = limits.dailyUsd === null && limits.weeklyUsd === null;
  if (none && !view.canEdit) return null;

  // The chip's figure: today against the daily limit, else this week.
  const shown = limits.dailyUsd !== null ? { spent: view.day, limit: limits.dailyUsd, word: "today" } : { spent: view.week, limit: limits.weeklyUsd, word: "this week" };
  const label = paused
    ? "budget reached"
    : none
      ? "Set budget"
      : shown.spent
        ? `${usd(shown.spent.spentUsd)}${shown.spent.partlyUnknown ? "+" : ""} / ${usd(shown.limit ?? 0)}`
        : `${usd(shown.limit ?? 0)} ${shown.word}`;
  const title = paused
    ? `Budget for ${paused.period === "day" ? "today" : "this week"} reached: the Mission takes no work and starts no Ship until ${new Date(paused.until).toLocaleString()}, or until its budget is raised. Running Ships go on.`
    : none
      ? "Give this Mission a daily or weekly dollar budget"
      : `Budget: ${spentLine(shown.spent, shown.limit, shown.word)}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={`Budget: ${label}`}
        className={cn(
          "hidden shrink-0 items-center gap-1 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[12px] tabular-nums text-[#a3a3a3] outline-none transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-white/30 md:inline-flex",
          none && "text-[#8f8f8f]",
          paused && "text-[#d29922]",
        )}
      >
        <Wallet className="size-3" />
        {label}
      </button>
      {open && (
        <BudgetDialog
          missionId={missionId}
          view={view}
          onOpenChange={setOpen}
          onSaved={(next) => {
            setView(next);
            setLook((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

/** Mounted only while open, so it starts from the limits there are. */
function BudgetDialog({
  missionId,
  view,
  onOpenChange,
  onSaved,
}: {
  missionId: string;
  view: MissionBudgetView;
  onOpenChange: (open: boolean) => void;
  onSaved: (view: MissionBudgetView) => void;
}) {
  const [daily, setDaily] = useState(view.limits.dailyUsd?.toString() ?? "");
  const [weekly, setWeekly] = useState(view.limits.weeklyUsd?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dailyUsd = readLimit(daily);
  const weeklyUsd = readLimit(weekly);
  const bad = dailyUsd === "bad" || weeklyUsd === "bad";

  const save = async () => {
    if (bad || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/${missionId}/budget`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dailyUsd, weeklyUsd }),
      });
      const answer = (await response.json().catch(() => null)) as (MissionBudgetView & { error?: string }) | null;
      if (!response.ok || !answer) {
        setError(answer?.error ?? "That wasn't saved. Try again.");
        return;
      }
      onSaved(answer);
      onOpenChange(false);
    } catch {
      setError("Couldn't reach Outrunner. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const field =
    "h-8 w-full rounded-md border border-border bg-input/30 px-2.5 text-[13px] tabular-nums text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-sm gap-5" showClose={!busy}>
        <DialogTitle className="text-[15px] font-medium leading-snug">Budget</DialogTitle>
        <DialogDescription className="text-[12.5px] leading-relaxed text-muted-foreground">
          Models and compute for the Mission and its Ships, by UTC day and week (from Monday). Once a limit is reached, the Mission takes no new
          work and starts no Ship until the period rolls over or the limit is raised. Running Ships go on.
        </DialogDescription>
        {view.paused && (
          <p role="status" className="rounded-md border border-[#d29922]/30 bg-[#d29922]/10 px-2.5 py-2 text-[12.5px] text-[#d29922]">
            Budget for {view.paused.period === "day" ? "today" : "this week"} reached. It goes on {new Date(view.paused.until).toLocaleString()}, or once
            the limit is raised.
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-4"
        >
          <label className="block space-y-1.5">
            <span className="text-[12.5px] text-foreground">Daily limit (USD)</span>
            <input
              inputMode="decimal"
              placeholder="No limit"
              value={daily}
              disabled={busy || !view.canEdit}
              aria-invalid={dailyUsd === "bad" || undefined}
              onChange={(e) => setDaily(e.target.value)}
              className={field}
            />
            <span className="block text-[12px] text-muted-foreground">{spentLine(view.day, view.limits.dailyUsd, "today")}</span>
          </label>
          <label className="block space-y-1.5">
            <span className="text-[12.5px] text-foreground">Weekly limit (USD)</span>
            <input
              inputMode="decimal"
              placeholder="No limit"
              value={weekly}
              disabled={busy || !view.canEdit}
              aria-invalid={weeklyUsd === "bad" || undefined}
              onChange={(e) => setWeekly(e.target.value)}
              className={field}
            />
            <span className="block text-[12px] text-muted-foreground">{spentLine(view.week, view.limits.weeklyUsd, "this week")}</span>
          </label>
          {bad && <p className="text-[12px] text-muted-foreground">A limit is a dollar amount over $0, or blank for none.</p>}
          {!view.canEdit && <p className="text-[12px] text-muted-foreground">Changing it needs write on the Mission&apos;s project.</p>}
          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            {busy ? (
              <span role="status" className="inline-flex h-8 items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner /> Saving
              </span>
            ) : (
              <>
                <button type="button" onClick={() => onOpenChange(false)} className="route-state-button">
                  {view.canEdit ? "Cancel" : "Close"}
                </button>
                {view.canEdit && (
                  <button type="submit" disabled={bad} className="route-state-button is-primary">
                    Save
                  </button>
                )}
              </>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
