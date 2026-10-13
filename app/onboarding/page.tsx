import { redirect } from "next/navigation";

import { OnboardingLive } from "@/components/onboarding/onboarding-live";
import { OnboardingPreview } from "@/components/onboarding/onboarding-preview";
import { getOnboardingUser } from "@/lib/onboarding/server";
import { keySource } from "@/lib/openrouter/keys";

export const dynamic = "force-dynamic";

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

  return (
    <OnboardingLive
      user={{ name: user.name, login: user.login, avatarUrl: user.avatarUrl }}
      // A cloud session starts without the user's Claude only on Outrunner's
      // models, which need an OpenRouter key on this server.
      neevForCloud={keySource() !== null}
    />
  );
}
