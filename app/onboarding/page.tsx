import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { OnboardingLive } from "@/components/onboarding/onboarding-live";
import { OnboardingPreview } from "@/components/onboarding/onboarding-preview";
import { DESKTOP_CONTEXT_COOKIE, readDesktopContext } from "@/lib/auth/desktop/grant";
import { getOwner } from "@/lib/auth/owner";
import { modelMenu } from "@/lib/db/credentials";
import { getOnboardingUser } from "@/lib/onboarding/server";
import { activeOrgSetupGate } from "@/lib/orgs/setup.deps";
import { getOrgContext } from "@/lib/orgs/server";

/**
 * The active org's setup: the coding agent, GitHub, the repositories it
 * works on, its first environment, then a first session
 * (components/onboarding/onboarding-flow.tsx). Home sends an admin of an org
 * that needs it here (lib/orgs/setup.ts); anyone else, or an org set up
 * already, goes home, where a member of an org not set up yet is told an
 * admin is on it.
 *
 * ONBOARDING_PREVIEW=1 serves it on mock data with no sign-in, for working on
 * the screens. Never in production.
 */
export default async function OnboardingPage() {
  if (process.env.ONBOARDING_PREVIEW === "1" && process.env.NODE_ENV !== "production") {
    return <OnboardingPreview />;
  }

  const user = await getOnboardingUser().catch(() => null);
  if (!user) redirect("/signin?next=/onboarding");
  const desktopReturn = readDesktopContext((await cookies()).get(DESKTOP_CONTEXT_COOKIE)?.value) !== null;
  const [gate, context] = await Promise.all([activeOrgSetupGate(), getOrgContext().catch(() => null)]);
  if (gate?.kind !== "setup" || !context) redirect(desktopReturn ? "/auth/desktop/ready" : "/");
  const owner = await getOwner();
  // Outrunner's own models, on this server: a key of the user's doesn't count,
  // or "100 free credits" would start a session billed to that key.
  const outrunnerModels = owner ? await modelMenu(owner.id).then((menu) => menu.outrunner) : false;
  const org = context.active;

  return (
    <OnboardingLive
      user={user}
      org={{ id: org.id, name: org.name }}
      outrunnerModels={outrunnerModels}
      desktopReturn={desktopReturn}
    />
  );
}
