"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { GitLabFixture } from "../../gitlab-fixture";
import { GitLabOnboardingFixture } from "../../gitlab-onboarding-fixture";

function Fixture() {
  const params = useSearchParams();
  if (params.get("view") === "onboarding") return <GitLabOnboardingFixture />;
  return <GitLabFixture connected={params.get("state") === "connected"} />;
}

export default function Page() {
  return <Suspense><Fixture /></Suspense>;
}
