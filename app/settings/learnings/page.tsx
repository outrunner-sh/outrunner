import { redirect } from "next/navigation";
import { Suspense } from "react";

import { LearningsSettings } from "@/components/learnings-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { learningDeps } from "@/lib/learnings/actions.deps";
import { learningsView } from "@/lib/learnings/routes";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Learnings: the standing instructions every new session loads,
 *  the org's and the user's own (lib/learnings). */
export default function Learnings() {
  return (
    <Suspense fallback={<SettingsLoading title="Learnings" />}>
      <LearningsSection />
    </Suspense>
  );
}

async function LearningsSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/learnings");
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  if (!org) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Learnings</h1>
        <p className="max-w-prose text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const learnings = await learningsView({
    actor: { userId: owner.id, orgId: org.id, role: org.role },
    deps: learningDeps(owner),
  });
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Learnings</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Short standing instructions every new session loads, for Claude Code and Codex alike: how to write commit
          messages, which commands to run, what never to do. When you give an agent a lasting instruction, it suggests
          saving it here, and nothing it suggests loads until you accept it.
        </p>
      </div>
      <LearningsSettings
        org={{ id: org.id, name: org.name, personal: org.personal, admin: org.role === "admin" }}
        initial={learnings}
      />
    </section>
  );
}
