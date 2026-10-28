"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Inbox, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAppData } from "@/components/app-data";
import { WorkItemDetail } from "@/components/triage/work-item-detail";
import { NewWorkItemForm } from "@/components/triage/new-work-item-form";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loaders";
import { useNow } from "@/hooks/use-now";
import { relativeTime } from "@/lib/nav/sidebar";
import { groupWorkItems, tabCounts, tabOf, TRIAGE_TABS, type TriageTab } from "@/lib/triage/groups";
import type { AccessLevel } from "@/lib/orgs/access";
import { itemKey, SOURCE_LABELS, STATUS_LABELS, type TriageItem } from "@/lib/triage/work-items";
import { cn } from "@/lib/utils";

/**
 * Triage: the work items captured in the app, from Slack and from the CLI,
 * by workspace, with the one picked (`?item=`) beside them — or the capture
 * form (`?new=1`, ⌘I). Below `md` the list and the item take turns.
 */
export function TriageView() {
  const search = useSearchParams();
  const router = useRouter();
  const selectedId = search.get("item");
  const capturing = search.get("new") === "1";
  const data = useAppData();
  const projects = data?.projects ?? [];
  const [items, setItems] = useState<TriageItem[] | null>(null);
  // The caller's level on each project, and on all of them: where they may
  // move an item to.
  const [levels, setLevels] = useState<Record<string, AccessLevel>>({});
  const [orgLevel, setOrgLevel] = useState<AccessLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabChoice, setTab] = useState<TriageTab | null>(null);
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
      setItems(body.items);
      setLevels(body.projects ?? {});
      setOrgLevel(body.orgLevel ?? null);
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

  // The tab picked; else the one the open item is on, else Triage.
  const selected = items?.find((item) => item.id === selectedId) ?? null;
  const tab = tabChoice ?? (selected ? tabOf(selected.status) : "triage");
  const counts = items ? tabCounts(items) : null;
  const groups = items ? groupWorkItems(items, projects, tab) : [];
  const showingDetail = capturing || selectedId !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Inbox className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Triage</h1>
        </div>
        <Button size="sm" variant="outline" onClick={() => router.push("/triage?new=1", { scroll: false })}>
          <Plus />
          New item
          <kbd className="ml-1 font-sans text-[11px] text-muted-foreground">⌘I</kbd>
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <section
          aria-label="Work items"
          className={cn("min-h-0 flex-col border-border/60 md:flex md:border-r", showingDetail ? "hidden" : "flex")}
        >
          <nav className="flex shrink-0 gap-1 px-3 pt-3 pb-2" aria-label="Status">
            {TRIAGE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-pressed={tab === t.id}
                className={cn(
                  "rounded-md px-2 py-1 text-[13px] transition-colors",
                  tab === t.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                {t.label}
                {counts && counts[t.id] > 0 && (
                  <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground">{counts[t.id]}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {error && <p className="px-2 py-4 text-xs text-destructive">{error}</p>}
            {!items && !error && (
              <div className="flex justify-center py-8">
                <Spinner label="Loading triage" />
              </div>
            )}
            {items && groups.length === 0 && <EmptyTab tab={tab} />}
            {groups.map((group) => (
              <div key={group.key} className="mt-2">
                <h2 className="px-2 pb-1 text-[12px] text-muted-foreground">{group.label}</h2>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => open(item.id)}
                        aria-current={item.id === selectedId ? "true" : undefined}
                        className={cn(
                          "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
                          item.id === selectedId ? "bg-accent" : "hover:bg-accent/60",
                        )}
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{itemKey(item)}</span>
                          <span className="truncate text-[13px]">{item.title}</span>
                        </span>
                        <span className="flex gap-2 text-[11px] text-muted-foreground">
                          {tab !== "triage" && <span>{STATUS_LABELS[item.status]}</span>}
                          <span>{SOURCE_LABELS[item.source]}</span>
                          <span>{relativeTime(item.updatedAt, now)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section
          aria-label={capturing ? "New work item" : "Work item"}
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
          {capturing ? (
            <NewWorkItemForm
              projects={projects}
              onCreated={(item) => {
                changed();
                setTab("triage");
                open(item.id);
              }}
              onCancel={() => open(selectedId)}
            />
          ) : selectedId ? (
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
            <NothingOpen hasItems={(items?.length ?? 0) > 0} />
          )}
        </section>
      </div>
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
  return <p className="px-2 py-6 text-xs text-muted-foreground">{text}</p>;
}

function NothingOpen({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm text-muted-foreground">
        {hasItems ? "Pick an item to triage it." : "Capture work here instead of in another tracker."}
      </p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Add items with ⌘I, from Slack with the “Send to Outrunner triage” shortcut or <code>/triage</code>, or from
        the terminal with <code>outrunner triage</code>.{" "}
        <Link href="/settings/integrations" className="underline underline-offset-4">
          Connect Slack
        </Link>
      </p>
    </div>
  );
}
