"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Check, ChevronDown, GitMerge, GitPullRequest, LayoutList, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppData } from "@/components/app-data";
import { ConfirmSessionDialog } from "@/components/confirm-session-dialog";
import { StandingMark } from "@/components/sidebar-status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Spinner } from "@/components/ui/loaders";
import { useLocalSessions } from "@/hooks/use-local-sessions";
import { useNow } from "@/hooks/use-now";
import { useStandings } from "@/hooks/use-standings";
import { localSessionLabel } from "@/lib/desktop/local-sessions";
import { relativeTime, type SessionDeletion } from "@/lib/nav/sidebar";
import { archiveOffer, archiveSession } from "@/lib/session/archive-control";
import { deleteSession } from "@/lib/session/delete-session";
import { canDestroy } from "@/lib/session/provisioning";
import {
  filterSessions,
  NO_FILTER,
  ownSessionEntries,
  ownerChoices,
  SOURCE_LABEL,
  standingOf,
  type ListFilter,
  type SessionListEntry,
  type SessionSource,
} from "@/lib/session/session-list";
import { STANDING_LABEL, STANDINGS, type Standing } from "@/lib/session/standing";
import { cancelWarmOnRest, warmOnRest, warmSession } from "@/lib/session/warm-session";
import { cn } from "@/lib/utils";

/**
 * Every session in the org the user may see: searched, filtered by owner,
 * source and where it stands, newest first. The user's own can be picked
 * several at a time to archive or delete, each after a confirmation.
 *
 * The page opens on the list the layout already holds — the user's own cloud
 * sessions, and this Mac's — so it shows rows rather than a spinner, and only
 * what the frame can't describe waits on this page's own read of the org's
 * sessions (lib/session/session-list.ts). Rows warm their session as the
 * pointer rests, as the sidebar's do: a click lands on one already attaching.
 */
export function SessionsList() {
  const router = useRouter();
  const now = useNow(60_000);
  const local = useLocalSessions();
  const live = useStandings();
  const [cloud, setCloud] = useState<SessionListEntry[] | null>(null);
  const data = useAppData();
  const seed = useMemo(() => ownSessionEntries(data), [data]);
  // The server's read of the whole org once it answers; the layout's own data
  // until then. Null only before either, with nothing to list at all.
  const known = cloud ?? seed;
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { sessions?: SessionListEntry[]; error?: string };
      if (!response.ok || !body.sessions) throw new Error(body.error ?? "Couldn't load the sessions.");
      setCloud(body.sessions);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Couldn't load the sessions.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The user's own cloud sessions as the frame keeps them live, and this
  // Mac's, which only the browser can read.
  const entries = useMemo<SessionListEntry[]>(() => {
    const ours = (known ?? []).map((e) => (e.mine && live[e.id] ? { ...e, standing: live[e.id] } : e));
    const mac = local.sessions.map(
      (s): SessionListEntry => ({
        id: s.workspaceId,
        title: localSessionLabel(s),
        branch: s.branch,
        project: s.name,
        owner: ours.find((e) => e.mine)?.owner ?? { id: "me", name: "You", login: null, avatarUrl: null },
        mine: true,
        local: true,
        source: "mac",
        createdAt: s.createdAt,
        at: s.lastActiveAt || s.createdAt,
        status: "ready",
        provider: null,
        pullRequest: null,
        standing: null,
      }),
    );
    return [...ours, ...mac];
  }, [known, live, local.sessions]);
  const shown = filterSessions(entries, filter, now);
  const owners = ownerChoices(entries);

  // What each of the user's sessions offers, for the bulk actions.
  const deletions = useMemo(() => {
    const byId = new Map<string, SessionDeletion>();
    for (const s of local.sessions) byId.set(s.workspaceId, s.inPlace ? { kind: "local-in-place" } : { kind: "local-worktree" });
    for (const e of known ?? []) {
      if (e.mine && canDestroy({ status: e.status, createdAt: e.createdAt }, now)) byId.set(e.id, { kind: "cloud" });
    }
    return byId;
  }, [known, local.sessions, now]);
  const archivable = (e: SessionListEntry) =>
    !e.local && e.provider !== null && archiveOffer({ status: e.status, provider: e.provider })?.can === true;
  const pickable = (e: SessionListEntry) => e.mine && (deletions.has(e.id) || archivable(e));

  const pickedRows = shown.filter((e) => picked.has(e.id));
  const toArchive = pickedRows.filter(archivable);
  const toDelete = pickedRows.filter((e) => deletions.has(e.id));
  const allPicked = shown.some(pickable) && shown.filter(pickable).every((e) => picked.has(e.id));

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(shown.filter(pickable).map((e) => e.id)));

  /** Each in turn; every failure is said, the rest still go. */
  const runEach = async (
    rows: SessionListEntry[],
    act: (e: SessionListEntry) => Promise<string | null | void>,
    verb: string,
  ): Promise<string | null> => {
    const failed: string[] = [];
    // Done, with something to say: an archive without its files.
    const noted: string[] = [];
    for (const row of rows) {
      const note = await act(row).catch(() => void failed.push(row.title));
      if (note) noted.push(row.title);
    }
    if (failed.length > 0) {
      throw new Error(`Couldn't ${verb} ${failed.length === 1 ? `“${failed[0]}”` : `${failed.length} sessions`}. The others were.`);
    }
    if (noted.length === 0) return null;
    return `${noted.length === 1 ? `“${noted[0]}” was` : `${noted.length} sessions were`} ${verb}d without ${noted.length === 1 ? "its" : "their"} files: ${noted.length === 1 ? "its box" : "their boxes"} couldn't be reached, so uncommitted changes couldn't be saved. Anything pushed to GitHub is kept.`;
  };

  const done = () => {
    setPicked(new Set());
    void load();
    local.refresh();
    router.refresh();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
        <LayoutList className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Sessions</h1>
        {cloud && <span className="text-[12px] tabular-nums text-muted-foreground">{entries.length}</span>}
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <label className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border/60 px-2 text-[13px] focus-within:border-border sm:max-w-sm">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={filter.query}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {filter.query && (
            <button type="button" onClick={() => setFilter({ ...filter, query: "" })} aria-label="Clear search" className="text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>
        <FilterMenu
          label="Owner"
          value={filter.owner}
          choices={[
            { value: "anyone", label: "Anyone" },
            { value: "me", label: "Me" },
            ...owners.filter((o) => !o.mine).map((o) => ({ value: o.id, label: o.name })),
          ]}
          onChange={(owner) => setFilter({ ...filter, owner })}
        />
        <FilterMenu
          label="Source"
          value={filter.source}
          choices={[
            { value: "any", label: "Any" },
            ...(Object.keys(SOURCE_LABEL) as SessionSource[]).map((s) => ({ value: s, label: SOURCE_LABEL[s] })),
          ]}
          onChange={(source) => setFilter({ ...filter, source: source as ListFilter["source"] })}
        />
        <FilterMenu
          label="Status"
          value={filter.status}
          choices={[{ value: "any", label: "Any" }, ...STANDINGS.map((s) => ({ value: s, label: STANDING_LABEL[s] }))]}
          onChange={(status) => setFilter({ ...filter, status: status as Standing | "any" })}
        />
        {(filter.owner !== "anyone" || filter.source !== "any" || filter.status !== "any") && (
          <button
            type="button"
            onClick={() => setFilter({ ...NO_FILTER, query: filter.query })}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      {picked.size > 0 && (
        <div
          role="toolbar"
          aria-label="Picked sessions"
          className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-md border border-border/60 bg-accent/40 px-3 py-1.5 text-[13px]"
        >
          <span className="tabular-nums">{picked.size} picked</span>
          <span className="flex-1" />
          <Button size="sm" variant="outline" disabled={toArchive.length === 0} onClick={() => setConfirming("archive")}>
            <Archive />
            Archive{toArchive.length > 0 && toArchive.length !== picked.size ? ` ${toArchive.length}` : ""}
          </Button>
          <Button size="sm" variant="outline" disabled={toDelete.length === 0} onClick={() => setConfirming("delete")}>
            <Trash2 />
            Delete{toDelete.length > 0 && toDelete.length !== picked.size ? ` ${toDelete.length}` : ""}
          </Button>
          <button type="button" onClick={() => setPicked(new Set())} aria-label="Clear picked" className="rounded p-1 text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {error && <p className="py-4 text-xs text-destructive">{error}</p>}
        {/* Only with nothing to show: the seed's rows, and this Mac's, stand
            in until the org's own read lands. Whether the list is empty is
            still the server's to say — of the user's own sessions only the
            layout knows, and another member may have sessions in it. */}
        {!cloud && !error && shown.length === 0 && (
          <div className="flex justify-center py-8">
            <Spinner label="Loading sessions" />
          </div>
        )}
        {cloud && shown.length === 0 && (
          <p className="py-8 text-center text-[13px] text-muted-foreground">
            {entries.length === 0 ? "No sessions yet." : "No sessions match."}
          </p>
        )}
        {shown.length > 0 && (
          <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr className="text-left text-[12px] text-muted-foreground">
                <th className="w-8 py-2 font-normal">
                  <Checkbox checked={allPicked} onChange={toggleAll} label="Pick every session shown" disabled={!shown.some(pickable)} />
                </th>
                <th className="py-2 font-normal">Session</th>
                <th className="hidden w-[22%] py-2 font-normal md:table-cell">Repository</th>
                <th className="hidden w-[16%] py-2 font-normal lg:table-cell">Owner</th>
                <th className="hidden w-[11%] py-2 font-normal lg:table-cell">Source</th>
                <th className="w-[13%] py-2 font-normal">Status</th>
                <th className="w-14 py-2 text-right font-normal">Created</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const standing = standingOf(e, now);
                const href = e.local ? `/local/${e.id}` : `/workspaces/${e.id}`;
                // As the sidebar's rows: a cloud session rests into a warm-up
                // on the way to opening it. Only one's own can be opened.
                const warm = e.mine && !e.local;
                return (
                  <tr key={e.id} className={cn("group", picked.has(e.id) && "bg-accent/40")}>
                    <td className="border-t border-border/40 py-1.5 align-middle">
                      {pickable(e) && <Checkbox checked={picked.has(e.id)} onChange={() => toggle(e.id)} label={`Pick ${e.title}`} />}
                    </td>
                    <td className="border-t border-border/40 py-1.5 pr-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <StandingMark standing={standing} />
                        {e.mine ? (
                          <Link
                            href={href}
                            onPointerEnter={warm ? () => warmOnRest(e.id) : undefined}
                            onPointerLeave={warm ? cancelWarmOnRest : undefined}
                            onFocus={warm ? () => warmSession(e.id) : undefined}
                            className={cn("min-w-0 truncate hover:underline", standing.unread && "font-medium")}
                            title={e.title}
                          >
                            {e.title}
                          </Link>
                        ) : (
                          // Only its owner can open a session.
                          <span className="min-w-0 truncate text-muted-foreground" title={`${e.title}\nOnly ${e.owner.name} can open it.`}>
                            {e.title}
                          </span>
                        )}
                        {standing.unread && <span aria-label="New reply" className="size-1.5 shrink-0 rounded-full bg-sky-400" />}
                        {e.pullRequest && (
                          <a
                            href={e.pullRequest.url}
                            target="_blank"
                            rel="noreferrer"
                            title={`Pull request #${e.pullRequest.number}, ${e.pullRequest.state}`}
                            className="inline-flex shrink-0 items-center gap-0.5 text-[12px] text-muted-foreground hover:text-foreground"
                          >
                            {e.pullRequest.state === "merged" ? <GitMerge className="size-3" /> : <GitPullRequest className="size-3" />}#{e.pullRequest.number}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="hidden truncate border-t border-border/40 py-1.5 pr-3 text-muted-foreground md:table-cell" title={e.project}>
                      {e.project}
                    </td>
                    <td className="hidden border-t border-border/40 py-1.5 pr-3 lg:table-cell">
                      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        {e.owner.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={e.owner.avatarUrl} alt="" className="size-4 shrink-0 rounded-full" />
                        ) : (
                          <span className="size-4 shrink-0 rounded-full bg-accent" />
                        )}
                        <span className="truncate">{e.mine ? "You" : e.owner.name}</span>
                      </span>
                    </td>
                    <td className="hidden border-t border-border/40 py-1.5 pr-3 text-muted-foreground lg:table-cell">{SOURCE_LABEL[e.source]}</td>
                    <td className="border-t border-border/40 py-1.5 pr-3 text-muted-foreground">
                      {STANDING_LABEL[standing.standing]}
                      {standing.moved && <span className="text-muted-foreground/60"> · moved</span>}
                    </td>
                    <td className="border-t border-border/40 py-1.5 text-right text-[12px] tabular-nums text-muted-foreground">
                      <time dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString()} suppressHydrationWarning>
                        {relativeTime(e.createdAt, now)}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmSessionDialog
        open={confirming === "archive"}
        title={`Archive ${toArchive.length === 1 ? `“${toArchive[0]?.title}”` : `${toArchive.length} sessions`}?`}
        description={
          <>
            Each one&apos;s work is saved, uncommitted changes included, and its space on the cloud computer is freed. Opening one again restores it.
            {toArchive.length < picked.size && ` ${picked.size - toArchive.length} of those picked can't be archived now and stay as they are.`}
          </>
        }
        busyLabel="Archiving"
        failure="Could not archive them."
        confirm={(go) => (
          <button type="button" onClick={go} className="route-state-button is-primary">
            Archive {toArchive.length === 1 ? "session" : `${toArchive.length} sessions`}
          </button>
        )}
        run={() => runEach(toArchive, (e) => archiveSession(e.id), "archive")}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        onDone={done}
      />
      <ConfirmSessionDialog
        open={confirming === "delete"}
        title={`Delete ${toDelete.length === 1 ? `“${toDelete[0]?.title}”` : `${toDelete.length} sessions`}?`}
        description={
          <>
            {toDelete.length === 1 ? "Its worktree is" : "Their worktrees are"} removed; anything pushed to GitHub stays
            {toDelete.some((e) => e.local) && ", and a Mac session's branch stays in its repository"}. This can&apos;t be undone.
            {toDelete.length < picked.size && ` ${picked.size - toDelete.length} of those picked can't be deleted now and stay as they are.`}
          </>
        }
        busyLabel="Deleting"
        failure="Could not delete them."
        confirm={(go) => <HoldToConfirm label={toDelete.length === 1 ? "Delete session" : `Delete ${toDelete.length} sessions`} onConfirm={go} />}
        run={() => runEach(toDelete, (e) => deleteSession(e.id, deletions.get(e.id)!), "delete")}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        onDone={done}
      />
    </div>
  );
}

function FilterMenu({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const current = choices.find((c) => c.value === value) ?? choices[0];
  const filtering = value !== choices[0]?.value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[13px] outline-none transition-colors hover:bg-accent/60",
          filtering ? "border-border text-foreground" : "border-border/60 text-muted-foreground",
        )}
      >
        <span className="text-muted-foreground">{label}:</span> {current?.label}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {choices.map((choice, i) => (
            <div key={choice.value}>
              {i === 1 && <DropdownMenuSeparator />}
              <DropdownMenuRadioItem value={choice.value}>{choice.label}</DropdownMenuRadioItem>
            </div>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "grid size-4 place-items-center rounded border transition-colors disabled:opacity-30",
        checked ? "border-foreground bg-foreground text-background" : "border-border hover:border-muted-foreground",
      )}
    >
      {checked && <Check className="size-3" />}
    </button>
  );
}
