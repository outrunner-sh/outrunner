"use client";

import { useRouter } from "next/navigation";
import { Check, Copy, Link2, Loader2, LogOut, Trash2, UserMinus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CreateWorkspaceDialog } from "@/components/workspace-switcher";
import type { TeamInvite, TeamMember } from "@/lib/db/teams";
import { teamRequest } from "@/lib/teams/client";
import {
  canRemove,
  invitableRoles,
  managesTeam,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  type Team,
  type TeamRole,
} from "@/lib/teams/roles";

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

/** The open workspace's settings. What each control does is checked again by
 *  the database; these only offer what the user's role allows. */
export function WorkspaceSettings({
  team,
  members,
  invites,
  meId,
}: {
  team: Team;
  members: TeamMember[];
  invites: TeamInvite[];
  meId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Run a change, then re-read the page; `key` marks what is in progress. */
  const run = async (key: string, change: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      await change();
      after?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-10">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Workspace</h1>
        <p className="text-sm text-muted-foreground">
          {team.personal
            ? "Your personal workspace: your own repositories and sessions, just you."
            : `You're ${withArticle(team.role)} of ${team.name}: ${ROLE_DESCRIPTION[team.role].toLowerCase()}.`}
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {team.personal ? <PersonalWorkspace /> : (
        <>
          <NameSection team={team} busy={busy} run={run} />
          <MembersSection team={team} members={members} meId={meId} busy={busy} run={run} />
          {managesTeam(team.role) && <InviteSection team={team} invites={invites} busy={busy} run={run} />}
          <LeaveOrDelete team={team} meId={meId} busy={busy} run={run} />
        </>
      )}
    </section>
  );
}

type Run = (key: string, change: () => Promise<unknown>, after?: () => void) => Promise<void>;

/** "an owner", "a member". */
function withArticle(role: TeamRole): string {
  const label = ROLE_LABEL[role].toLowerCase();
  return `${role === "owner" || role === "admin" ? "an" : "a"} ${label}`;
}

function PersonalWorkspace() {
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-4">
      <p className="text-sm text-foreground">Work with others in a shared workspace.</p>
      <p className="text-sm text-muted-foreground">
        A workspace has its own projects. Everyone in it sees every session and can watch it live; only the person
        who started a session types in it. Each person runs on their own GitHub and Claude.
      </p>
      <Button onClick={() => setCreating(true)}>New workspace</Button>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NameSection({ team, busy, run }: { team: Team; busy: string | null; run: Run }) {
  const [name, setName] = useState(team.name);
  const editable = managesTeam(team.role);
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">Name</h2>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run("name", () => teamRequest("PATCH", `/api/teams/${team.id}`, { name }));
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!editable} aria-label="Workspace name" />
        {editable && (
          <Button type="submit" variant="outline" disabled={busy === "name" || !name.trim() || name.trim() === team.name}>
            {busy === "name" && <Loader2 className="animate-spin" />} Save
          </Button>
        )}
      </form>
    </div>
  );
}

function MembersSection({
  team,
  members,
  meId,
  busy,
  run,
}: {
  team: Team;
  members: TeamMember[];
  meId: string;
  busy: string | null;
  run: Run;
}) {
  const owner = team.role === "owner";
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">
        People <span className="text-muted-foreground">· {members.length}</span>
      </h2>
      <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
        {members.map((m) => {
          const me = m.userId === meId;
          const who = m.githubLogin ? `@${m.githubLogin}` : "A teammate";
          return (
            <li key={m.userId} className="flex items-center gap-3 px-3 py-2.5">
              {m.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a GitHub avatar, sized by CSS
                <img src={m.avatarUrl} alt="" className="size-7 rounded-full" />
              ) : (
                <span className="grid size-7 place-items-center rounded-full bg-accent text-xs uppercase">
                  {m.githubLogin?.slice(0, 1) ?? "?"}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {who} {me && <span className="text-muted-foreground">(you)</span>}
              </span>
              {owner ? (
                <select
                  className={selectClass}
                  value={m.role}
                  disabled={busy !== null}
                  aria-label={`${who}'s role`}
                  onChange={(e) =>
                    void run(`role:${m.userId}`, () =>
                      teamRequest("PATCH", `/api/teams/${team.id}/members/${m.userId}`, { role: e.target.value }),
                    )
                  }
                >
                  {(Object.keys(ROLE_LABEL) as TeamRole[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-muted-foreground">{ROLE_LABEL[m.role]}</span>
              )}
              {!me && canRemove(team.role, m.role, false) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${who}`}
                  title={`Remove ${who}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`remove:${m.userId}`, () => teamRequest("DELETE", `/api/teams/${team.id}/members/${m.userId}`))
                  }
                >
                  {busy === `remove:${m.userId}` ? <Loader2 className="animate-spin" /> : <UserMinus />}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function InviteSection({
  team,
  invites,
  busy,
  run,
}: {
  team: Team;
  invites: TeamInvite[];
  busy: string | null;
  run: Run;
}) {
  const roles = invitableRoles(team.role);
  const [role, setRole] = useState<TeamRole>(roles.includes("member") ? "member" : roles[0]);
  const [link, setLink] = useState<{ url: string; role: TeamRole } | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = invites.filter((i) => !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt) > new Date());

  const create = () =>
    run(
      "invite",
      async () => {
        const { invite } = await teamRequest<{ invite: { url: string; role: TeamRole } }>(
          "POST",
          `/api/teams/${team.id}/invites`,
          { role },
        );
        setLink(invite);
        setCopied(false);
      },
    );

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-foreground">Invite people</h2>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value as TeamRole)} aria-label="Invite as">
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <Button variant="outline" onClick={() => void create()} disabled={busy === "invite"}>
          {busy === "invite" ? <Loader2 className="animate-spin" /> : <Link2 />} Create invite link
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTION[role]}.</p>
      {link && (
        <div className="space-y-1.5 rounded-lg border border-border/60 p-3">
          <div className="flex items-center gap-2">
            <Input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy the invite link"
              onClick={() => {
                void navigator.clipboard.writeText(link.url).then(() => setCopied(true));
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Whoever opens it, signed in, joins as {ROLE_LABEL[link.role].toLowerCase()}. It works once, for 7 days, and
            is shown only now.
          </p>
        </div>
      )}
      {pending.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
          {pending.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1 text-muted-foreground">
                Invite as {ROLE_LABEL[i.role].toLowerCase()} · expires {new Date(i.expiresAt).toLocaleDateString()}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => void run(`revoke:${i.id}`, () => teamRequest("DELETE", `/api/teams/${team.id}/invites/${i.id}`))}
              >
                {busy === `revoke:${i.id}` && <Loader2 className="animate-spin" />} Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LeaveOrDelete({ team, meId, busy, run }: { team: Team; meId: string; busy: string | null; run: Run }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const home = () => {
    router.push("/");
  };
  return (
    <div className="space-y-3 border-t border-border/60 pt-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">Leave {team.name}</h2>
          <p className="text-sm text-muted-foreground">You&apos;ll stop seeing its projects and sessions.</p>
        </div>
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => void run("leave", () => teamRequest("DELETE", `/api/teams/${team.id}/members/${meId}`), home)}
        >
          {busy === "leave" ? <Loader2 className="animate-spin" /> : <LogOut />} Leave
        </Button>
      </div>
      {team.role === "owner" && (
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-destructive">Delete {team.name}</h2>
            <p className="text-sm text-muted-foreground">
              Its projects and everyone&apos;s sessions on them go too, and their cloud computers are shut down.
            </p>
          </div>
          <Button variant="destructive" disabled={busy !== null} onClick={() => setConfirming(true)}>
            <Trash2 /> Delete
          </Button>
        </div>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-md">
          <DialogTitle>Delete {team.name}?</DialogTitle>
          <DialogDescription>
            This deletes the workspace, its projects and every session on them, for everyone. Type its name to confirm.
          </DialogDescription>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={team.name} aria-label="Workspace name" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={typed !== team.name || busy === "delete"}
              onClick={() => void run("delete", () => teamRequest("DELETE", `/api/teams/${team.id}`), home)}
            >
              {busy === "delete" && <Loader2 className="animate-spin" />} Delete workspace
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
