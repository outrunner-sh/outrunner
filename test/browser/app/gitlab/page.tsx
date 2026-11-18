"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { GitLabFixture } from "../../gitlab-fixture";

function Fixture() {
  const params = useSearchParams();
  return <GitLabFixture connected={params.get("state") === "connected"} />;
}

export default function Page() {
  return <Suspense><Fixture /></Suspense>;
}
