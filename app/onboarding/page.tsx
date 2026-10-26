import { redirect } from "next/navigation";

import { OnboardingLive } from "@/components/onboarding/onboarding-live";
import { OnboardingPreview } from "@/components/onboarding/onboarding-preview";
import { getOwner } from "@/lib/auth/owner";
import { modelMenu, offersModels } from "@/lib/db/credentials";
import { getOnboardingUser } from "@/lib/onboarding/server";

/**
 * First-run onboarding: the coding agent, the repositories, a first session
 * (components/onboarding/onboarding-flow.tsx). Home sends a new user here
 * (see app/(app)/page.tsx); it is done once they start that session, go home
 * from its last step, or skip it.
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
  if (user.onboardedAt) redirect("/");
  const owner = await getOwner();
  // A cloud session starts without the user's own agent only on a model the
  // menu offers: Outrunner's, where this server has them, or a key of theirs.
  const outrunnerModels = owner ? await modelMenu(owner.id).then(offersModels) : false;

  return (
    <OnboardingLive
      user={{ name: user.name, login: user.login, avatarUrl: user.avatarUrl }}
      outrunnerModels={outrunnerModels}
    />
  );
}
