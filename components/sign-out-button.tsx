"use client";

import { useFormStatus } from "react-dom";

import { LoadingButton } from "@/components/ui/loading-button";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";

/** Submits the sign-out form it sits in, saying "Signing out" until the
 *  redirect lands. The conversations this browser kept go with the user. */
export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      onClick={() => CONVERSATIONS.clear()}
      variant="outline"
      status={pending ? "pending" : "idle"}
      labels={{ idle: "Sign out", pending: "Signing out" }}
    />
  );
}
