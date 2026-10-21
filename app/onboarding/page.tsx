import { redirect } from "next/navigation";

import { OnboardingLive } from "@/components/onboarding/onboarding-live";
import { OnboardingPreview } from "@/components/onboarding/onboarding-preview";
import { getOwner } from "@/lib/auth/owner";
import { billingMode } from "@/lib/billing/mode";
import { listedPricesUsd } from "@/lib/billing/stripe-deps";
import { modelMenu, offersModels } from "@/lib/db/credentials";
import { getOnboardingUser } from "@/lib/onboarding/server";

/**
 * First-run onboarding: the projects on this Mac to bring over, then the
 * plans (components/onboarding/onboarding-flow.tsx). Home sends a new user
 * here (see app/(app)/page.tsx); it is done once they leave its last step, or
 * when they skip it.
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
  const [outrunnerModels, prices] = await Promise.all([
    // A cloud session starts without the user's Claude only on a model the
    // menu offers: Outrunner's, where this server has them, or on a key of
    // the user's own.
    owner ? modelMenu(owner.id).then(offersModels) : false,
    // Plans are offered where they're sold; without Stripe's prices the step
    // still lets the user go on free.
    billingMode() === "stripe"
      ? listedPricesUsd().catch((error: unknown) => {
          console.error("Could not read prices from Stripe", error);
          return null;
        })
      : null,
  ]);

  return (
    <OnboardingLive
      user={{ name: user.name, login: user.login, avatarUrl: user.avatarUrl }}
      outrunnerModels={outrunnerModels}
      prices={prices}
    />
  );
}
