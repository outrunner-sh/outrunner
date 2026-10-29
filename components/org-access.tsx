"use client";

import { PageHeader } from "@/components/page-layout";

import { useRouter } from "next/navigation";
import { Trash2, Users } from "lucide-react";
import { useState } from "react";

import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { SELECT_OPTIONS } from "@/components/ui/select-options";
import type { OrgRoleInfo } from "@/lib/db/org-access";
import { requestJson } from "@/lib/http/request-json";
import type { AccessLevel, Grant } from "@/lib/orgs/access";
import type { Org } from "@/lib/orgs/active";
import { cn } from "@/lib/utils";

type Project = { id: string; fullName: string };

/** A change the page asks the server for, then shows the page as it is. */
type Change = (key: string, url: string, method: string, body?: unknown) => Promise<boolean>;

/**
 * Settings → Org → Roles & access. For Everyone in the org, and for each
 * role: a level on all its projects, and exceptions on single projects. A
 * member gets the highest any grant gives them; admins always write. Roles
 * are given to members on the Members page.
 */
export function OrgAccessSettings({
  org,
  roles,
  grants,
  projects,
}: {
  org: Org;
  roles: OrgRoleInfo[];
  grants: Grant[];
  projects: Project[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change: Change = async (key, url, method, body) => {
    setBusy(key);
    setError(null);
    try {
      await requestJson(url, { method, body, fallback: "Couldn't make that change. Try again." });
      router.refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't make that change. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const setLevel = (roleId: string | null, projectId: string | null, level: AccessLevel | null) =>
    change(`grant:${roleId}:${projectId}`, `/api/orgs/${org.id}/grants`, "PUT", { roleId, projectId, level });

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <PageHeader title={"Roles & access"} />
        <p className="max-w-prose text-sm text-muted-foreground">
          What members of {org.name} may do with its projects. <b className="font-medium text-foreground">Read</b>: see
          a project and start sessions in it. <b className="font-medium text-foreground">Write</b>: also change its
          settings; on all projects, connect new ones. A member gets the most any grant below gives them. Admins can do
          everything.
        </p>
      </div>

      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}

      <PrincipalCard
        title="Everyone"
        detail="Every member of the org."
        roleId={null}
        grants={grants.filter((g) => g.roleId === null)}
        projects={projects}
        busy={busy}
        setLevel={setLevel}
      />

      {roles.map((role) => (
        <PrincipalCard
          key={role.id}
          title={role.name}
          detail={`${role.memberIds.length} ${role.memberIds.length === 1 ? "member" : "members"}: give it to members on the Members page.`}
          memberCount={role.memberIds.length}
          roleId={role.id}
          grants={grants.filter((g) => g.roleId === role.id)}
          projects={projects}
          busy={busy}
          setLevel={setLevel}
          onRename={(name) => change(`rename:${role.id}`, `/api/orgs/${org.id}/roles/${role.id}`, "PATCH", { name })}
          onDelete={() => change(`delete:${role.id}`, `/api/orgs/${org.id}/roles/${role.id}`, "DELETE")}
        />
      ))}

      <NewRole onCreate={(name) => change("new-role", `/api/orgs/${org.id}/roles`, "POST", { name })} busy={busy} />
    </section>
  );
}

const LEVELS: Array<{ value: AccessLevel | "none"; label: string }> = [
  { value: "none", label: "None" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
];

function LevelSelect({
  value,
  onChange,
  disabled,
  label,
  noneLabel = "None",
}: {
  value: AccessLevel | null;
  onChange: (level: AccessLevel | null) => void;
  disabled: boolean;
  label: string;
  noneLabel?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? "none"}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === "none" ? null : (event.target.value as AccessLevel))}
      className={cn("h-8 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground disabled:opacity-50", SELECT_OPTIONS)}
    >
      {LEVELS.map((l) => (
        <option key={l.value} value={l.value}>
          {l.value === "none" ? noneLabel : l.label}
        </option>
      ))}
    </select>
  );
}

function PrincipalCard({
  title,
  detail,
  roleId,
  grants,
  projects,
  busy,
  setLevel,
  onRename,
  onDelete,
  memberCount = 0,
}: {
  title: string;
  detail: string;
  roleId: string | null;
  grants: Grant[];
  projects: Project[];
  busy: string | null;
  setLevel: (roleId: string | null, projectId: string | null, level: AccessLevel | null) => Promise<boolean>;
  onRename?: (name: string) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  /** How many members hold the role, said before deleting it. */
  memberCount?: number;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState("");
  const all = grants.find((g) => g.projectId === null)?.level ?? null;
  const exceptions = grants.filter((g) => g.projectId !== null);
  const named = new Map(projects.map((p) => [p.id, p.fullName]));
  // A member gets the most any grant gives, so an exception only does
  // something above All projects: none to add once that's write, and a new
  // one starts a level above it.
  const addable = all === "write" ? [] : projects.filter((p) => !exceptions.some((g) => g.projectId === p.id));
  const rank = (level: AccessLevel | null) => (level === "write" ? 2 : level === "read" ? 1 : 0);
  const disabled = busy !== null;

  return (
    <div className="max-w-2xl overflow-hidden rounded-lg border border-border/60">
      <div className="flex items-start gap-3 border-b border-border/60 bg-muted/30 px-3 py-2.5">
        <Users aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {renaming !== null && onRename ? (
            <Input
              autoFocus
              value={renaming}
              maxLength={80}
              aria-label="Role name"
              onChange={(event) => setRenaming(event.target.value)}
              onKeyDown={async (event) => {
                if (event.key === "Escape") setRenaming(null);
                if (event.key === "Enter" && renaming.trim() && busy === null) {
                  // Unchanged: nothing to send.
                  if (renaming.trim() === title || (await onRename(renaming))) setRenaming(null);
                }
              }}
              onBlur={() => setRenaming(null)}
              className="h-7 text-[13px]"
            />
          ) : (
            <p className="text-[13px] font-medium text-foreground">
              {onRename ? (
                <button type="button" className="hover:underline" onClick={() => setRenaming(title)} title="Rename">
                  {title}
                </button>
              ) : (
                title
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        {onDelete && !deleting ? (
          <button
            type="button"
            aria-label={`Delete ${title}`}
            title="Delete role"
            disabled={disabled}
            onClick={() => setDeleting(true)}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>
      {onDelete && deleting ? (
        // Its grants go with it, and it comes off everyone who holds it: no
        // undo, so held rather than clicked.
        <div className="flex items-center gap-3 border-b border-border/60 bg-destructive/5 px-3 py-2">
          <p className="flex-1 text-xs text-muted-foreground">
            {memberCount === 0
              ? "Delete this role and what it may do?"
              : `Delete this role? ${memberCount} ${memberCount === 1 ? "member loses" : "members lose"} what it gives them.`}
          </p>
          <button type="button" className="route-state-button" onClick={() => setDeleting(false)}>
            Cancel
          </button>
          <HoldToConfirm
            label="Delete role"
            disabled={disabled}
            onConfirm={() => void onDelete().then((done) => !done && setDeleting(false))}
            className="h-7 px-2.5 text-xs"
          />
        </div>
      ) : null}
      <ul className="divide-y divide-border/60">
        <li className="flex items-center gap-3 px-3 py-2">
          <span className="flex-1 text-[13px] text-foreground">All projects</span>
          <LevelSelect
            label={`${title} on all projects`}
            value={all}
            disabled={disabled}
            onChange={(level) => void setLevel(roleId, null, level)}
          />
        </li>
        {exceptions.map((g) => (
          <li key={g.projectId} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
              {named.get(g.projectId!) ?? "A hidden project"}
            </span>
            {/* Its own span: a long name truncates without hiding it. */}
            {rank(g.level) <= rank(all) ? (
              <span className="shrink-0 text-xs text-muted-foreground">No effect: All projects gives as much</span>
            ) : null}
            <LevelSelect
              label={`${title} on ${named.get(g.projectId!) ?? "the project"}`}
              value={g.level}
              disabled={disabled}
              noneLabel="Remove"
              onChange={(level) => void setLevel(roleId, g.projectId, level)}
            />
          </li>
        ))}
        {addable.length > 0 ? (
          <li className="flex items-center gap-3 px-3 py-2">
            <select
              aria-label={`Give ${title} access to one project`}
              value={adding}
              disabled={disabled}
              onChange={async (event) => {
                const projectId = event.target.value;
                setAdding(projectId);
                if (projectId) await setLevel(roleId, projectId, all === "read" ? "write" : "read");
                setAdding("");
              }}
              className={cn("h-8 flex-1 rounded-md border border-dashed border-input bg-transparent px-2 text-[13px] text-muted-foreground", SELECT_OPTIONS)}
            >
              <option value="">Add one project…</option>
              {addable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function NewRole({ onCreate, busy }: { onCreate: (name: string) => Promise<boolean>; busy: string | null }) {
  const [name, setName] = useState("");
  const create = async () => {
    if (name.trim() && (await onCreate(name))) setName("");
  };
  return (
    <div className="max-w-2xl space-y-2">
      <h2 className="text-[13px] font-medium text-foreground">New role</h2>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          maxLength={80}
          placeholder="Frontend"
          aria-label="New role's name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && busy === null) void create();
          }}
        />
        <LoadingButton
          variant="outline"
          status={busy === "new-role" ? "pending" : "idle"}
          labels={{ idle: "Make role" }}
          disabled={!name.trim() || busy !== null}
          onClick={() => void create()}
        />
      </div>
      <p className="text-xs text-muted-foreground">A new role gives nothing until you set what it may do above.</p>
    </div>
  );
}
