"use client";

import Link from "next/link";
import { ArrowUp, ArrowUpRight, Check, CircleSlash, Copy, Pencil, Play, RotateCcw, SquarePen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Markdown } from "@/components/markdown";
import { SourceIcon, StatusIcon } from "@/components/triage/item-icons";
import { PropertyChip } from "@/components/triage/property-chip";
import { WorkspaceSelect } from "@/components/triage/workspace-select";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/loaders";
import { useNow } from "@/hooks/use-now";
import { relativeTime } from "@/lib/nav/sidebar";
import {
  isOpen,
  itemHref,
  itemKey,
  SOURCE_LABELS,
  STATUS_LABELS,
  type TriageItem,
  type WorkItem,
  type WorkItemNote,
  type WorkItemPatch,
  type WorkItemStatus,
} from "@/lib/triage/work-items";

type Loaded = { item: TriageItem; notes: WorkItemNote[] };

/**
 * One work item: its title and Markdown body (both editable), what can be
 * done with it from where it stands (a banner while it waits in triage), its
 * activity with a box to add a note, and beside them its properties.
 */
export function WorkItemDetail({
  id,
  projects,
  moveTargets,
  canUnsort,
  items,
  onChanged,
}: {
  id: string;
  projects: { id: string; fullName: string }[];
  /** The workspaces the user may move items to (write on them). */
  moveTargets: { id: string; fullName: string }[];
  /** Whether they may move items to Unsorted (write on all projects). */
  canUnsort: boolean;
  /** The list, to pick what this one duplicates from. */
  items: WorkItem[];
  onChanged: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(60_000);

  const load = useCallback(async () => {
    const response = await fetch(`/api/triage/items/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 404) {
      setMissing(true);
      return;
    }
    const body = (await response.json().catch(() => ({}))) as Partial<Loaded> & { error?: string };
    if (!response.ok || !body.item) {
      setError(body.error ?? "Couldn't load the item.");
      return;
    }
    setLoaded({ item: body.item, notes: body.notes ?? [] });
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(() => setError("Couldn't reach Outrunner."));
  }, [load]);

  /** Change the item; resolves whether it took. */
  const update = async (patch: WorkItemPatch): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/triage/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await response.json().catch(() => ({}))) as { item?: TriageItem; error?: string };
      if (!response.ok || !body.item) throw new Error(body.error ?? "Couldn't change the item.");
      const item = body.item;
      setLoaded((current) =>
        current ? { ...current, item: { ...item, ownSession: current.item.ownSession } } : current,
      );
      onChanged();
      return true;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Couldn't change the item.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (missing) return <p className="px-6 py-10 text-sm text-muted-foreground">This item doesn&apos;t exist anymore.</p>;
  if (!loaded) {
    return error ? (
      <p className="px-6 py-10 text-sm text-destructive">{error}</p>
    ) : (
      <div className="flex justify-center py-16">
        <Spinner label="Loading the item" />
      </div>
    );
  }

  const { item, notes } = loaded;
  const duplicateOf = item.duplicateOf ? items.find((other) => other.id === item.duplicateOf) : null;
  const duplicateCandidates = items.filter((other) => other.id !== item.id && isOpen(other.status));
  const workspaceSelect = (
    <WorkspaceSelect
      // Its own workspace is named even where the user can't move items to it.
      projects={item.can.triage ? withCurrent(moveTargets, projects, item.projectId) : projects}
      value={item.projectId}
      disabled={busy || !item.can.triage}
      allowUnsorted={canUnsort}
      onChange={(projectId) => void update({ projectId })}
    />
  );
  const statusMenu = (
    <StatusMenu item={item} candidates={duplicateCandidates} disabled={busy || !item.can.triage} update={update} />
  );
  const source = item.sourceUrl ? (
    <a
      href={item.sourceUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
    >
      {SOURCE_LABELS[item.source]}
      <ArrowUpRight className="size-3" />
    </a>
  ) : (
    SOURCE_LABELS[item.source]
  );

  return (
    <div className="flex min-h-full">
      <article className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 px-5 py-6 md:px-10 md:py-8">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <span className="font-mono text-xs text-muted-foreground">{itemKey(item)}</span>
          <SessionActions item={item} busy={busy} update={update} />
        </div>

        {item.status === "triage" && item.can.triage && (
          <TriageBanner item={item} candidates={duplicateCandidates} busy={busy} update={update} />
        )}

        <div className="flex flex-col gap-2">
          <TitleField
            key={item.title}
            title={item.title}
            disabled={busy || !item.can.triage}
            onSave={(title) => update({ title })}
          />
          <BodyField
            key={item.body}
            body={item.body}
            disabled={busy}
            editable={item.can.triage}
            onSave={(body) => update({ body })}
          />
        </div>

        {/* Narrower than lg the properties sit here, as chips. */}
        <div className="flex flex-wrap items-center gap-1.5 lg:hidden">
          {statusMenu}
          {workspaceSelect}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {!item.can.triage && (
          <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            You can see this item, add notes and start a session from it. Triaging it needs write on{" "}
            {item.projectId ? "its workspace" : "all of the org's workspaces"} (Settings → Roles &amp; access).
          </p>
        )}

        <Activity
          item={item}
          notes={notes}
          now={now}
          onAdded={(note) => {
            setLoaded((current) => (current ? { ...current, notes: [...current.notes, note] } : current));
            onChanged();
          }}
        />
      </article>

      <aside
        aria-label="Properties"
        className="hidden w-72 shrink-0 border-l border-border/60 lg:block"
      >
        <div className="sticky top-0 flex flex-col gap-5 px-4 py-6">
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2.5 text-xs">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="min-w-0">{statusMenu}</dd>
            <dt className="text-muted-foreground">Workspace</dt>
            <dd className="min-w-0">{workspaceSelect}</dd>
            {duplicateOf && (
              <>
                <dt className="text-muted-foreground">Duplicate of</dt>
                <dd className="min-w-0 truncate">
                  <Link href={itemHref(duplicateOf)} className="hover:underline">
                    <span className="font-mono text-muted-foreground">{itemKey(duplicateOf)}</span> {duplicateOf.title}
                  </Link>
                </dd>
              </>
            )}
          </dl>
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-2.5 border-t border-border/60 pt-5 text-xs">
            <dt className="text-muted-foreground">Source</dt>
            <dd className="text-foreground/90">{source}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd className="text-foreground/90">{ago(item.createdAt, now)}</dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd className="text-foreground/90">{ago(item.updatedAt, now)}</dd>
          </dl>
        </div>
      </aside>
    </div>
  );
}

/** "5m ago", or "just now". */
function ago(iso: string, now: number): string {
  const age = relativeTime(iso, now);
  return age === "now" ? "just now" : `${age} ago`;
}

/** `targets`, with the workspace the item is in added when it isn't one. */
function withCurrent(
  targets: { id: string; fullName: string }[],
  all: { id: string; fullName: string }[],
  current: string | null,
): { id: string; fullName: string }[] {
  if (!current || targets.some((t) => t.id === current)) return targets;
  return [...all.filter((p) => p.id === current), ...targets];
}

const STATUS_ORDER: WorkItemStatus[] = ["triage", "todo", "in_progress", "done", "declined"];

/** The item's status as a chip; its menu sets another, or marks it a
 *  duplicate of an open item. */
function StatusMenu({
  item,
  candidates,
  disabled,
  update,
}: {
  item: TriageItem;
  candidates: WorkItem[];
  disabled: boolean;
  update: (patch: WorkItemPatch) => Promise<boolean>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <PropertyChip aria-label="Status" className="disabled:opacity-100">
          <StatusIcon status={item.status} />
          {STATUS_LABELS[item.status]}
        </PropertyChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} className="w-52">
        {STATUS_ORDER.map((status) => (
          <DropdownMenuItem
            key={status}
            onSelect={() => {
              if (status !== item.status) void update({ status });
            }}
          >
            <StatusIcon status={status} />
            <span className="flex-1 text-[13px]">{STATUS_LABELS[status]}</span>
            {status === item.status && <Check className="text-foreground" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={candidates.length === 0}>
            <StatusIcon status="duplicate" />
            <span className="flex-1 text-[13px]">Duplicate of…</span>
          </DropdownMenuSubTrigger>
          <DuplicateCandidates candidates={candidates} update={update} sub />
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The open items one may be marked a duplicate of, as menu items. */
function DuplicateCandidates({
  candidates,
  update,
  sub = false,
}: {
  candidates: WorkItem[];
  update: (patch: WorkItemPatch) => Promise<boolean>;
  /** In a submenu rather than a menu of its own. */
  sub?: boolean;
}) {
  const Content = sub ? DropdownMenuSubContent : DropdownMenuContent;
  return (
    <Content collisionPadding={8} className="max-h-80 w-72 overflow-y-auto">
      {candidates.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No open items.</p>}
      {candidates.map((other) => (
        <DropdownMenuItem
          key={other.id}
          onSelect={() => void update({ status: "duplicate", duplicateOf: other.id })}
        >
          <StatusIcon status={other.status} />
          <span className="w-11 shrink-0 font-mono text-[11px] text-muted-foreground">{itemKey(other)}</span>
          <span className="truncate text-[13px]">{other.title}</span>
        </DropdownMenuItem>
      ))}
    </Content>
  );
}

/** Over an item waiting in triage: where it came from, and accept, mark a
 *  duplicate, or decline. */
function TriageBanner({
  item,
  candidates,
  busy,
  update,
}: {
  item: TriageItem;
  candidates: WorkItem[];
  busy: boolean;
  update: (patch: WorkItemPatch) => Promise<boolean>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-orange-500/25 bg-orange-500/[0.06] py-2 pr-2 pl-3">
      <div className="flex flex-1 items-center gap-2 text-xs whitespace-nowrap">
        <StatusIcon status="triage" />
        <span className="text-foreground/90">
          In triage <span className="text-muted-foreground">· {SOURCE_LABELS[item.source]}</span>
        </span>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-1.5">
        <Button size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => void update({ status: "todo" })}>
          <Check className="size-3.5" />
          Accept
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={busy}>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs">
              <Copy className="size-3.5" />
              Duplicate
            </Button>
          </DropdownMenuTrigger>
          <DuplicateCandidates candidates={candidates} update={update} />
        </DropdownMenu>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
          disabled={busy}
          onClick={() => void update({ status: "declined" })}
        >
          <CircleSlash className="size-3.5" />
          Decline
        </Button>
      </div>
    </div>
  );
}

/** Starting a session on the item, opening the one started, or reopening a
 *  closed one: what fits where it stands. */
function SessionActions({
  item,
  busy,
  update,
}: {
  item: TriageItem;
  busy: boolean;
  update: (patch: WorkItemPatch) => Promise<boolean>;
}) {
  // A session needs a repository: an Unsorted item is given one first.
  const startHref = item.projectId ? `/new?project=${item.projectId}&triage=${item.id}` : null;
  const start = startHref ? (
    <Button asChild size="sm" className="h-7 px-2.5 text-xs">
      <Link href={startHref}>
        <Play className="size-3.5" />
        Start session
      </Link>
    </Button>
  ) : (
    <Button size="sm" className="h-7 px-2.5 text-xs" disabled title="Pick a workspace first">
      <Play className="size-3.5" />
      Start session
    </Button>
  );

  // A session's page is its starter's alone: others start their own.
  const openOwn =
    item.workspaceId && item.ownSession ? (
      <Button asChild size="sm" variant="outline" className="h-7 px-2.5 text-xs">
        <Link href={`/workspaces/${item.workspaceId}`}>
          <ArrowUpRight className="size-3.5" />
          Open session
        </Link>
      </Button>
    ) : null;

  if (item.status === "todo") return start;
  if (item.status === "in_progress") return openOwn ?? start;
  if (item.status === "triage" || !item.can.triage) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2.5 text-xs"
      disabled={busy}
      onClick={() => void update({ status: "triage" })}
    >
      <RotateCcw className="size-3.5" />
      Reopen
    </Button>
  );
}

/** The title, edited in place (wrapping as it grows): saved as it loses
 *  focus, or on Enter. */
function TitleField({
  title,
  disabled,
  onSave,
}: {
  title: string;
  disabled: boolean;
  onSave: (title: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(title);
  const save = () => {
    const next = value.trim();
    if (!next) setValue(title);
    else if (next !== title) void onSave(next);
  };
  return (
    <textarea
      aria-label="Title"
      rows={1}
      value={value}
      maxLength={200}
      disabled={disabled}
      // A title is one line: a pasted line break becomes a space.
      onChange={(event) => setValue(event.target.value.replace(/\s*\n\s*/g, " "))}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setValue(title);
          event.currentTarget.blur();
        }
      }}
      className="field-sizing-content -mx-1.5 w-[calc(100%+0.75rem)] resize-none rounded-md bg-transparent px-1.5 py-0.5 text-xl font-semibold tracking-tight outline-none hover:bg-accent/40 focus-visible:bg-transparent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:hover:bg-transparent"
    />
  );
}

/** The Markdown body: shown rendered, edited as text. */
function BodyField({
  body,
  disabled,
  editable,
  onSave,
}: {
  body: string;
  disabled: boolean;
  /** False shows it only: editing needs triage rights. */
  editable: boolean;
  onSave: (body: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(body);

  if (editing) {
    const save = async () => {
      if (value === body || (await onSave(value))) setEditing(false);
    };
    const cancel = () => {
      setValue(body);
      setEditing(false);
    };
    return (
      <div className="flex flex-col overflow-hidden rounded-lg border border-border focus-within:ring-[3px] focus-within:ring-ring/30">
        <textarea
          autoFocus
          aria-label="Description"
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              cancel();
            }
          }}
          className="field-sizing-content min-h-40 w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground"
          placeholder="Add description… Markdown works."
        />
        <div className="flex items-center justify-end gap-1.5 border-t border-border/60 bg-muted/30 px-2 py-1.5">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" className="h-7 text-xs" disabled={disabled} onClick={() => void save()}>
            Save
            <kbd className="font-sans text-[11px] opacity-70">⌘↵</kbd>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative">
      {body.trim() ? (
        <div className="text-sm leading-relaxed">
          <Markdown>{body}</Markdown>
        </div>
      ) : editable ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-sm text-muted-foreground/70 hover:text-muted-foreground"
        >
          Add description…
        </button>
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}
      {editable && body.trim() && (
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setEditing(true)}
          className="absolute top-0 right-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="Edit description"
        >
          <Pencil />
        </Button>
      )}
    </div>
  );
}

/**
 * The item's history: when and where it was captured, then its notes, oldest
 * first, and a box to add one (⌘Enter).
 */
function Activity({
  item,
  notes,
  now,
  onAdded,
}: {
  item: TriageItem;
  notes: WorkItemNote[];
  now: number;
  onAdded: (note: WorkItemNote) => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!value.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/triage/items/${encodeURIComponent(item.id)}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: value }),
      });
      const body = (await response.json().catch(() => ({}))) as { note?: WorkItemNote; error?: string };
      if (!response.ok || !body.note) throw new Error(body.error ?? "Couldn't add the note.");
      setValue("");
      onAdded(body.note);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Couldn't add the note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Activity" className="mt-2 flex flex-col gap-4 border-t border-border/60 pt-6">
      <h2 className="text-[13px] font-medium">Activity</h2>
      <ol className="flex flex-col gap-3">
        <li className="flex items-center gap-2.5 pl-1 text-xs text-muted-foreground">
          <span className="flex size-5 items-center justify-center">
            {item.source === "app" ? <SquarePen className="size-3.5" /> : <SourceIcon source={item.source} />}
          </span>
          <span>
            Captured from{" "}
            {item.sourceUrl ? (
              <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="text-foreground/90 hover:underline">
                {SOURCE_LABELS[item.source]}
              </a>
            ) : (
              <span className="text-foreground/90">{SOURCE_LABELS[item.source]}</span>
            )}{" "}
            · {ago(item.createdAt, now)}
          </span>
        </li>
        {notes.map((note) => (
          <li key={note.id} className="rounded-lg border border-border/60 bg-card px-3.5 py-2.5">
            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs whitespace-nowrap">
              <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium uppercase text-muted-foreground">
                {(note.author ?? "You").slice(0, 1)}
              </span>
              <span className="font-medium">{note.author ?? "You"}</span>
              {note.source !== "app" &&
                (note.sourceUrl ? (
                  <a
                    href={note.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
                  >
                    via {SOURCE_LABELS[note.source]}
                    <ArrowUpRight className="size-3" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">via {SOURCE_LABELS[note.source]}</span>
                ))}
              <span className="text-muted-foreground">· {ago(note.createdAt, now)}</span>
            </div>
            <div className="pl-7 text-sm">
              <Markdown>{note.body}</Markdown>
            </div>
          </li>
        ))}
      </ol>
      <div className="relative rounded-lg border border-border/70 bg-card transition-shadow focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/20">
        <textarea
          aria-label="Add a note"
          placeholder="Leave a note…"
          value={value}
          disabled={saving}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void add();
            }
          }}
          className="field-sizing-content block min-h-20 w-full resize-none bg-transparent px-3.5 pt-3 pb-11 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
        />
        <div className="absolute right-2 bottom-2 left-3.5 flex items-center justify-between gap-2">
          <span className="truncate text-xs text-destructive">{error}</span>
          <Button
            size="icon-sm"
            variant={value.trim() ? "default" : "outline"}
            className="size-7 rounded-full"
            disabled={!value.trim() || saving}
            onClick={() => void add()}
            aria-label="Add note (⌘↵)"
            title="Add note (⌘↵)"
          >
            <ArrowUp className="size-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
}
