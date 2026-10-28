"use client";

/**
 * A Mission's page header: its icon (click to pick another), its name (click
 * to rename), its project, and how many Runners it has out of how many.
 */

import { FolderGit2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MissionGlyph, StatusDot } from "@/components/missions/mission-parts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { refreshMissions, useMission } from "@/hooks/use-missions";
import { MISSION_ICONS, missionIcon } from "@/lib/missions/icons";
import { MAX_RUNNERS } from "@/lib/missions/rules";
import { MISSION_STATUS_LABEL } from "@/lib/missions/view";
import { cn } from "@/lib/utils";

async function patch(id: string, body: { title?: string; icon?: string }): Promise<void> {
  await fetch(`/api/missions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await refreshMissions();
}

export function MissionHeader({ missionId, fallbackTitle }: { missionId: string; fallbackTitle: string }) {
  const { mission } = useMission(missionId);
  const title = mission?.title ?? fallbackTitle;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [icon, setIcon] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const shownIcon = icon ?? mission?.icon ?? null;
  const current = missionIcon(missionId, shownIcon);
  // Runners with work open, archived ones whose pull request is still open too.
  const active = mission?.runners.filter((r) => r.group !== "done").length ?? 0;

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const save = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) void patch(missionId, { title: next });
  };

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Icon: ${current.label}. Change it`}
          className="rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-white/30"
        >
          <MissionGlyph id={missionId} icon={shownIcon} size="md" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[212px] p-2">
          <DropdownMenuLabel className="px-1 pt-0 pb-2 text-[11.5px] font-normal text-muted-foreground">Mission icon</DropdownMenuLabel>
          <div role="listbox" aria-label="Icons" className="grid grid-cols-5 gap-1">
            {MISSION_ICONS.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={current.key === key}
                title={label}
                onClick={() => {
                  setIcon(key);
                  void patch(missionId, { icon: key });
                }}
                className={cn(
                  "grid size-8 place-items-center rounded-md text-[#bdbdbd] transition-colors hover:bg-white/[0.07] hover:text-white",
                  current.key === key && "bg-white/[0.09] text-white ring-1 ring-white/20",
                )}
              >
                <Icon className="size-4" strokeWidth={1.75} />
              </button>
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
          className="h-7 min-w-0 rounded-md border border-white/20 bg-black/30 px-2 text-[14px] text-[#ededed] outline-none"
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
          title={`${mission.liveRunners} of ${MAX_RUNNERS} places taken by Runners that aren't archived`}
        >
          <Users className="size-3" />
          {active} Runner{active === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}
