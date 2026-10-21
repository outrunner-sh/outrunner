"use client";

import { ExternalLink } from "lucide-react";

import type { GitHubInvite, OrgAccessHint, RepositoryAccess } from "@/lib/github/access";
import { avatarAt } from "@/lib/github/listing";

const LINK = "text-foreground inline-flex shrink-0 items-center gap-0.5 font-medium underline-offset-4 hover:underline";

/**
 * Under a repository list: why a repository the user expects may not be in
 * it, each with the page on GitHub that fixes it — invitations to accept,
 * organizations holding repositories back, a sign-in that predates Outrunner
 * asking about organizations, a list GitHub cut short. Ends with the page
 * where Outrunner's access to any organization is granted, for the cases
 * GitHub gives no sign of.
 */
export function RepositoryAccessNotes({
  access,
  complete,
}: {
  access: RepositoryAccess | null;
  complete: boolean;
}) {
  if (!access) return null;
  return (
    <div className="border-border text-muted-foreground max-h-40 space-y-1.5 overflow-y-auto border-t px-3 py-2 text-xs">
      {access.invites.map((invite) => (
        <InviteNote key={invite.key} invite={invite} />
      ))}
      {access.hints.map((hint) => (
        <HintNote key={`${hint.reason}:${hint.login ?? "?"}`} hint={hint} reviewUrl={access.reviewUrl} />
      ))}
      {access.needsOrgScope && (
        <p>Sign out and back in to let Outrunner check which organizations are holding repositories back.</p>
      )}
      {!complete && <p>GitHub may have more repositories than this list shows.</p>}
      <p className="flex items-center justify-between gap-2">
        <span>Missing an organization&apos;s repositories?</span>
        <ExternalAnchor href={access.reviewUrl}>Review access</ExternalAnchor>
      </p>
    </div>
  );
}

function InviteNote({ invite }: { invite: GitHubInvite }) {
  return (
    <p className="flex items-center gap-2">
      <Avatar src={invite.avatarUrl} />
      <span className="min-w-0 flex-1 truncate" title={`${invite.name} — ${invite.detail}`}>
        <span className="text-foreground">{invite.name}</span> · {invite.detail}
      </span>
      <ExternalAnchor href={invite.acceptUrl}>Accept</ExternalAnchor>
    </p>
  );
}

function HintNote({ hint, reviewUrl }: { hint: OrgAccessHint; reviewUrl: string }) {
  const org = hint.login ?? "An organization";
  return (
    <p className="flex items-center gap-2">
      <Avatar src={hint.avatarUrl} />
      <span className="min-w-0 flex-1">
        {hint.reason === "sso" ? (
          <>
            <span className="text-foreground">{org}</span> uses single sign-on: its repositories show once you
            authorize Outrunner for it.
          </>
        ) : (
          <>
            No repositories from <span className="text-foreground">{org}</span>? It may not have approved Outrunner
            yet.
          </>
        )}
      </span>
      <ExternalAnchor href={reviewUrl}>{hint.reason === "sso" ? "Authorize" : "Grant access"}</ExternalAnchor>
    </p>
  );
}

function ExternalAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

function Avatar({ src }: { src: string | null }) {
  if (!src) return <span aria-hidden className="bg-muted size-4 shrink-0 rounded-sm" />;
  // eslint-disable-next-line @next/next/no-img-element -- GitHub's avatar CDN, sized by query
  return <img src={avatarAt(src, 32)} alt="" loading="lazy" className="size-4 shrink-0 rounded-sm" />;
}
