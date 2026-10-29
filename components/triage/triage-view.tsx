"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronRight, FolderGit2, Inbox, Plus, SquarePen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAppData } from "@/components/app-data";
import { SourceIcon, StatusIcon } from "@/components/triage/item-icons";
import { WorkItemDetail } from "@/components/triage/work-item-detail";
import { NewWorkItemForm } from "@/components/triage/new-work-item-form";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loaders";
import { useNow } from "@/hooks/use-now";
import { relativeTime } from "@/lib/nav/sidebar";
import type { AccessLevel } from "@/lib/orgs/access";
import { rememberTriage, useTriage } from "@/lib/triage/kept-triage";
import { groupWorkItems, tabCounts, tabOf, TRIAGE_TABS, type TriageTab } from "@/lib/triage/groups";
import { captureHref, itemKey, STATUS_LABELS, type TriageItem } from "@/lib/triage/work-items";
import { cn } from "@/lib/utils";

/**
 * Triage: the work items captured in the app, from Slack and from the CLI,
 * by workspace, with the one picked (`?item=`) beside them — and the capture
 * dialog over them (`?new=1`, ⌘I; `&project=` starts it in a workspace).
 * Below `md` the list and the item take turns.
 */
export function TriageView() {
  const search = useSearchParams();
  const router = useRouter();
  const selectedId = search.get("item");
  const capturing = search.get("new") === "1";
  const captureProject = search.get("project");
  const data = useAppData();
  const projects = data?.projects ?? [];
  // The list, where items may be moved and the caller's level on all of them:
  // the last answer, or what triage kept from the last visit, so a re-entry
  // paints at once and this look reconciles behind it (lib/triage/kept-triage.ts).
  const { items, levels, orgLevel } = useTriage();
  const [error, setError] = useState<string | null>(null);
  const [tabChoice, setTab] = useState<TriageTab | null>(null);
  // Groups folded shut, by key ("" is Unsorted).
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const now = useNow(60_000);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/triage/items", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as {
        items?: TriageItem[];
        projects?: Record<string, AccessLevel>;
        orgLevel?: AccessLevel | null;
        error?: string;
      };
      if (!response.ok || !body.items) throw new Error(body.error ?? "Couldn't load triage.");
      // The server's list always wins over what was kept.
      rememberTriage({ items: body.items, levels: body.projects ?? {}, orgLevel: body.orgLevel ?? null });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Couldn't load triage.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /** Something changed: re-read the list, and the sidebar's count. */
  const changed = useCallback(() => {
    void load();
    router.refresh();
  }, [load, router]);

  const open = (id: string | null) => router.push(id ? `/triage?item=${id}` : "/triage", { scroll: false });
  /** The capture dialog, over whatever is open, in `projectId` if given. */
  const capture = (projectId?: string) =>
    router.push(captureHref({ item: selectedId, project: projectId }), { scroll: false });
  const toggle = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // The tab picked; else the one the open item is on, else Triage.
  const selected = items?.find((item) => item.id === selectedId) ?? null;
  const tab = tabChoice ?? (selected ? tabOf(selected.status) : "triage");
  const counts = items ? tabCounts(items) : null;
  const groups = items ? groupWorkItems(items, projects, tab) : [];
  const showingDetail = selectedId !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border/60 pr-2 pl-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="flex items-center gap-2 text-[13px] font-medium">
            <Inbox className="size-4 text-muted-foreground" />
            Triage
          </h1>
          <nav className="flex items-center gap-1" aria-label="Status">
            {TRIAGE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-pressed={tab === t.id}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
                  tab === t.id
                    ? "border-border bg-accent text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {t.label}
                {counts && counts[t.id] > 0 && (
                  <span className="text-[11px] tabular-nums text-muted-foreground">{counts[t.id]}</span>
                )}
              </button>
            ))}
          </nav>
        </div>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => capture()}>
          <SquarePen className="size-3.5" />
          New item
          <kbd className="font-sans text-[11px] text-muted-foreground">⌘I</kbd>
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
        <section
          aria-label="Work items"
          className={cn("min-h-0 flex-col border-border/60 md:flex md:border-r", showingDetail ? "hidden" : "flex")}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error && <p className="px-4 py-4 text-xs text-destructive">{error}</p>}
            {!items && !error && (
              <div className="flex justify-center py-8">
                <Spinner label="Loading triage" />
              </div>
            )}
            {items && groups.length === 0 && <EmptyTab tab={tab} />}
            {groups.map((group) => {
              const shut = folded.has(group.key);
              return (
                <div key={group.key}>
                  <div className="group/header sticky top-0 z-10 flex h-8 items-center gap-1.5 border-b border-border/40 bg-muted/70 pr-1.5 pl-2 backdrop-blur-sm">
                    <button
                      type="button"
                      onClick={() => toggle(group.key)}
                      aria-expanded={!shut}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <ChevronRight
                        className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !shut && "rotate-90")}
                      />
                      {group.key ? (
                        <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <Inbox className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <h2 className="truncate font-medium">{group.label}</h2>
                      <span className="tabular-nums text-muted-foreground">{group.items.length}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => capture(group.key || undefined)}
                      aria-label={`New item in ${group.label}`}
                      className="rounded-sm p-1 text-muted-foreground opacity-0 outline-none transition-opacity group-hover/header:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  {!shut && (
                    <ul>
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => open(item.id)}
                            aria-current={item.id === selectedId ? "true" : undefined}
                            title={`${itemKey(item)} ${item.title} · ${STATUS_LABELS[item.status]}`}
                            className={cn(
                              "flex h-9 w-full items-center gap-2.5 border-b border-border/30 px-4 text-left outline-none transition-colors focus-visible:bg-accent/60",
                              item.id === selectedId ? "bg-accent" : "hover:bg-accent/50",
                            )}
                          >
                            <span className="w-11 shrink-0 font-mono text-[11px] text-muted-foreground">
                              {itemKey(item)}
                            </span>
                            <StatusIcon status={item.status} />
                            <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                            <SourceIcon source={item.source} className="text-muted-foreground/70" />
                            <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                              {relativeTime(item.updatedAt, now)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section
          aria-label="Work item"
          className={cn("min-h-0 overflow-y-auto", showingDetail ? "block" : "hidden md:block")}
        >
          {showingDetail && (
            <div className="px-4 pt-3 md:hidden">
              <button
                type="button"
                onClick={() => open(null)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                All items
              </button>
            </div>
          )}
          {selectedId ? (
            <WorkItemDetail
              key={selectedId}
              id={selectedId}
              projects={projects}
              moveTargets={projects.filter((p) => levels[p.id] === "write")}
              canUnsort={orgLevel === "write"}
              items={items ?? []}
              onChanged={changed}
            />
          ) : (
            <NothingOpen hasItems={(items?.length ?? 0) > 0} onCapture={() => capture()} />
          )}
        </section>
      </div>

      {capturing && (
        <NewWorkItemForm
          key={captureProject ?? ""}
          projects={projects}
          initialProjectId={captureProject}
          onCreated={(item, more) => {
            changed();
            if (more) return;
            setTab("triage");
            open(item.id);
          }}
          onCancel={() => open(selectedId)}
        />
      )}
    </div>
  );
}

function EmptyTab({ tab }: { tab: TriageTab }) {
  const text =
    tab === "triage"
      ? "Nothing waiting. New captures from Slack, the CLI, or ⌘I land here."
      : tab === "backlog"
        ? "Nothing accepted yet. Accept an item in Triage to move it here."
        : "Nothing closed yet.";
  return <p className="px-4 py-8 text-center text-xs text-muted-foreground">{text}</p>;
}

function NothingOpen({ hasItems, onCapture }: { hasItems: boolean; onCapture: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl border border-border/70 bg-muted/40">
        <Inbox className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">
        {hasItems ? "Pick an item to triage it" : "Capture work here instead of in another tracker"}
      </p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        Add items with ⌘I, from Slack with the “Send to Outrunner triage” shortcut or <code>/triage</code>, or from
        the terminal with <code>outrunner triage</code>.{" "}
        <Link href="/settings/integrations" className="underline underline-offset-4">
          Connect Slack
        </Link>
      </p>
      <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={onCapture}>
        <SquarePen className="size-3.5" />
        New item
      </Button>
    </div>
  );
}
