"use client";

/**
 * A Mission's page header: its icon (click to pick another), its name (click
 * to rename), its project, how many Ships it has out of how many, and the
 * Slack channel it's on call in (connect, pause, disconnect).
 */

import { FolderGit2, Users, Zap } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { MissionGlyph, StatusDot } from "@/components/missions/mission-parts";
import { MissionSlackChip } from "@/components/missions/mission-slack-chip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { refreshMissions, useMission } from "@/hooks/use-missions";
import { MISSION_ICONS, missionIcon } from "@/lib/missions/icons";
import { MAX_RUNNERS } from "@/lib/missions/rules";
import { MISSION_STATUS_LABEL } from "@/lib/missions/view";
import { cn } from "@/lib/utils";

/** The icon picker's columns, as its grid-cols-5 lays them out. */
const GRID_COLUMNS = 5;

/** Save a change to the Mission; the reason it wasn't saved, or null. */
async function patch(id: string, body: { title?: string; icon?: string }): Promise<string | null> {
  try {
    const response = await fetch(`/api/missions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) {
      const answer = (await response.json().catch(() => null)) as { error?: string } | null;
      return answer?.error ?? "That wasn't saved. Try again.";
    }
    return null;
  } catch {
    return "Couldn't reach Outrunner. Try again.";
  } finally {
    await refreshMissions();
  }
}

export function MissionHeader({ missionId, fallbackTitle }: { missionId: string; fallbackTitle: string }) {
  const { mission } = useMission(missionId);
  const title = mission?.title ?? fallbackTitle;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [icon, setIcon] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const shownIcon = icon ?? mission?.icon ?? null;
  const current = missionIcon(missionId, shownIcon);
  // Ships with work open, archived ones whose pull request is still open too.
  const active = mission?.runners.filter((r) => r.group !== "done").length ?? 0;

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const save = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) void patch(missionId, { title: next }).then(setFailed);
  };

  const grid = useRef<HTMLDivElement>(null);
  const moveInGrid = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -GRID_COLUMNS, ArrowDown: GRID_COLUMNS }[e.key];
    if (!step) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[at + step];
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  };

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <DropdownMenu
        onOpenChange={(open) => {
          // Wait for the portal and Radix's initial focus to mount.
          if (open) requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>("[data-current]")?.focus());
        }}
      >
        <DropdownMenuTrigger
          aria-label={`Mission icon: ${current.label}. Change it`}
          className="rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-white/30"
        >
          <MissionGlyph id={missionId} icon={shownIcon} size="md" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[212px] p-2">
          <DropdownMenuLabel className="px-1 pt-0 pb-2 text-[11.5px] font-normal text-muted-foreground">Mission icon</DropdownMenuLabel>
          {/* Capture arrows before Radix's item handlers move focus in a
              single list; leave selection and typeahead to the menu. */}
          <div ref={grid} className="grid grid-cols-5 gap-1" onKeyDownCapture={moveInGrid}>
            {MISSION_ICONS.map(({ key, label, Icon }) => (
              <DropdownMenuItem
                key={key}
                aria-label={current.key === key ? `${label}, current` : label}
                data-current={current.key === key || undefined}
                title={label}
                textValue={label}
                onSelect={() => {
                  setIcon(key);
                  // Not saved: back to the one it has, and why.
                  void patch(missionId, { icon: key }).then((why) => {
                    setFailed(why);
                    if (why) setIcon(null);
                  });
                }}
                className={cn(
                  "grid size-8 place-items-center justify-center rounded-md p-0 text-[#bdbdbd] transition-colors hover:bg-white/[0.07] hover:text-white focus:bg-white/[0.07] focus:text-white [&_svg:not([class*='text-'])]:text-current",
                  current.key === key && "bg-white/[0.09] text-white ring-1 ring-white/20",
                )}
              >
                <Icon className="size-4" strokeWidth={1.75} />
              </DropdownMenuItem>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing ? (
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
          }}
          aria-label="Mission name"
          maxLength={120}
          className="h-7 min-w-0 rounded-md border border-white/20 bg-transparent px-2 text-[14px] text-[#ededed] outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
          title="Rename"
          className="min-w-0 truncate rounded-md px-1 py-0.5 text-left text-[14px] text-[#ededed] transition-colors hover:bg-white/[0.05]"
        >
          {title}
        </button>
      )}
      {failed && (
        <span role="alert" className="shrink-0 truncate text-[12px] text-[#ffa198]" title={failed}>
          {failed}
        </span>
      )}
      {mission && (
        <span className="hidden shrink-0 items-center gap-1.5 text-[12px] text-[#8f8f8f] sm:inline-flex" title={MISSION_STATUS_LABEL[mission.status]}>
          <StatusDot status={mission.status} />
          {MISSION_STATUS_LABEL[mission.status]}
        </span>
      )}
      {mission?.environment && (
        <span className="hidden shrink-0 items-center gap-1 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[12px] text-[#a3a3a3] md:inline-flex">
          <FolderGit2 className="size-3" />
          {mission.environment.name}
        </span>
      )}
      {mission && (
        <span
          className="hidden shrink-0 items-center gap-1 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[12px] tabular-nums text-[#a3a3a3] md:inline-flex"
          title={`Ships with work open (archived ones with an open pull request too) · ${mission.liveRunners} of ${MAX_RUNNERS} places taken`}
        >
          <Users className="size-3" />
          {active} Ship{active === 1 ? "" : "s"}
        </span>
      )}
      {mission && <MissionSlackChip missionId={missionId} onError={setFailed} />}
      {mission && (
        <Link
          href={`/missions/${missionId}/triggers`}
          title="What sends this Mission work: schedules, webhooks, watched Slack channels, Linear"
          className="hidden shrink-0 items-center gap-1 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[12px] text-[#a3a3a3] transition-colors hover:bg-white/[0.05] md:inline-flex"
        >
          <Zap className="size-3" />
          Triggers
        </Link>
      )}
    </div>
  );
}
