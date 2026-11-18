import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HomeSessionRoute } from "@/components/new-session-route";
import { ServerAnswer } from "@/components/server-answer";
import { getOwnerSafe } from "@/lib/auth/owner";
import type { SetupGate } from "@/lib/orgs/setup";
import { activeOrgSetupGate } from "@/lib/orgs/setup.deps";

/** Home never waits on the server: the build checks it. */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
        { name: "sidebar-grouping", value: null },
        { name: "get-started-skipped", value: null },
        { name: "outrunner_org", value: null },
      ],
    },
  ],
};

/**
 * Home starts the next session and offers the five most recent to resume.
 * It shows at once; whether the active org still needs setup arrives from
 * the server after (lib/orgs/setup.ts): its admin is sent through setup, a
 * member is told an admin is on it.
 */
export default function Home() {
  return (
    <HomeSessionRoute
      gate={
        <Suspense fallback={null}>
          <HomeGate />
        </Suspense>
      }
    />
  );
}

/** A signed-in user who isn't the owner goes to sign-in (signed out is the
 *  proxy's to catch). The active org's setup gate, for the page. */
async function HomeGate() {
  if (!(await getOwnerSafe())) redirect("/signin");
  const gate = await activeOrgSetupGate();
  if (gate?.kind === "setup") redirect("/onboarding");
  return <ServerAnswer<SetupGate> value={gate} />;
}
