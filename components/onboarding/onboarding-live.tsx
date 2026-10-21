"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { liveEnv } from "@/lib/onboarding/live-env";
import type { OnboardingUser } from "@/lib/onboarding/types";

/** Onboarding for the signed-in user, on real checks and APIs. */
export function OnboardingLive({
  user,
  outrunnerModels,
  prices,
}: {
  user: OnboardingUser;
  outrunnerModels: boolean;
  prices: Record<string, number> | null;
}) {
  const router = useRouter();
  const env = useMemo(() => liveEnv(user, { outrunnerModels, prices }), [user, outrunnerModels, prices]);
  return (
    <OnboardingFlow
      env={env}
      onLeave={(href) => {
        router.push(href);
        router.refresh();
      }}
    />
  );
}
