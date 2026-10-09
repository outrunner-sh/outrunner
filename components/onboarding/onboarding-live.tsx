"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { liveEnv } from "@/lib/onboarding/live-env";
import type { OnboardingUser } from "@/lib/onboarding/types";

/** Onboarding for the signed-in user, on real checks and APIs. */
export function OnboardingLive({ user }: { user: OnboardingUser }) {
  const router = useRouter();
  const env = useMemo(() => liveEnv(user), [user]);
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
