"use client";

import { useMemo, useState } from "react";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { liveEnv } from "@/lib/onboarding/live-env";

/** Complete production onboarding flow; captures only the final navigation. */
export function GitLabOnboardingFixture() {
  const env = useMemo(() => liveEnv({ id: "gitlab-onboarding-user", name: "Ada", login: "", avatarUrl: null }, { outrunnerModels: true }), []);
  const [destination, setDestination] = useState<string | null>(null);
  return destination ? <main className="p-6"><h1>Onboarding complete</h1><p role="status">{destination}</p></main> : <OnboardingFlow env={env} onLeave={setDestination} />;
}
