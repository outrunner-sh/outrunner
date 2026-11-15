"use client";

/**
 * The sidebar's Missions (docs/missions.md): each Mission with its icon, a
 * live status (needs you, working, ready, idle) and how many pull requests
 * are ready, its Ships with open work nested under it; its menu archives it
 * with its Ships. Dragged to reorder; arrow keys move between rows. `+`
 * starts a Mission; the one beside it hires one from a template.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ChevronRight, Ellipsis, GitPullRequest, Plus, Rocket, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ArchiveMissionDialog } from "@/components/missions/archive-mission-dialog";
import { HireDialog } from "@/components/missions/hire-dialog";
import { MissionGlyph, PullRequestChip, RunnerGlyph, UnreadDot } from "@/components/missions/mission-parts";
import { NewMissionDialog } from "@/components/missions/new-mission-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SkeletonRows } from "@/components/ui/skeleton-swap";
import { refreshMissions, useMissions } from "@/hooks/use-missions";
import { missionArchiveOffer, unarchivedShipCount } from "@/lib/missions/archive";
import { recentProjects, type NavProject } from "@/lib/nav/workspace-nav-groups";
import { MISSION_STATUS_LABEL, type MissionView, type RunnerView } from "@/lib/missions/view";
import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/** Ships shown under a Mission before "more". */
const SHOWN_RUNNERS = 5;

/** Missions folded shut with their chevron, kept in this browser. */
const FOLDED_KEY = "outrunner.folded-missions";

function savedFolded(): string[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(FOLDED_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Ships with open work (an archived one's pull request still open is),
 *  the ones that need someone first. */
function nestedRunners(mission: MissionView): RunnerView[] {
  const order = { needs_you: 0, ready_to_merge: 1, ready_to_review: 2, working: 3, shipping: 4, done: 5 } as const;
  return mission.runners.filter((r) => r.group !== "done").sort((a, b) => order[a.group] - order[b.group]);
}

export function SidebarMissions({
  active,
  projects,
  workspaces,
}: {
  active?: string;
  projects: NavProject[];
  /** The sidebar's sessions: which projects were used last. */
  workspaces: Workspace[];
}) {
  const { loaded, missions } = useMissions();
  const [creating, setCreating] = useState(false);
  const [hiring, setHiring] = useState(false);
  const [archiving, setArchiving] = useState<MissionView | null>(null);
  // Missions whose Ships are all shown, not just the first few.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Missions whose Ships are hidden, as Projects fold; read once mounted, so
  // the server's page and the first render agree.
  const [folded, setFolded] = useState<readonly string[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFolded(savedFolded());
  }, []);
  const toggleFolded = (id: string) => {
    const next = folded.includes(id) ? folded.filter((f) => f !== id) : [...folded, id];
    setFolded(next);
    try {
      if (next.length > 0) window.localStorage.setItem(FOLDED_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(FOLDED_KEY);
    } catch {
      // Blocked storage only costs remembering it.
    }
  };
  // A partial attempt refreshes Missions; use that live row rather than the
  // object captured when the menu opened.
  const archiveTarget = archiving && (missions.find((mission) => mission.id === archiving.id) ?? archiving);
  const router = useRouter();
  // Dragged into place here, before the server has it.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // The open session's project first, then the most recently used: an org
  // can have hundreds, and the dialog shows the first few.
  const offered = useMemo(
    () =>
      recentProjects(projects, [...workspaces, ...missions], [...workspaces, ...missions].find((w) => w.id === active)?.projectId),
    [projects, workspaces, missions, active],
  );

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
        {/* Hire: a Mission from a template (On-call, CI fixer, Release manager). */}
        <button
          type="button"
          onClick={() => setHiring(true)}
          aria-label="Hire a Mission from a template"
          title="Hire a Mission from a template"
          className="mr-0.5 ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <UserPlus className="size-3.5" />
        </button>
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
              <span className="block truncate text-[11.5px] text-muted-foreground">It plans; Ships do the work</span>
            </span>
          </button>
        ) : (
          <ul className="space-y-px">
            {shown.map((mission) => {
              const runners = nestedRunners(mission);
              const isFolded = runners.length > 0 && folded.includes(mission.id);
              // The Ship you're on is always listed: folded, it's the only one,
              // as a folded Project keeps its open session (lib/nav/sidebar.ts
              // shownSessions); open, it's added past the first few.
              const current = runners.find((runner) => runner.id === active);
              const firstFew = runners.slice(0, expanded.has(mission.id) ? undefined : SHOWN_RUNNERS);
              const shownRunners = isFolded
                ? current ? [current] : []
                : current && !firstFew.includes(current) ? [...firstFew, current] : firstFew;
              const isActive = mission.id === active;
              const archived = mission.sessionStatus === "archived";
              const archive = missionArchiveOffer({ status: mission.sessionStatus as WorkspaceStatus, provider: mission.provider });
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
                  <div className="group/mission relative">
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
                      title={archived ? `${mission.title} · Archived. Opening it restores it.` : `${mission.title} · ${MISSION_STATUS_LABEL[mission.status]}`}
                      className={cn(
                        "group/mrow flex items-center gap-2.5 rounded-md px-2 py-1 text-[13px] transition-colors",
                        isActive ? "bg-accent text-foreground" : "text-foreground hover:bg-accent/60",
                        // Room for its chevron and menu as they show; a folded
                        // one's chevron always shows.
                        runners.length > 0
                          ? archive
                            ? cn("group-hover/mission:pr-14 group-focus-within/mission:pr-14 group-has-[[data-state=open]]/mission:pr-14", isFolded && "pr-14")
                            : cn("group-hover/mission:pr-8 group-focus-within/mission:pr-8", isFolded && "pr-8")
                          : archive && "group-hover/mission:pr-8 group-focus-within/mission:pr-8 group-has-[[data-state=open]]/mission:pr-8",
                        dragging === mission.id && "opacity-50",
                      )}
                    >
                      <MissionGlyph id={mission.id} icon={mission.icon} status={mission.status} />
                      <span className={cn("min-w-0 flex-1 truncate", archived && "text-muted-foreground")}>{mission.title}</span>
                      {archived ? (
                        <Archive aria-label="Archived" className="size-3 shrink-0 text-muted-foreground" />
                      ) : mission.readyCount > 0 ? (
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
                      <button
                        type="button"
                        onClick={() => toggleFolded(mission.id)}
                        aria-expanded={!isFolded}
                        aria-label={isFolded ? `Show ${mission.title}'s Ships` : `Hide ${mission.title}'s Ships`}
                        title={isFolded ? `Show Ships (${runners.length})` : "Hide Ships"}
                        className={cn(
                          "absolute top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground outline-none transition hover:bg-accent hover:text-foreground focus-visible:opacity-100",
                          archive ? "right-7" : "right-1",
                          isFolded ? "opacity-100" : "opacity-0 group-hover/mission:opacity-100 group-focus-within/mission:opacity-100",
                        )}
                      >
                        <ChevronRight className={cn("size-3.5 transition-transform", !isFolded && "rotate-90")} />
                      </button>
                    )}
                    {archive && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={`More for ${mission.title}`}
                          title="More"
                          className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 outline-none transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/mission:opacity-100"
                        >
                          <Ellipsis className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-52">
                          <DropdownMenuItem
                            disabled={!archive.can}
                            title={archive.can ? undefined : archive.why}
                            onSelect={() => setArchiving(mission)}
                          >
                            <Archive />
                            Archive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {shownRunners.length > 0 && (
                    <ul className="relative mt-px ml-[17px] space-y-px border-l border-white/[0.07] pl-[7px]">
                      {shownRunners.map((runner) => {
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
                              <RunnerGlyph group={runner.group} state={runner.state} standing={runner.standing} attention={runner.attention} className="size-3" />
                              <span className="min-w-0 flex-1 truncate">{runner.name}</span>
                              <UnreadDot standing={runner.standing} />
                              {pr && <PullRequestChip pr={pr} link={false} compact />}
                            </Link>
                          </li>
                        );
                      })}
                      {!isFolded && runners.length > SHOWN_RUNNERS && (expanded.has(mission.id) || runners.length > shownRunners.length) && (
                        <li>
                          <button
                            type="button"
                            aria-expanded={expanded.has(mission.id)}
                            onClick={() =>
                              setExpanded((now) => {
                                const next = new Set(now);
                                if (!next.delete(mission.id)) next.add(mission.id);
                                return next;
                              })
                            }
                            className="block w-full rounded-md py-[3px] pl-6 text-left text-[12px] text-muted-foreground hover:text-foreground"
                          >
                            {expanded.has(mission.id) ? "Show less" : `${runners.length - shownRunners.length} more`}
                          </button>
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
      <NewMissionDialog open={creating} onOpenChange={setCreating} projects={offered} />
      <HireDialog open={hiring} onOpenChange={setHiring} projects={offered} />
      <ArchiveMissionDialog
        mission={archiveTarget && { id: archiveTarget.id, title: archiveTarget.title, ships: unarchivedShipCount(archiveTarget.runners) }}
        onOpenChange={(open) => {
          if (!open) setArchiving(null);
        }}
        onArchived={(id) => {
          // On screen, it's left: its page would restore it at once.
          if (id === active) {
            router.push("/");
            router.refresh();
          }
        }}
      />
    </section>
  );
}
