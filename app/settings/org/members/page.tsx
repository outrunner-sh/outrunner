import { PageHeader } from "@/components/page-layout";

import { redirect } from "next/navigation";
import { Suspense } from "react";

import AccessSection from "@/app/settings/org/access/page";
import { SettingsSectionTabs } from "@/components/settings-section-tabs";
import { OrgMembersSettings } from "@/components/org-members";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listRoles } from "@/lib/db/org-access";
import {
  listJoinRequests,
  listMembers,
  listOpenInvites,
} from "@/lib/db/org-members";
import { canSendEmail } from "@/lib/email/send";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = {
  prefetch: "static",
  samples: [{ searchParams: { tab: null } }],
};

/** Settings → Org → Members: who's in the org the app is showing, and for its
 *  admins, invites and requests to join. */
export default function OrgMembers({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  return (
    <Suspense fallback={<SettingsLoading title="Members & access" />}>
      <MembersPage searchParams={searchParams} />
    </Suspense>
  );
}
async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return (
    <section className="space-y-6">
      <PageHeader title="Members & access" />
      <SettingsSectionTabs
        labels={["Members", "Roles & permissions"]}
        initial={tab === "roles" ? "second" : "first"}
        prefix="members"
      >
        {[<MembersSection key="members" />, <AccessSection key="roles" />]}
      </SettingsSectionTabs>
    </section>
  );
}

async function MembersSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/members");
  const context = await getOrgContext().catch(() => undefined);
  if (!context) {
    return (
      <section className="space-y-6">
        <PageHeader title="Members" />
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t load your orgs. Reload the page to try again.
        </p>
      </section>
    );
  }
  const { active } = context;
  const admin = active.role === "admin";
  const [listed, invites, requests, roles] = await Promise.all([
    listMembers(active.id),
    admin ? listOpenInvites(active.id) : Promise.resolve([]),
    admin ? listJoinRequests(active.id) : Promise.resolve([]),
    admin ? listRoles(active.id) : Promise.resolve([]),
  ]);
  // Members see one another by GitHub login; only admins, who invite and
  // answer requests, see emails, and who joined through GitHub.
  const members = admin ? listed : listed.map((m) => ({ ...m, email: null, joinedViaGithub: null }));
  return (
    <OrgMembersSettings
      org={active}
      me={owner.id}
      members={members}
      invites={invites}
      requests={requests}
      roles={roles}
      emails={canSendEmail()}
    />
  );
}
