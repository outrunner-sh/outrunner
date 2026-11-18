"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { DesktopSignIn } from "@/components/desktop-signin";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { liveEnv } from "@/lib/onboarding/live-env";
import type { OnboardingOrg, OnboardingUser } from "@/lib/onboarding/types";

/** The org's setup on the live app's APIs. */
export function OnboardingLive({
  user,
  org,
  outrunnerModels,
  desktopReturn = false,
}: {
  user: OnboardingUser;
  org: OnboardingOrg;
  outrunnerModels: boolean;
  desktopReturn?: boolean;
}) {
  const router = useRouter();
  const env = useMemo(() => liveEnv(user, org, { outrunnerModels }), [user, org, outrunnerModels]);
  return (
    <DesktopSignIn next="/">
      <OnboardingFlow
        env={env}
        onLeave={(href) => {
          router.push(desktopReturn ? `/auth/desktop/ready?next=${encodeURIComponent(href)}` : href);
          router.refresh();
        }}
      />
    </DesktopSignIn>
  );
}
