"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { GitHubConnectLink } from "@/components/github-connect-link";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InlineMessage } from "@/components/ui/notice";
import { orgName } from "@/lib/orgs/active";
import type { GitHubJoinMatch, GitHubJoinWhy } from "@/lib/orgs/github-join";
import { reachOutrunner, requestJson } from "@/lib/http/request-json";

/** What app/api/orgs/github-matches answers. */
type GitHubMatches = { matches: GitHubJoinMatch[]; githubConnected: boolean; canConnect: boolean };

/** Why a GitHub organization's org can't be joined from here, and what to do. */
const CANNOT_JOIN: Record<GitHubJoinWhy, string> = {
  unverified: "GitHub didn't confirm your membership. Ask one of its admins to invite you.",
  disabled: "Its admins have turned off joining through GitHub. Ask one of them to invite you.",
  removed: "An admin removed you from it. Ask one of them to invite you.",
};

/**
 * Make a team org, named here. It claims the domain of the user's primary
 * verified GitHub email; when an org has that domain already, the server says
 * so and none is made: the person asks that org's admins to invite them.
 * Made, it becomes the org the app shows.
 *
 * As it opens, it looks for team orgs the user can join through their GitHub
 * organizations (lib/orgs/github-join.ts), and offers to join one at once,
 * rather than make another. Only here: looking asks GitHub.
 */
export function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An org has the user's domain already: they can ask to join it instead.
  const [domainOrg, setDomainOrg] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  // Null while looking, or when looking failed: then there's nothing to offer.
  const [github, setGithub] = useState<GitHubMatches | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const valid = orgName(name) !== null;

  useEffect(() => {
    if (!open) return;
    let current = true;
    requestJson<GitHubMatches>("/api/orgs/github-matches", { has: (d) => Array.isArray(d.matches) })
      .then((found) => {
        if (current) setGithub(found);
      })
      // The form works without it: making an org, or asking by email domain.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [open]);

  const close = () => {
    setName("");
    setError(null);
    setDomainOrg(null);
    setAsked(null);
    setGithub(null);
    onOpenChange(false);
  };

  const askToJoin = async () => {
    setPending(true);
    setError(null);
    try {
      const data = await requestJson<{ message: string }>("/api/orgs/join-requests", {
        method: "POST",
        has: (d) => typeof d.message === "string",
        fallback: "Couldn't send your request. Try again.",
      });
      setAsked(data.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't send your request. Try again.");
    } finally {
      setPending(false);
    }
  };

  const joinThroughGithub = async (match: GitHubJoinMatch) => {
    if (joining || pending) return;
    setJoining(match.orgId);
    setError(null);
    try {
      await requestJson(`/api/orgs/${match.orgId}/join-via-github`, {
        method: "POST",
        fallback: `Couldn't join ${match.orgName}. Try again.`,
      });
      close();
      router.push("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Couldn't join ${match.orgName}. Try again.`);
    } finally {
      setJoining(null);
    }
  };

  const create = async () => {
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await reachOutrunner("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
        org?: { name?: string };
      } | null;
      if (!response.ok) {
        setError(data?.error ?? "Couldn't make the org. Try again.");
        setDomainOrg(data?.code === "domain_org_exists" ? (data.org?.name ?? "that org") : null);
        return;
      }
      close();
      router.push("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't make the org. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-sm gap-5">
        <div className="space-y-2">
          <DialogTitle className="text-[15px] font-medium leading-snug">New organization</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            You&apos;ll be its admin. It takes the domain of your primary GitHub email (unless it&apos;s a free one
            like gmail.com), so teammates from it find this org rather than making another.
          </DialogDescription>
        </div>
        {github ? <GitHubOrgs found={github} joining={joining} onJoin={(m) => void joinThroughGithub(m)} /> : null}
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
          placeholder="Acme"
          aria-label="Org name"
          maxLength={80}
          autoComplete="off"
        />
        {asked ? (
          <InlineMessage tone="info">{asked}</InlineMessage>
        ) : error ? (
          <InlineMessage
            actions={
              domainOrg ? [{ label: `Ask to join ${domainOrg}`, onClick: () => void askToJoin() }] : undefined
            }
          >
            {domainOrg ? `${domainOrg} already uses Outrunner for your email's domain. Ask its admins to let you in.` : error}
          </InlineMessage>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={close} className="route-state-button">
            {asked ? "Done" : "Cancel"}
          </button>
          {asked || domainOrg ? null : (
            <button type="button" onClick={() => void create()} disabled={!valid || pending} className="route-state-button">
              {pending ? "Making…" : "Make org"}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The team orgs the user's GitHub organizations are on, to join rather than
 *  make another; or, with no GitHub connection, the way to find them. */
function GitHubOrgs({
  found,
  joining,
  onJoin,
}: {
  found: GitHubMatches;
  joining: string | null;
  onJoin: (match: GitHubJoinMatch) => void;
}) {
  if (!found.githubConnected) {
    return found.canConnect ? (
      <p className="text-[13px] text-muted-foreground">
        <GitHubConnectLink className="text-foreground underline underline-offset-2">
          Connect GitHub to find your team
        </GitHubConnectLink>{" "}
        if it&apos;s on Outrunner already.
      </p>
    ) : null;
  }
  if (found.matches.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium text-foreground">Your GitHub orgs already on Outrunner</p>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
        {found.matches.map((m) => (
          <li key={m.orgId} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-foreground">{m.orgName}</p>
              <p className="text-xs text-muted-foreground">
                {m.canJoin || !m.why ? `via GitHub ${m.githubOrg}` : CANNOT_JOIN[m.why]}
              </p>
            </div>
            {m.canJoin ? (
              <button
                type="button"
                onClick={() => onJoin(m)}
                disabled={joining !== null}
                className="route-state-button shrink-0"
              >
                {joining === m.orgId ? "Joining…" : `Join ${m.orgName}`}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
