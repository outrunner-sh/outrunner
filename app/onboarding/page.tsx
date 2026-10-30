import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { OnboardingLive } from "@/components/onboarding/onboarding-live";
import { OnboardingPreview } from "@/components/onboarding/onboarding-preview";
import { DESKTOP_CONTEXT_COOKIE, readDesktopContext } from "@/lib/auth/desktop/grant";
import { getOwner } from "@/lib/auth/owner";
import { modelMenu } from "@/lib/db/credentials";
import { getOnboardingUser } from "@/lib/onboarding/server";

/**
 * First-run onboarding: the coding agent, then the repositories
 * (components/onboarding/onboarding-flow.tsx). Home sends a new user here
 * (see app/(app)/page.tsx); it is done once they finish it, which opens the
 * new-session screen, or skip it.
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
  if (user.onboardedAt) redirect(desktopReturn ? "/auth/desktop/ready" : "/");
  const owner = await getOwner();
  // Outrunner's own models, on this server: a key of the user's doesn't count,
  // or "100 free credits" would start a session billed to that key.
  const outrunnerModels = owner ? await modelMenu(owner.id).then((menu) => menu.outrunner) : false;

  return (
    <OnboardingLive
      user={{ id: user.id, name: user.name, login: user.login, avatarUrl: user.avatarUrl }}
      outrunnerModels={outrunnerModels}
      desktopReturn={desktopReturn}
    />
  );
}
