import { Suspense } from "react";

import { RequireOwner } from "@/components/require-owner";
import { SessionsList } from "@/components/sessions-list";

/** Every session in the org the user may see: search, filter, tidy up. */
export default function WorkspacesPage() {
  return (
    <>
      <SessionsList />
      <Suspense fallback={null}>
        <RequireOwner />
      </Suspense>
    </>
  );
}
