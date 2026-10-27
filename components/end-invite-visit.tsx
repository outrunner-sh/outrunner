"use client";

import { useEffect } from "react";

/** On an invite's page that no longer works: sign out whoever it signed in
 *  who isn't let in otherwise (app/api/invites/leave). Shows nothing. */
export function EndInviteVisit() {
  useEffect(() => {
    void fetch("/api/invites/leave", { method: "POST" }).catch(() => {});
  }, []);
  return null;
}
