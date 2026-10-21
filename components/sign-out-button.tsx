"use client";

import { useFormStatus } from "react-dom";

import { LoadingButton } from "@/components/ui/loading-button";

/** Submits the sign-out form it sits in, its icon turning until the redirect
 *  lands. */
export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      variant="outline"
      status={pending ? "pending" : "idle"}
      labels={{ idle: "Sign out" }}
    />
  );
}
