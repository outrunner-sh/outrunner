"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { DesktopSignIn } from "@/components/desktop-signin";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { liveEnv } from "@/lib/onboarding/live-env";
import type { OnboardingUser } from "@/lib/onboarding/types";

/** The onboarding flow on the live app's APIs. */
export function OnboardingLive({ user, outrunnerModels, desktopReturn = false }: { user: OnboardingUser; outrunnerModels: boolean; desktopReturn?: boolean }) {
  const router = useRouter();
  const env = useMemo(() => liveEnv(user, { outrunnerModels }), [user, outrunnerModels]);
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
