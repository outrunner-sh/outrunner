"use client";

import { useMemo, useState } from "react";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { liveEnv } from "@/lib/onboarding/live-env";

/** The complete production setup flow for an org, Acme; captures only the
 *  final navigation. */
export function SetupFlowFixture() {
  const env = useMemo(
    () => liveEnv({ id: "setup-user", name: "Ada", login: "", avatarUrl: null }, { id: "org-1", name: "Acme", personal: false }, { outrunnerModels: true }),
    [],
  );
  const [destination, setDestination] = useState<string | null>(null);
  return destination ? (
    <main className="p-6">
      <h1>Setup complete</h1>
      <p role="status">{destination}</p>
    </main>
  ) : (
    <OnboardingFlow env={env} onLeave={setDestination} />
  );
}
