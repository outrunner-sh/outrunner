"use client";

import * as Sentry from "@sentry/nextjs";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";

import { HOME_ACTION, RouteMessage } from "@/components/route-states";
import { ErrorRef } from "@/components/ui/notice";

/** A page that failed to render. The sidebar (the layout) stays, with a reload
 *  and a way home beside it. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
    Sentry.captureException(error, { tags: { where: "route-error", digest: error.digest } });
  }, [error]);
  // reset() alone re-renders with the server's cached result; a server-side
  // failure needs the page fetched again.
  const reload = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <RouteMessage
      title="Something went wrong on this page"
      detail="Reloading usually fixes it. The rest of Outrunner still works."
      actions={[{ label: "Reload", primary: true, onClick: reload }, HOME_ACTION]}
      // The digest names the server's log line for this failure.
      footer={error.digest ? <p className="route-state-detail"><ErrorRef value={error.digest} /></p> : null}
    />
  );
}
