"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineMessage } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import { requestJson } from "@/lib/http/request-json";
import { MAX_BODY_CHARS, MAX_TITLE_CHARS, type LearningScope } from "@/lib/learnings/rules";
import type { LearningView } from "@/lib/learnings/routes";

type Org = { id: string; name: string; personal: boolean; admin: boolean };

const ENDPOINT = "/api/learnings";

/**
 * Settings → Learnings: suggestions waiting on the user first (an agent's,
 * or a member's for the org, which its admins decide), then the org's
 * learnings and the user's own, each with a form to add one. An org's
 * learnings are its admins' to change; a member's addition is filed as a
 * suggestion. A personal org shows the user's own alone: they are already
 * in every org.
 */
export function LearningsSettings({ org, initial }: { org: Org; initial: LearningView[] }) {
  const [learnings, setLearnings] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(path: string, init: { method: string; body?: Record<string, unknown> }, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      const answer = await requestJson<{ learnings: LearningView[] }>(path, {
        method: init.method,
        ...(init.body && { body: { ...init.body, orgId: org.id } }),
        has: (d) => Array.isArray(d.learnings),
        fallback,
      });
      setLearnings(answer.learnings);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const add = (scope: LearningScope, title: string, body: string) =>
    change(ENDPOINT, { method: "POST", body: { scope, title, body } }, "Couldn't add that learning. Try again.");
  const save = (id: string, title: string, body: string) =>
    change(`${ENDPOINT}/${id}`, { method: "PATCH", body: { title, body } }, "Couldn't save that learning. Try again.");
  const accept = (id: string) =>
    change(`${ENDPOINT}/${id}`, { method: "PATCH", body: { accept: true } }, "Couldn't accept that learning. Try again.");
  const remove = (id: string) =>
    change(`${ENDPOINT}/${id}?org=${encodeURIComponent(org.id)}`, { method: "DELETE" }, "Couldn't delete that learning. Try again.");

  const showOrg = !org.personal;
  const suggested = learnings.filter((l) => l.status === "suggested" && (showOrg || l.scope === "personal"));
  const orgActive = learnings.filter((l) => l.scope === "org" && l.status === "active");
  const personalActive = learnings.filter((l) => l.scope === "personal" && l.status === "active");

  return (
    <div className="space-y-8">
      {error && <InlineMessage>{error}</InlineMessage>}

      {suggested.length > 0 && (
        <div className="space-y-3 border-t border-border/60 pt-6">
          <h2 className="text-sm font-medium text-foreground">Suggested</h2>
          <p className="text-sm text-muted-foreground">Nothing here loads until it&apos;s accepted.</p>
          <ul className="divide-y divide-border/60">
            {suggested.map((learning) => (
              <li key={learning.id} className="space-y-2 py-3">
                <LearningText learning={learning} label={learning.scope === "org" ? `For ${org.name}` : "For you"} />
                {learning.canEdit ? (
                  <div className="flex gap-2">
                    <Button type="button" size="sm" disabled={busy} onClick={() => void accept(learning.id)}>
                      Accept
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove(learning.id)}>
                      Dismiss
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Waiting for an admin to accept it.</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showOrg && (
        <LearningList
          title={`${org.name}'s learnings`}
          intro={
            org.admin
              ? "Every session of the org's members loads these."
              : "Every session of the org's members loads these. Its admins change them; what you add is a suggestion for them."
          }
          learnings={orgActive}
          busy={busy}
          addLabel={org.admin ? "Add for the org" : "Suggest for the org"}
          onAdd={(title, body) => add("org", title, body)}
          onSave={save}
          onDelete={remove}
        />
      )}

      <LearningList
        title="Your learnings"
        intro="Every session of yours loads these, in every org you're in."
        learnings={personalActive}
        busy={busy}
        addLabel="Add"
        onAdd={(title, body) => add("personal", title, body)}
        onSave={save}
        onDelete={remove}
      />
    </div>
  );
}

function LearningText({ learning, label }: { learning: LearningView; label?: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm text-foreground">
        {learning.title}
        {label && <span className="ml-2 text-xs text-muted-foreground">{label}</span>}
      </p>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{learning.body}</p>
    </div>
  );
}

function LearningList({
  title,
  intro,
  learnings,
  busy,
  addLabel,
  onAdd,
  onSave,
  onDelete,
}: {
  title: string;
  intro: string;
  learnings: LearningView[];
  busy: boolean;
  addLabel: string;
  onAdd(title: string, body: string): Promise<boolean>;
  onSave(id: string, title: string, body: string): Promise<boolean>;
  onDelete(id: string): Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="space-y-3 border-t border-border/60 pt-6">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground">{intro}</p>
      {learnings.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {learnings.map((learning) =>
            editing === learning.id ? (
              <li key={learning.id} className="py-3">
                <LearningForm
                  initial={learning}
                  submitLabel="Save"
                  busy={busy}
                  onSubmit={async (t, b) => {
                    if (await onSave(learning.id, t, b)) setEditing(null);
                    return false;
                  }}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={learning.id} className="flex items-start justify-between gap-4 py-3">
                <LearningText learning={learning} />
                {learning.canEdit && (
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(learning.id)}>
                      Edit
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onDelete(learning.id)}>
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      <LearningForm submitLabel={addLabel} busy={busy} onSubmit={onAdd} />
    </div>
  );
}

/** A learning's title and instruction; cleared once an addition is taken. */
function LearningForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial?: { title: string; body: string };
  submitLabel: string;
  busy: boolean;
  /** True when the form should clear. */
  onSubmit(title: string, body: string): Promise<boolean>;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(title, body).then((clear) => {
          if (clear) {
            setTitle("");
            setBody("");
          }
        });
      }}
    >
      <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Conventional Commits" maxLength={MAX_TITLE_CHARS} />
      <Textarea
        aria-label="Instruction"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="The instruction, as you'd say it: Use Conventional Commits for every commit message and PR title."
        maxLength={MAX_BODY_CHARS}
        rows={2}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !title.trim() || !body.trim()}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
