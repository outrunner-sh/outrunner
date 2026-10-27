"use client";

import Link from "next/link";
import { ArrowUpRight, Check, CircleSlash, Copy, Pencil, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Markdown } from "@/components/markdown";
import { WorkspaceSelect } from "@/components/triage/workspace-select";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loaders";
import { Textarea } from "@/components/ui/textarea";
import { useNow } from "@/hooks/use-now";
import { relativeTime } from "@/lib/nav/sidebar";
import {
  isOpen,
  itemKey,
  SOURCE_LABELS,
  STATUS_LABELS,
  type TriageItem,
  type WorkItem,
  type WorkItemNote,
  type WorkItemPatch,
} from "@/lib/triage/work-items";

type Loaded = { item: TriageItem; notes: WorkItemNote[] };

/**
 * One work item: its title and Markdown body (both editable), the workspace
 * it is in, what can be done with it from where it stands, and its notes,
 * with a box to add one.
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

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{itemKey(item)}</span>
        <span className="rounded-full border border-border px-2 py-0.5 text-foreground">{STATUS_LABELS[item.status]}</span>
        <span>
          {item.sourceUrl ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 hover:text-foreground"
            >
              From {SOURCE_LABELS[item.source]}
              <ArrowUpRight className="size-3" />
            </a>
          ) : (
            `From ${SOURCE_LABELS[item.source]}`
          )}{" "}
          · {relativeTime(item.createdAt, now)} ago
        </span>
      </div>

      <TitleField
        key={item.title}
        title={item.title}
        disabled={busy || !item.can.triage}
        onSave={(title) => update({ title })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <WorkspaceSelect
          // Its own workspace is named even where the user can't move items to it.
          projects={item.can.triage ? withCurrent(moveTargets, projects, item.projectId) : projects}
          value={item.projectId}
          disabled={busy || !item.can.triage}
          allowUnsorted={canUnsort}
          onChange={(projectId) => void update({ projectId })}
        />
        <Actions item={item} items={items} busy={busy} update={update} />
      </div>

      {duplicateOf && (
        <p className="text-xs text-muted-foreground">
          Duplicate of{" "}
          <Link href={`/triage?item=${duplicateOf.id}`} className="underline underline-offset-4">
            {itemKey(duplicateOf)} {duplicateOf.title}
          </Link>
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {!item.can.triage && (
        <p className="text-xs text-muted-foreground">
          You can see this item, add notes and start a session from it. Triaging it needs write on{" "}
          {item.projectId ? "its workspace" : "all of the org's workspaces"} (Settings → Roles &amp; access).
        </p>
      )}

      <BodyField
        key={item.body}
        body={item.body}
        disabled={busy}
        editable={item.can.triage}
        onSave={(body) => update({ body })}
      />

      <Notes
        itemId={item.id}
        notes={notes}
        now={now}
        onAdded={(note) => {
          setLoaded((current) => (current ? { ...current, notes: [...current.notes, note] } : current));
          onChanged();
        }}
      />
    </article>
  );
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

/** What can be done with the item from where it stands. */
function Actions({
  item,
  items,
  busy,
  update,
}: {
  item: TriageItem;
  items: WorkItem[];
  busy: boolean;
  update: (patch: WorkItemPatch) => Promise<boolean>;
}) {
  const [pickingDuplicate, setPickingDuplicate] = useState(false);
  // A session needs a repository: an Unsorted item is given one first.
  const startHref = item.projectId ? `/new?project=${item.projectId}&triage=${item.id}` : null;
  const start = startHref ? (
    <Button asChild size="sm">
      <Link href={startHref}>
        <Play />
        Start session
      </Link>
    </Button>
  ) : (
    <Button size="sm" disabled title="Pick a workspace first">
      <Play />
      Start session
    </Button>
  );

  // A session's page is its starter's alone: others start their own.
  const openOwn =
    item.workspaceId && item.ownSession ? (
      <Button asChild size="sm" variant="outline">
        <Link href={`/workspaces/${item.workspaceId}`}>
          <ArrowUpRight />
          Open session
        </Link>
      </Button>
    ) : null;

  // Seen but not triaged by this user: they may still start a session on an
  // accepted one.
  if (!item.can.triage) return isOpen(item.status) && item.status !== "triage" ? (openOwn ?? start) : null;

  if (pickingDuplicate) {
    const candidates = items.filter((other) => other.id !== item.id && isOpen(other.status));
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Duplicate of"
          defaultValue=""
          disabled={busy}
          onChange={async (event) => {
            if (!event.target.value) return;
            if (await update({ status: "duplicate", duplicateOf: event.target.value })) setPickingDuplicate(false);
          }}
          className="h-8 max-w-64 rounded-md border border-input bg-transparent px-2 text-[13px] dark:bg-input/30"
        >
          <option value="">Duplicate of…</option>
          {candidates.map((other) => (
            <option key={other.id} value={other.id}>
              {itemKey(other)} {other.title}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => setPickingDuplicate(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  switch (item.status) {
    case "triage":
      return (
        <>
          <Button size="sm" disabled={busy} onClick={() => void update({ status: "todo" })}>
            <Check />
            Accept
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void update({ status: "declined" })}>
            <CircleSlash />
            Decline
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPickingDuplicate(true)}>
            <Copy />
            Duplicate…
          </Button>
        </>
      );
    case "todo":
      return (
        <>
          {start}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void update({ status: "done" })}>
            <Check />
            Done
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ status: "triage" })}>
            <RotateCcw />
            Back to triage
          </Button>
        </>
      );
    case "in_progress":
      return (
        <>
          {openOwn ?? start}
          <Button size="sm" disabled={busy} onClick={() => void update({ status: "done" })}>
            <Check />
            Done
          </Button>
        </>
      );
    default:
      return (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void update({ status: "triage" })}>
          <RotateCcw />
          Reopen
        </Button>
      );
  }
}

/** The title, edited in place: saved as it loses focus, or on Enter. */
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
    <input
      aria-label="Title"
      value={value}
      maxLength={200}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setValue(title);
          event.currentTarget.blur();
        }
      }}
      className="w-full rounded-md bg-transparent text-lg font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
    return (
      <div className="flex flex-col gap-2">
        <Textarea
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
              setValue(body);
              setEditing(false);
            }
          }}
          className="min-h-40 font-mono text-[13px]"
          placeholder="Markdown works."
        />
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setValue(body);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={disabled} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative">
      {body.trim() ? (
        <div className="text-sm">
          <Markdown>{body}</Markdown>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}
      {editable && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setEditing(true)}
          className="mt-2 text-muted-foreground"
          aria-label="Edit description"
        >
          <Pencil />
          Edit
        </Button>
      )}
    </div>
  );
}

/** The item's notes, oldest first, and a box to add one (⌘Enter). */
function Notes({
  itemId,
  notes,
  now,
  onAdded,
}: {
  itemId: string;
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
      const response = await fetch(`/api/triage/items/${encodeURIComponent(itemId)}/notes`, {
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
    <section aria-label="Notes" className="flex flex-col gap-3 border-t border-border/60 pt-5">
      <h2 className="text-xs font-medium text-muted-foreground">Notes{notes.length > 0 && ` · ${notes.length}`}</h2>
      {notes.map((note) => (
        <div key={note.id} className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{note.author ?? "You"}</span>
            {note.source !== "app" &&
              (note.sourceUrl ? (
                <a href={note.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center hover:text-foreground">
                  {SOURCE_LABELS[note.source]}
                  <ArrowUpRight className="size-3" />
                </a>
              ) : (
                <span>{SOURCE_LABELS[note.source]}</span>
              ))}
            <span>{relativeTime(note.createdAt, now)}</span>
          </div>
          <div className="text-sm">
            <Markdown>{note.body}</Markdown>
          </div>
        </div>
      ))}
      <Textarea
        aria-label="Add a note"
        placeholder="Add a note… Markdown works. ⌘↵ to add."
        value={value}
        disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void add();
          }
        }}
        className="text-[13px]"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-destructive">{error}</span>
        <Button size="sm" variant="outline" disabled={!value.trim() || saving} onClick={() => void add()}>
          Add note
        </Button>
      </div>
    </section>
  );
}
