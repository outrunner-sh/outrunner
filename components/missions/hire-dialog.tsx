"use client";

/**
 * Hire (docs/missions.md, "Hire"): a Mission from a template. Pick one and
 * its project, edit its name or instructions if you like, and it's made
 * with its default triggers and budgets (lib/missions/hire.ts). The page
 * then moves to the new Mission while this shows how each step went, and
 * offers its Slack channel.
 */

import { ArrowUp, Check, ChevronRight, ExternalLink, Minus, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { HireSlackStep } from "@/components/missions/hire-slack-step";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/loaders";
import { refreshMissions } from "@/hooks/use-missions";
import { describeSchedule } from "@/lib/automations/schedule";
import { hireMission, type HireOutcome, type HireStep } from "@/lib/missions/hire";
import { MISSION_ICONS } from "@/lib/missions/icons";
import {
  budgetFields,
  buildHirePlan,
  localTimeZone,
  MISSION_NAME_MAX,
  MISSION_TEMPLATES,
  type MissionTemplate,
  parseBudgetAmount,
  type TemplateTrigger,
} from "@/lib/missions/templates";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import { askPermission } from "@/lib/notifications/show";
import { firstPromptSearch, newFirstPrompt, tabStorage } from "@/lib/session/first-prompt";
import { cn } from "@/lib/utils";

function triggerSummary(trigger: TemplateTrigger): string {
  if (trigger.triggers[0] === "webhook") return "Webhook (point CI at it)";
  return trigger.schedules.map(describeSchedule).join(", ");
}

export function HireDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Likeliest first. */
  projects: NavProject[];
}) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState<MissionTemplate["id"]>("on-call");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  // As typed; "no limit" is null.
  const [daily, setDaily] = useState<string>("100");
  const [weekly, setWeekly] = useState<string>("1000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hired, setHired] = useState<(HireOutcome & { missionId: string; suggestsSlack: boolean; title: string }) | null>(null);
  const template = MISSION_TEMPLATES.find((t) => t.id === templateId) ?? MISSION_TEMPLATES[0];
  const chosen = projectId ?? projects[0]?.id ?? null;
  const timezone = localTimeZone();
  const dailyUsd = parseBudgetAmount(daily);
  const weeklyUsd = parseBudgetAmount(weekly);
  const budgetsOk = dailyUsd.ok && weeklyUsd.ok;

  // Opened afresh: the picker again, its last choices cleared.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHired(null);
    setError(null);
    setName("");
    setPrompt(null);
    const fields = budgetFields(MISSION_TEMPLATES[0]);
    setDaily(fields.daily);
    setWeekly(fields.weekly);
  }, [open]);

  const pick = (id: MissionTemplate["id"]) => {
    const picked = MISSION_TEMPLATES.find((t) => t.id === id) ?? MISSION_TEMPLATES[0];
    const fields = budgetFields(picked);
    setTemplateId(id);
    setName("");
    setPrompt(null);
    // The fields follow the template being hired, as the name and
    // instructions do (edits included), so its own budget reaches the hire.
    setDaily(fields.daily);
    setWeekly(fields.weekly);
  };

  const hire = async () => {
    if (!chosen || busy || !dailyUsd.ok || !weeklyUsd.ok) return;
    // As Start a Mission does: asked while the click is still the gesture.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void askPermission();
    setBusy(true);
    setError(null);
    const plan = buildHirePlan(template, {
      projectId: chosen,
      timezone,
      name,
      prompt: prompt ?? undefined,
      budget: { dailyUsd: dailyUsd.value, weeklyUsd: weeklyUsd.value },
    });
    const outcome = await hireMission(plan, (url, init) => fetch(url, init));
    setBusy(false);
    if (!outcome.missionId) {
      setError(outcome.steps[0]?.detail ?? "The Mission didn't start. Try again.");
      return;
    }
    void refreshMissions();
    setHired({ ...outcome, missionId: outcome.missionId, suggestsSlack: plan.suggestsSlack, title: plan.profile.title });
    // Onto the Mission, which sends its instructions as its first message;
    // this stays open over it with how each step went.
    router.push(`/workspaces/${outcome.missionId}${firstPromptSearch(tabStorage(), outcome.missionId, newFirstPrompt(plan.create.prompt, []))}`);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[560px] flex-col gap-0 overflow-hidden rounded-xl border-white/10 p-0">
        <div className="flex shrink-0 items-start gap-3 border-b border-white/[0.07] px-5 pt-5 pb-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04]">
            <UserPlus className="size-[18px] text-[#e5e5e5]" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[15px] font-medium">{hired ? `Hired ${hired.title}` : "Hire a Mission"}</DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-[#8f8f8f]">
              {hired
                ? hired.failed
                  ? "The Mission is made. A step below didn't finish: do it from the Mission."
                  : "The Mission is made and starting."
                : "A ready-made Mission: its instructions, triggers and budgets set up for you."}
            </DialogDescription>
          </div>
        </div>
        {hired ? (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {hired.error && (
                <p role="alert" className="rounded-md border border-[#f85149]/30 bg-[#f85149]/[0.08] px-3 py-2 text-[12.5px] text-[#ffa198]">
                  {hired.error}
                </p>
              )}
              <ol className="space-y-1.5">
                {hired.steps.map((step, i) => (
                  <HireStepRow key={i} step={step} missionId={hired.missionId} onLeave={() => onOpenChange(false)} />
                ))}
              </ol>
              <HireSlackStep missionId={hired.missionId} suggested={hired.suggestsSlack} />
            </div>
            <div className="flex shrink-0 items-center justify-end gap-3 border-t border-white/[0.07] px-5 py-3">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex h-8 items-center rounded-md bg-[#ededed] px-3 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-white"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div role="radiogroup" aria-label="Template" className="grid gap-2 sm:grid-cols-3">
                {MISSION_TEMPLATES.map((t) => {
                  const Icon = MISSION_ICONS.find((i) => i.key === t.icon)?.Icon ?? UserPlus;
                  const on = t.id === template.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => pick(t.id)}
                      className={cn(
                        "flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        on ? "border-white/30 bg-white/[0.06]" : "border-white/10 hover:border-white/20",
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-[#ededed]">
                        <Icon className="size-3.5" strokeWidth={1.75} />
                        {t.name}
                      </span>
                      <span className="text-[11.5px] leading-snug text-[#8f8f8f]">{t.description}</span>
                    </button>
                  );
                })}
              </div>
              <div>
                <label htmlFor="hire-project" className="mb-1.5 block text-[12px] text-[#8f8f8f]">
                  Repository
                </label>
                {projects.length === 0 ? (
                  <p className="text-[12.5px] text-[#8f8f8f]">Add a repository first, from Environments.</p>
                ) : (
                  <select
                    id="hire-project"
                    value={chosen ?? ""}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="h-8 w-full rounded-md border border-white/10 bg-transparent px-2 text-[13px] text-[#ededed] outline-none focus:border-white/25"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id} className="bg-[#111]">
                        {p.fullName}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label htmlFor="hire-name" className="mb-1.5 block text-[12px] text-[#8f8f8f]">
                  Name
                </label>
                <input
                  id="hire-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={template.name}
                  maxLength={MISSION_NAME_MAX}
                  className="h-8 w-full rounded-md border border-white/10 bg-transparent px-2.5 text-[13px] text-[#ededed] outline-none placeholder:text-[#5f5f5f] focus:border-white/25"
                />
              </div>
              <details className="group rounded-md border border-white/[0.08]">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[12.5px] text-[#a3a3a3] hover:text-white">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                  Instructions
                </summary>
                <textarea
                  aria-label="Instructions"
                  value={prompt ?? template.prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={9}
                  className="block w-full resize-y border-t border-white/[0.08] bg-transparent px-3 py-2.5 font-mono text-[12px] leading-relaxed text-[#ededed] outline-none"
                />
              </details>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
                <dt className="text-[#8f8f8f]">Triggers</dt>
                <dd className="text-[#d6d6d6]">
                  {template.triggers(timezone).map(triggerSummary).join("; ") || (template.suggestsSlack ? "None: it takes requests from Slack" : "None")}
                </dd>
              </dl>
              <fieldset>
                <legend className="mb-1.5 text-[12px] text-[#8f8f8f]">Budgets</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <BudgetField label="Per day" value={daily} onChange={setDaily} parsed={dailyUsd} fallback="100" />
                  <BudgetField label="Per week" value={weekly} onChange={setWeekly} parsed={weeklyUsd} fallback="1000" />
                </div>
              </fieldset>
              {error && (
                <p role="alert" className="rounded-md border border-[#f85149]/30 bg-[#f85149]/[0.08] px-3 py-2 text-[12.5px] text-[#ffa198]">
                  {error}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.07] px-5 py-3">
              <span className="text-[11.5px] text-[#6f6f6f]">Change any of it later from the Mission</span>
              <button
                type="button"
                onClick={() => void hire()}
                disabled={!chosen || busy || !budgetsOk || !(prompt ?? template.prompt).trim()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#ededed] px-3 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
              >
                {busy ? <Spinner className="size-3.5" label="Hiring" /> : <ArrowUp className="size-3.5" />}
                Hire {template.name}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A budget in dollars, or No limit; why it isn't one, inline. */
function BudgetField({
  label,
  value,
  onChange,
  parsed,
  fallback,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  parsed: ReturnType<typeof parseBudgetAmount>;
  /** What unticking No limit brings back. */
  fallback: string;
}) {
  const id = useId();
  const none = parsed.ok && parsed.value === null;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[12px] text-[#a3a3a3]">
          {label}
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] text-[#8f8f8f]">
          <input type="checkbox" checked={none} onChange={(e) => onChange(e.target.checked ? "no limit" : fallback)} className="size-3" />
          No limit
        </label>
      </div>
      <div className="relative mt-1">
        {!none && <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-[#8f8f8f]">$</span>}
        <input
          id={id}
          inputMode="decimal"
          value={none ? "No limit" : value}
          disabled={none}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!parsed.ok}
          aria-describedby={parsed.ok ? undefined : `${id}-error`}
          className={cn(
            "h-8 w-full rounded-md border bg-transparent pr-2.5 text-[13px] text-[#ededed] outline-none disabled:text-[#8f8f8f]",
            none ? "pl-2.5" : "pl-6",
            parsed.ok ? "border-white/10 focus:border-white/25" : "border-[#f85149]/60",
          )}
        />
      </div>
      {!parsed.ok && (
        <p id={`${id}-error`} className="mt-1 text-[11.5px] text-[#ffa198]">
          {parsed.error}
        </p>
      )}
    </div>
  );
}

/** One step of the hire: done, skipped or failed, with where to finish it. */
function HireStepRow({ step, missionId, onLeave }: { step: HireStep; missionId: string; onLeave: () => void }) {
  const triggers = `/missions/${missionId}/triggers`;
  return (
    <li className="flex items-start gap-2 text-[12.5px]">
      {step.status === "done" ? (
        <Check aria-label="Done" className="mt-0.5 size-3.5 shrink-0 text-[#56d364]" />
      ) : step.status === "skipped" ? (
        <Minus aria-label="Skipped" className="mt-0.5 size-3.5 shrink-0 text-[#8f8f8f]" />
      ) : (
        <X aria-label="Failed" className="mt-0.5 size-3.5 shrink-0 text-[#f85149]" />
      )}
      <span className="min-w-0">
        <span className={cn(step.status === "failed" ? "text-[#ffa198]" : "text-[#d6d6d6]")}>{step.label}</span>
        {step.detail && <span className="block text-[11.5px] text-[#8f8f8f]">{step.detail}</span>}
        {step.kind === "trigger" && (
          <Link
            href={step.status === "done" && step.id ? `${triggers}/${step.id}` : `${triggers}/new`}
            onClick={onLeave}
            className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-[#a3a3a3] underline-offset-2 hover:text-white hover:underline"
          >
            {step.status === "done" ? "Open the trigger" : "Add it from Triggers"}
            <ExternalLink className="size-3" />
          </Link>
        )}
      </span>
    </li>
  );
}
