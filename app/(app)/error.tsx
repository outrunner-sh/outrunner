"use client";

import { useEffect } from "react";

import { HomeLink, RouteMessage } from "@/components/route-states";

/** A page that failed to render. The sidebar (the layout) stays, with a retry
 *  and a way home beside it. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <RouteMessage
      title="Something went wrong"
      detail="This page could not be loaded. Trying again usually works."
      action={
        <>
          <button type="button" onClick={reset} className="route-state-button is-primary">
            Try again
          </button>
          <HomeLink />
        </>
      }
    />
  );
}
