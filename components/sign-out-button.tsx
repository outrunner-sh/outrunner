"use client";

import { useFormStatus } from "react-dom";

import { LoadingButton } from "@/components/ui/loading-button";
import { clearAppDataCache } from "@/lib/session/app-data-cache";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";

/** Submits the sign-out form it sits in, its icon turning until the redirect
 *  lands. The conversations and the sidebar's list this browser kept go with
 *  the user. */
export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      onClick={() => {
        CONVERSATIONS.clear();
        clearAppDataCache();
      }}
      variant="outline"
      status={pending ? "pending" : "idle"}
      labels={{ idle: "Sign out" }}
    />
  );
}
