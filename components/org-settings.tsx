"use client";

import { PageHeader } from "@/components/page-layout";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DetailRow, Details } from "@/components/settings-details";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { type Org, orgName } from "@/lib/orgs/active";
import { requestJson } from "@/lib/http/request-json";

/**
 * Settings → Org for the org the app is showing: what it is, your role, the
 * domain a team org claimed, and its name, which its admins may change. The
 * sidebar's switcher picks another org.
 */
export function OrgGeneralSettings({ org, domain }: { org: Org; domain: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRename = !org.personal && org.role === "admin";
  const next = orgName(name);
  const changed = next !== null && next !== org.name;

  const rename = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await requestJson(`/api/orgs/${org.id}`, {
        method: "PATCH",
        body: { name: next },
        fallback: "Couldn't rename the org. Try again.",
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't rename the org. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-6">
      <PageHeader title={"Org"} />

      <Details>
        <DetailRow term="Org">{org.personal ? "Personal: just you" : "Team"}</DetailRow>
        <DetailRow term="Your role">{org.role === "admin" ? "Admin" : "Member"}</DetailRow>
        {org.personal ? null : (
          <DetailRow term="Domain">
            {domain ?? "None: made from a personal email, so it holds no domain"}
          </DetailRow>
        )}
      </Details>

      {org.personal ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          Your personal org holds your own projects and sessions. Make a team org from the org menu at the top of the
          sidebar to work with others: everyone in it sees its projects, and each person&apos;s sessions stay their own.
        </p>
      ) : (
        <div className="max-w-sm space-y-2">
          <label htmlFor="org-name" className="text-[13px] text-muted-foreground">
            Name
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="org-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void rename();
              }}
              maxLength={80}
              disabled={!canRename}
              autoComplete="off"
            />
            {canRename ? (
              <LoadingButton
                variant="outline"
                status={saving ? "pending" : "idle"}
                labels={{ idle: "Save" }}
                disabled={!changed}
                onClick={() => void rename()}
              />
            ) : null}
          </div>
          {canRename ? null : <p className="text-xs text-muted-foreground">Only its admins can rename it.</p>}
        </div>
      )}

      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
    </section>
  );
}
