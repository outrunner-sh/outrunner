import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HomeSessionRoute } from "@/components/new-session-route";
import { getOwnerSafe } from "@/lib/auth/owner";
import { needsOnboarding } from "@/lib/onboarding/server";

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
 * Home is the new-session screen: every session is in the sidebar, so the page
 * itself is for starting the next one. It shows at once; a new user is sent
 * through onboarding as the server's check arrives.
 */
export default function Home() {
  return (
    <>
      <HomeSessionRoute />
      <Suspense fallback={null}>
        <HomeGate />
      </Suspense>
    </>
  );
}

/** A signed-in user who isn't the owner goes to sign-in (signed out is the
 *  proxy's to catch); a new one, to onboarding. Shows nothing. */
async function HomeGate() {
  if (!(await getOwnerSafe())) redirect("/signin");
  if (await needsOnboarding()) redirect("/onboarding");
  return null;
}
