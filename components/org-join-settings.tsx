"use client";

import Link from "next/link";
import { useState } from "react";

import { InlineMessage } from "@/components/ui/notice";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

/**
 * Settings → Org, a team org's: whether members of the GitHub organization
 * its source installation is on may join at once, without an invite
 * (lib/orgs/github-join.ts). Its admins set it; it saves as it's ticked.
 * Leaving the GitHub organization later doesn't take anyone out: admins
 * remove people on Members.
 */
export function OrgJoinSettings({
  org,
  initial,
  githubOrgs,
}: {
  org: Org;
  initial: boolean;
  /** The GitHub organizations whose members it would let in, by login. */
  githubOrgs: string[];
}) {
  const [enabled, setEnabled] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = org.role === "admin";

  async function save(joinViaGithub: boolean) {
    setSaving(true);
    setError(null);
    try {
      const saved = await requestJson<{ joinViaGithub: boolean }>(`/api/orgs/${org.id}/join-settings`, {
        method: "PUT",
        body: { joinViaGithub },
        has: (s) => typeof s.joinViaGithub === "boolean",
      });
      setEnabled(saved.joinViaGithub);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2 border-t border-border/60 pt-6">
      <label className="flex items-center gap-2 text-sm font-medium text-foreground">
        <input
          type="checkbox"
          className="size-4 accent-foreground"
          disabled={!admin || saving}
          checked={enabled}
          onChange={(event) => void save(event.target.checked)}
        />
        Let members of its GitHub organization join without an invite
      </label>
      <p className="max-w-prose text-xs text-muted-foreground">
        {githubOrgs.length > 0 ? (
          <>
            Members of {githubOrgs.join(", ")} on GitHub
          </>
        ) : (
          <>
            Once the org is the first to connect a GitHub organization (
            <Link href="/settings/org/github" className="text-foreground underline underline-offset-2">
              GitHub
            </Link>
            ), that organization&apos;s members on GitHub
          </>
        )}{" "}
        find it under New team org and join as members, as GitHub confirms them. Someone who later leaves the GitHub
        organization stays until an admin removes them on Members.
      </p>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {!admin && <p className="text-xs text-muted-foreground">Only the org&apos;s admins change this.</p>}
    </section>
  );
}
