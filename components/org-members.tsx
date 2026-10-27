"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import type { OrgRoleInfo } from "@/lib/db/org-access";
import type { JoinRequest, Member, OpenInvite, Person } from "@/lib/db/org-members";
import { requestJson } from "@/lib/http/request-json";
import type { Org, OrgRole } from "@/lib/orgs/active";

/**
 * Settings → Org → Members. Everyone sees who's in the org and may leave it;
 * its admins also invite people, answer requests to join, change roles and
 * remove members. Each member's sessions stay their own, admins included.
 */
export function OrgMembersSettings({
  org,
  me,
  members,
  invites,
  requests,
  roles = [],
  emails,
}: {
  org: Org;
  me: string;
  members: Member[];
  invites: OpenInvite[];
  requests: JoinRequest[];
  /** The org's roles, for an admin to give members (Roles & access). */
  roles?: OrgRoleInfo[];
  /** Whether the deployment emails invites; else their links are shared. */
  emails: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const admin = org.role === "admin" && !org.personal;

  /** Run a change, then show the page as it now is. */
  const change = async (key: string, url: string, method: string, body?: unknown, after?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      await requestJson(url, { method, body, fallback: "Couldn't make that change. Try again." });
      after?.();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't make that change. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (org.personal) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Members</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Your personal org is just you. Make a team org from the org menu at the top of the sidebar to invite others.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Members</h1>
        <p className="text-sm text-muted-foreground">
          {`Who's in ${org.name}. What each may do with its projects is set on Roles & access; each person's sessions stay their own, admins included.`}
        </p>
      </div>

      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}

      {admin && requests.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-[13px] font-medium text-foreground">Asking to join</h2>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                <PersonCell person={r} detail={r.requestEmail} />
                <button
                  type="button"
                  className="route-state-button"
                  disabled={busy !== null}
                  onClick={() =>
                    void change(`approve:${r.id}`, `/api/orgs/${org.id}/requests/${r.id}`, "POST", {
                      action: "approve",
                      role: "member",
                    })
                  }
                >
                  {busy === `approve:${r.id}` ? "Approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  className="route-state-button"
                  disabled={busy !== null}
                  onClick={() =>
                    void change(`decline:${r.id}`, `/api/orgs/${org.id}/requests/${r.id}`, "POST", { action: "decline" })
                  }
                >
                  Decline
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-2">
        <h2 className="text-[13px] font-medium text-foreground">
          {members.length} {members.length === 1 ? "member" : "members"}
        </h2>
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
              <PersonCell person={m} detail={m.login ? `@${m.login}` : m.email} you={m.userId === me} />
              {admin && m.role === "member" && roles.length > 0 ? (
                <RolesMenu
                  // Fresh from the server after each change: it starts again
                  // from what was saved.
                  key={roles.filter((r) => r.memberIds.includes(m.userId)).map((r) => r.id).join(",")}
                  roles={roles}
                  held={roles.filter((r) => r.memberIds.includes(m.userId)).map((r) => r.id)}
                  busy={busy !== null}
                  onChange={(roleIds) =>
                    void change(`roles:${m.userId}`, `/api/orgs/${org.id}/members/${m.userId}/roles`, "PUT", { roleIds })
                  }
                />
              ) : null}
              <MemberActions
                member={m}
                isMe={m.userId === me}
                admin={admin}
                busy={busy !== null}
                onRole={(role) => void change(`role:${m.userId}`, `/api/orgs/${org.id}/members/${m.userId}`, "PATCH", { role })}
                onRemove={() =>
                  void change(`remove:${m.userId}`, `/api/orgs/${org.id}/members/${m.userId}`, "DELETE", undefined, () => {
                    // Left: the org is gone from the user's list.
                    if (m.userId === me) router.push("/");
                  })
                }
              />
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Someone who leaves, or is removed, loses the org at once. Their sessions in it are stopped, and deleted after
          30 days unless they come back.
        </p>
      </div>

      {admin ? <Invites org={org} invites={invites} emails={emails} busy={busy} change={change} /> : null}
    </section>
  );
}

function PersonCell({ person, detail, you = false }: { person: Person; detail: string | null; you?: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      {person.avatarUrl ? (
        <Image src={person.avatarUrl} alt="" width={24} height={24} className="size-6 rounded-full" unoptimized />
      ) : (
        <span aria-hidden className="size-6 rounded-full bg-muted" />
      )}
      <div className="min-w-0">
        <p className="truncate text-[13px] text-foreground">
          {person.name}
          {you ? <span className="text-muted-foreground"> (you)</span> : null}
        </p>
        {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  );
}

/** A member's roles, for an admin to give or take: what each may do is set on
 *  Roles & access. */
function RolesMenu({
  roles,
  held,
  busy,
  onChange,
}: {
  roles: OrgRoleInfo[];
  held: string[];
  busy: boolean;
  onChange: (roleIds: string[]) => void;
}) {
  // What's ticked, at once: the menu stays open, and the next tick must
  // build on this one, not on the roles from before it saved (the change
  // sends the whole set).
  const [ticked, setTicked] = useState(held);
  const names = roles.filter((r) => ticked.includes(r.id)).map((r) => r.name);
  const toggle = (roleId: string, checked: boolean) => {
    const next = checked ? [...ticked, roleId] : ticked.filter((id) => id !== roleId);
    setTicked(next);
    onChange(next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="route-state-button max-w-48 truncate text-muted-foreground" disabled={busy}>
        {names.length === 0 ? "No roles" : names.join(", ")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Roles</DropdownMenuLabel>
        {roles.map((r) => (
          <DropdownMenuCheckboxItem
            key={r.id}
            checked={ticked.includes(r.id)}
            disabled={busy}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => toggle(r.id, checked)}
          >
            {r.name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MemberActions({
  member,
  isMe,
  admin,
  busy,
  onRole,
  onRemove,
}: {
  member: Member;
  isMe: boolean;
  admin: boolean;
  busy: boolean;
  onRole: (role: OrgRole) => void;
  onRemove: () => void;
}) {
  const label = member.role === "admin" ? "Admin" : "Member";
  if (!admin && !isMe) return <span className="text-xs text-muted-foreground">{label}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="route-state-button" disabled={busy}>
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {admin ? (
          <>
            <DropdownMenuItem onSelect={() => onRole("admin")} className="gap-2">
              Admin {member.role === "admin" ? <Check className="ml-auto size-3.5" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onRole("member")} className="gap-2">
              Member {member.role === "member" ? <Check className="ml-auto size-3.5" /> : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onRemove} className="text-destructive focus:text-destructive">
          {isMe ? "Leave org" : "Remove from org"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Invites({
  org,
  invites,
  emails,
  busy,
  change,
}: {
  org: Org;
  invites: OpenInvite[];
  emails: boolean;
  busy: string | null;
  change: (key: string, url: string, method: string, body?: unknown, after?: () => void) => Promise<void>;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ email: string; link: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = async () => {
    setSending(true);
    setError(null);
    try {
      const data = await requestJson<{ link: string; emailed: boolean }>(`/api/orgs/${org.id}/invites`, {
        method: "POST",
        body: { email, role },
        has: (d) => typeof d.link === "string",
        fallback: "Couldn't invite them. Try again.",
      });
      setMade({ email: email.trim().toLowerCase(), link: data.link, emailed: data.emailed });
      setCopied(false);
      setEmail("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't invite them. Try again.");
    } finally {
      setSending(false);
    }
  };

  const copy = async (link: string) => {
    await navigator.clipboard.writeText(link).catch(() => {});
    setCopied(true);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-[13px] font-medium text-foreground">Invite</h2>
        <p className="text-xs text-muted-foreground">
          They sign in with a GitHub account that has this email verified.{" "}
          {emails ? "We'll email them the link." : "Share the link with them: it's shown once, and works for 7 days."}
        </p>
      </div>
      <div className="flex max-w-lg items-center gap-2">
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && email.trim()) void invite();
          }}
          placeholder="teammate@company.com"
          aria-label="Email to invite"
          autoComplete="off"
        />
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as OrgRole)}
          aria-label="Role"
          className="h-9 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <LoadingButton
          variant="outline"
          status={sending ? "pending" : "idle"}
          labels={{ idle: "Invite" }}
          disabled={!email.trim()}
          onClick={() => void invite()}
        />
      </div>
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
      {made ? (
        <div className="max-w-lg space-y-2 rounded-lg border border-border/60 p-3">
          <p className="text-[13px] text-foreground">
            {made.emailed ? `Emailed ${made.email} their link.` : `Send ${made.email} this link. It won't be shown again.`}
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={made.link} onFocus={(event) => event.currentTarget.select()} aria-label="Invite link" />
            <button type="button" className="route-state-button gap-1.5" onClick={() => void copy(made.link)}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}
      {invites.length > 0 ? (
        <ul className="max-w-lg divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
          {invites.map((i) => {
            const expired = i.expired;
            return (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-foreground">{i.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {i.role === "admin" ? "Admin" : "Member"} · {expired ? "expired: invite again for a new link" : "waiting"}
                  </p>
                </div>
                <button
                  type="button"
                  className="route-state-button"
                  disabled={busy !== null}
                  onClick={() => void change(`revoke:${i.id}`, `/api/orgs/${org.id}/invites/${i.id}`, "DELETE")}
                >
                  Withdraw
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
