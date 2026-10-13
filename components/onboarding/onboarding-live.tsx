"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { liveEnv } from "@/lib/onboarding/live-env";
import type { OnboardingUser } from "@/lib/onboarding/types";

/** Onboarding for the signed-in user, on real checks and APIs. */
export function OnboardingLive({ user, neevForCloud }: { user: OnboardingUser; neevForCloud: boolean }) {
  const router = useRouter();
  const env = useMemo(() => liveEnv(user, { neevForCloud }), [user, neevForCloud]);
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
