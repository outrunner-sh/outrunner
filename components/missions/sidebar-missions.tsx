"use client";

/**
 * The sidebar's Missions (docs/missions.md): each Mission with its icon, a
 * live status (needs you, working, ready, idle) and how many pull requests
 * are ready, its Runners with open work nested under it. Dragged to reorder;
 * arrow keys move between rows. `+` starts a Mission.
 */

import Link from "next/link";
import { GitPullRequest, Plus, Rocket } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MissionGlyph, PullRequestChip, RunnerGlyph, UnreadDot } from "@/components/missions/mission-parts";
import { NewMissionDialog } from "@/components/missions/new-mission-dialog";
import { SkeletonRows } from "@/components/ui/skeleton-swap";
import { refreshMissions, useMissions } from "@/hooks/use-missions";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import { MISSION_STATUS_LABEL, type MissionView, type RunnerView } from "@/lib/missions/view";
import { cn } from "@/lib/utils";

/** Runners shown under a Mission before "more". */
const SHOWN_RUNNERS = 5;

/** Runners with open work (an archived one's pull request still open is),
 *  the ones that need someone first. */
function nestedRunners(mission: MissionView): RunnerView[] {
  const order = { needs_you: 0, ready_to_merge: 1, ready_to_review: 2, working: 3, shipping: 4, done: 5 } as const;
  return mission.runners.filter((r) => r.group !== "done").sort((a, b) => order[a.group] - order[b.group]);
}

export function SidebarMissions({ active, projects }: { active?: string; projects: NavProject[] }) {
  const { loaded, missions } = useMissions();
  const [creating, setCreating] = useState(false);
  // Dragged into place here, before the server has it.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const shown = order
    ? [...missions].sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9))
    : missions;

  // Once the server's order matches what was dragged, it's the server's again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (order && missions.map((m) => m.id).join() === order.join()) setOrder(null);
  }, [missions, order]);

  const drop = (target: string) => {
    if (!dragging || dragging === target) return;
    // Dragged down, it goes after the row it's dropped on; up, before: so
    // the last place can be reached.
    const from = shown.findIndex((m) => m.id === dragging);
    const ids = shown.map((m) => m.id).filter((id) => id !== dragging);
    const to = ids.indexOf(target);
    ids.splice(from <= to ? to + 1 : to, 0, dragging);
    setOrder(ids);
    // Not saved: back to the server's order, which the next look shows.
    void fetch("/api/missions/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }).then(
      (response) => (response.ok ? refreshMissions() : setOrder(null)),
      () => setOrder(null),
    );
  };

  // ↑/↓ between the section's rows.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-mission-row]") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <section aria-labelledby="missions-heading" className="mb-4">
      <div className="flex items-center justify-between px-2">
        <h2 id="missions-heading" className="text-[13px] text-muted-foreground">
          Missions
        </h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          aria-label="Start a Mission"
          title="Start a Mission"
          className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <div ref={list} className="mt-1.5" onKeyDown={onKeyDown}>
        {!loaded ? (
          <SkeletonRows rows={2} rowHeight={28} indent={34} />
        ) : shown.length === 0 ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="group/new flex w-full items-center gap-2.5 rounded-md border border-dashed border-white/10 px-2 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:border-white/20 hover:bg-accent/40 hover:text-foreground"
          >
            <span className="grid size-[18px] place-items-center rounded-[5px] bg-white/[0.04]">
              <Rocket className="size-[11px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-foreground/90">Start a Mission</span>
              <span className="block truncate text-[11.5px] text-muted-foreground">It plans; Runners do the work</span>
            </span>
          </button>
        ) : (
          <ul className="space-y-px">
            {shown.map((mission) => {
              const runners = nestedRunners(mission);
              const isActive = mission.id === active;
              return (
                <li
                  key={mission.id}
                  className={cn("mission-in", over === mission.id && dragging !== mission.id && "shadow-[inset_0_2px_0_rgba(255,255,255,.35)]")}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    setOver(mission.id);
                  }}
                  onDragLeave={() => setOver((o) => (o === mission.id ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    drop(mission.id);
                    setOver(null);
                  }}
                >
                  <Link
                    href={`/workspaces/${mission.id}`}
                    data-mission-row=""
                    draggable
                    onDragStart={(e) => {
                      setDragging(mission.id);
                      // Replace the link's text/URL so dropping on a text field
                      // inserts nothing. Firefox still needs data to start a drag.
                      e.dataTransfer.clearData();
                      e.dataTransfer.setData("application/x-outrunner-mission", mission.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    aria-current={isActive ? "page" : undefined}
                    title={`${mission.title} · ${MISSION_STATUS_LABEL[mission.status]}`}
                    className={cn(
                      "group/mrow flex items-center gap-2.5 rounded-md px-2 py-1 text-[13px] transition-colors",
                      isActive ? "bg-accent text-foreground" : "text-foreground hover:bg-accent/60",
                      dragging === mission.id && "opacity-50",
                    )}
                  >
                    <MissionGlyph id={mission.id} icon={mission.icon} status={mission.status} />
                    <span className="min-w-0 flex-1 truncate">{mission.title}</span>
                    {mission.readyCount > 0 ? (
                      <span
                        className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-[#3fb950]/12 px-1.5 text-[11px] font-medium tabular-nums text-[#56d364]"
                        title={`${mission.readyCount} pull request${mission.readyCount === 1 ? "" : "s"} ready`}
                      >
                        <GitPullRequest className="size-3" />
                        {mission.readyCount}
                      </span>
                    ) : mission.status === "needs_you" ? (
                      <span className="shrink-0 text-[11px] font-medium text-brand">Needs you</span>
                    ) : null}
                  </Link>
                  {runners.length > 0 && (
                    <ul className="relative mt-px ml-[17px] space-y-px border-l border-white/[0.07] pl-[7px]">
                      {runners.slice(0, SHOWN_RUNNERS).map((runner) => {
                        const pr = runner.pulls.find((p) => p.state === "open") ?? runner.pulls.find((p) => p.state === "merged");
                        return (
                          <li key={runner.id} className="mission-in">
                            <Link
                              href={`/workspaces/${runner.id}`}
                              data-mission-row=""
                              aria-current={runner.id === active ? "page" : undefined}
                              title={runner.attention ? `${runner.name}: ${runner.attention}` : runner.name}
                              className={cn(
                                "flex items-center gap-2 rounded-md py-[3px] pr-2 pl-1.5 text-[12.5px] transition-colors",
                                runner.id === active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                              )}
                            >
                              <RunnerGlyph group={runner.group} state={runner.state} standing={runner.standing} className="size-3" />
                              <span className="min-w-0 flex-1 truncate">{runner.name}</span>
                              <UnreadDot standing={runner.standing} />
                              {pr && <PullRequestChip pr={pr} link={false} />}
                            </Link>
                          </li>
                        );
                      })}
                      {runners.length > SHOWN_RUNNERS && (
                        <li>
                          <Link
                            href={`/workspaces/${mission.id}`}
                            className="block rounded-md py-[3px] pl-6 text-[12px] text-muted-foreground hover:text-foreground"
                          >
                            {runners.length - SHOWN_RUNNERS} more
                          </Link>
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <NewMissionDialog open={creating} onOpenChange={setCreating} projects={projects} />
    </section>
  );
}
