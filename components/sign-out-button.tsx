"use client";

import { useFormStatus } from "react-dom";

import { LoadingButton } from "@/components/ui/loading-button";
import { clearKeptPages } from "@/lib/client/kept-page";
import { clearMissions } from "@/lib/missions/kept-missions";
import { clearAppDataCache } from "@/lib/session/app-data-cache";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";
import { closeKeptStreams } from "@/lib/session/kept-streams";
import { clearKeptTriage } from "@/lib/triage/kept-triage";

/** Submits the sign-out form it sits in, its icon turning until the redirect
 *  lands. The conversations and the lists this browser kept go with the
 *  user. */
export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      onClick={() => {
        closeKeptStreams();
        CONVERSATIONS.clear();
        clearAppDataCache();
        clearMissions();
        clearKeptTriage();
        clearKeptPages();
      }}
      variant="outline"
      status={pending ? "pending" : "idle"}
      labels={{ idle: "Sign out" }}
    />
  );
}
