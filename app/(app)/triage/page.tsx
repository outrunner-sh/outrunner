import { Suspense } from "react";

import { RequireOwner } from "@/components/require-owner";
import { RouteLoading } from "@/components/route-states";
import { TriageView } from "@/components/triage/triage-view";

/** Triage: work items captured in the app, from Slack and from the CLI. */
export default function TriagePage() {
  return (
    <>
      <Suspense fallback={<RouteLoading label="Loading triage" />}>
        <TriageView />
      </Suspense>
      <Suspense fallback={null}>
        <RequireOwner />
      </Suspense>
    </>
  );
}
