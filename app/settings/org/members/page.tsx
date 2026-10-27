import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OrgMembersSettings } from "@/components/org-members";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listJoinRequests, listMembers, listOpenInvites } from "@/lib/db/org-members";
import { canSendEmail } from "@/lib/email/send";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Org → Members: who's in the org the app is showing, and for its
 *  admins, invites and requests to join. */
export default function OrgMembers() {
  return (
    <Suspense fallback={<SettingsLoading title="Members" />}>
      <MembersSection />
    </Suspense>
  );
}

async function MembersSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/members");
  const context = await getOrgContext().catch(() => undefined);
  if (!context) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Members</h1>
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const { active } = context;
  const admin = active.role === "admin" && !active.personal;
  const [listed, invites, requests] = await Promise.all([
    listMembers(active.id),
    admin ? listOpenInvites(active.id) : Promise.resolve([]),
    admin ? listJoinRequests(active.id) : Promise.resolve([]),
  ]);
  // Members see one another by GitHub login; only admins, who invite and
  // answer requests, see emails.
  const members = admin ? listed : listed.map((m) => ({ ...m, email: null }));
  return (
    <OrgMembersSettings
      org={active}
      me={owner.id}
      members={members}
      invites={invites}
      requests={requests}
      emails={canSendEmail()}
    />
  );
}
