"use client";

import { useFormStatus } from "react-dom";

import { LoadingButton } from "@/components/ui/loading-button";
import { clearMissions } from "@/lib/missions/kept-missions";
import { clearAppDataCache } from "@/lib/session/app-data-cache";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";
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
        CONVERSATIONS.clear();
        clearAppDataCache();
        clearMissions();
        clearKeptTriage();
      }}
      variant="outline"
      status={pending ? "pending" : "idle"}
      labels={{ idle: "Sign out" }}
    />
  );
}
