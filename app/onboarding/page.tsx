import { redirect } from "next/navigation";

import { OnboardingLive } from "@/components/onboarding/onboarding-live";
import { OnboardingPreview } from "@/components/onboarding/onboarding-preview";
import { getOwner } from "@/lib/auth/owner";
import { modelMenu, offersModels } from "@/lib/db/credentials";
import { getOnboardingUser } from "@/lib/onboarding/server";

/**
 * First-run onboarding: where sessions run, a live setup checklist for that
 * choice, and the first prompt. Home sends a new user here (see
 * app/(app)/page.tsx); it is done once their first session starts, or when
 * they skip it.
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

  return (
    <OnboardingLive
      user={{ name: user.name, login: user.login, avatarUrl: user.avatarUrl }}
      // A cloud session starts without the user's Claude only on a model the
      // menu offers: Outrunner's, where this server has them, or on a key of
      // the user's own.
      outrunnerModels={owner ? offersModels(await modelMenu(owner.id)) : false}
    />
  );
}
